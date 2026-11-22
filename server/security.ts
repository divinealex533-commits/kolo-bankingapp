// PIN hashing, one-time codes, rate limits and SMS. PINs and codes are never stored or logged in plain text.
import { createHash, createHmac, pbkdf2, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { audit, env, isSandbox, notify, one, q } from "./db";
import { AppError } from "./http";

const pbkdf2Async = promisify(pbkdf2);

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const hmacSha256 = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const pepper = () => env("PIN_PEPPER");

// ───────────────────────── rate limits ─────────────────────────
export async function rateLimit(key: string, action: string, max: number, windowSeconds: number) {
  const r = await one<{ ok: boolean }>("select rate_hit($1, $2, $3, $4) as ok", [key, action, max, windowSeconds]);
  if (!r?.ok) throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.", 429);
}

// ───────────────────────── PIN ─────────────────────────
// PBKDF2-SHA256 with a per-user salt plus a server-side pepper (PIN_PEPPER).
const PIN_ITERATIONS = 310_000;
const hashPin = async (pin: string, salt: string, iterations: number) =>
  (await pbkdf2Async(pin + pepper(), Buffer.from(salt, "hex"), iterations, 32, "sha256")).toString("hex");

const WEAK_PINS = new Set(["1234", "4321", "0123", "1212", "2580", "1122", "6969", "1004", "0007"]);
export function assertStrongPin(pin: string, phone?: string | null) {
  if (!/^\d{4}$/.test(pin)) throw new AppError("bad_pin", "Your PIN must be exactly 4 digits.");
  if (/^(\d)\1{3}$/.test(pin) || WEAK_PINS.has(pin) || /^19\d\d$|^20[0-2]\d$/.test(pin)) {
    throw new AppError("weak_pin", "That PIN is too easy to guess. Avoid repeated digits, 1234 and birth years.");
  }
  if (phone && phone.endsWith(pin)) throw new AppError("weak_pin", "Don't use the last digits of your phone number as your PIN.");
}

export async function hasPin(userId: string) {
  const r = await one("select pin_hash from security_secrets where user_id = $1", [userId]);
  return !!r?.pin_hash;
}

export async function setPin(userId: string, pin: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await hashPin(pin, salt, PIN_ITERATIONS);
  await q(
    `insert into security_secrets (user_id, pin_hash, pin_salt, pin_iterations, pin_fails, pin_locked_until, pin_set_at)
     values ($1, $2, $3, $4, 0, null, now())
     on conflict (user_id) do update set pin_hash = excluded.pin_hash, pin_salt = excluded.pin_salt,
       pin_iterations = excluded.pin_iterations, pin_fails = 0, pin_locked_until = null, pin_set_at = now()`,
    [userId, hash, salt, PIN_ITERATIONS],
  );
}

const MAX_PIN_FAILS = 5;
const PIN_LOCK_MINUTES = 30;
export async function verifyPin(userId: string, pin: unknown, ip: string | null = null) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw new AppError("pin_required", "Enter your 4-digit PIN.");
  const s = await one("select * from security_secrets where user_id = $1", [userId]);
  if (!s?.pin_hash) throw new AppError("pin_not_set", "Set up your transaction PIN first.");
  if (s.pin_locked_until && new Date(s.pin_locked_until) > new Date()) {
    const mins = Math.ceil((new Date(s.pin_locked_until).getTime() - Date.now()) / 60000);
    throw new AppError("pin_locked", `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 423);
  }
  if (safeEqual(await hashPin(pin, s.pin_salt, s.pin_iterations), s.pin_hash)) {
    if (s.pin_fails) await q("update security_secrets set pin_fails = 0 where user_id = $1", [userId]);
    return;
  }
  const r = await one<{ pin_fails: number }>("update security_secrets set pin_fails = pin_fails + 1 where user_id = $1 returning pin_fails", [userId]);
  const fails = r?.pin_fails ?? MAX_PIN_FAILS;
  if (fails >= MAX_PIN_FAILS) {
    await q(`update security_secrets set pin_fails = 0, pin_locked_until = now() + make_interval(mins => $2) where user_id = $1`, [userId, PIN_LOCK_MINUTES]);
    await audit(userId, "pin.locked", {}, ip);
    await notify(userId, "PIN locked", `Someone entered the wrong PIN ${MAX_PIN_FAILS} times. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes. If this wasn't you, freeze your account.`, "security");
    throw new AppError("pin_locked", `Too many wrong attempts. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes.`, 423);
  }
  const left = MAX_PIN_FAILS - fails;
  throw new AppError("wrong_pin", `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`, 401, { tries_left: left });
}

// ───────────────────────── one-time codes ─────────────────────────
export type OtpPurpose = "transfer" | "pin_change" | "unfreeze" | "limit_raise" | "otp_off";
const OTP_TTL_MIN = 5, OTP_MAX_ATTEMPTS = 3;
const otpHash = (userId: string, purpose: string, code: string) => sha256(`${userId}:${purpose}:${code}:${pepper()}`);
export const sixDigits = () => String(randomInt(100000, 1000000));

export async function createOtp(userId: string, phone: string | null, purpose: OtpPurpose, what: string) {
  if (!phone) throw new AppError("no_phone", "Add a phone number to receive codes.");
  const code = sixDigits();
  const row = await one<{ id: string }>(
    `insert into otp_codes (user_id, purpose, code_hash, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4)) returning id`,
    [userId, purpose, otpHash(userId, purpose, code), OTP_TTL_MIN],
  );
  await sendSms(phone, `${code} is your Kolo code to ${what}. It expires in ${OTP_TTL_MIN} minutes. Never share it with anyone, not even Kolo staff.`);
  return { otp_id: row!.id, dev_code: isSandbox() ? code : undefined };
}

export async function verifyOtp(userId: string, purpose: OtpPurpose, otpId: unknown, code: unknown) {
  if (typeof otpId !== "string" || typeof code !== "string" || !/^[0-9a-f-]{36}$/.test(otpId)) {
    throw new AppError("otp_required", "Enter the 6-digit code we sent you.", 401, { otp_required: true });
  }
  const o = await one("select * from otp_codes where id = $1 and user_id = $2 and purpose = $3", [otpId, userId, purpose]);
  if (!o || o.consumed_at) throw new AppError("otp_invalid", "That code is no longer valid. Request a new one.", 401, { otp_required: true });
  if (new Date(o.expires_at) < new Date()) throw new AppError("otp_expired", "That code has expired. Request a new one.", 401, { otp_required: true });
  if (o.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("otp_locked", "Too many wrong codes. Request a new one.", 401, { otp_required: true });
  if (!safeEqual(otpHash(userId, purpose, code), o.code_hash)) {
    await q("update otp_codes set attempts = attempts + 1 where id = $1", [o.id]);
    const left = OTP_MAX_ATTEMPTS - o.attempts - 1;
    throw new AppError("otp_wrong", `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.`, 401, { otp_required: true });
  }
  // single use: only one request can consume it
  const used = await q("update otp_codes set consumed_at = now() where id = $1 and consumed_at is null returning id", [o.id]);
  if (!used.length) throw new AppError("otp_invalid", "That code was already used.", 401, { otp_required: true });
}

// ───────────────────────── SMS ─────────────────────────
// SMS_PROVIDER=termii sends real texts via Termii (popular in Nigeria). Anything else only logs (codes masked).
// Check Termii's current docs for the endpoint and sender-ID rules before going live.
export async function sendSms(to: string, text: string) {
  const provider = process.env.SMS_PROVIDER ?? "log";
  const intl = to.replace(/\D/g, "").replace(/^0/, "234");
  if (provider === "termii") {
    const res = await fetch(env("TERMII_BASE_URL", "https://api.ng.termii.com") + "/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env("TERMII_API_KEY"), to: intl, from: env("TERMII_SENDER_ID", "Kolo"), sms: text, type: "plain", channel: "dnd" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error("sms failed", res.status, (await res.text()).slice(0, 300));
      throw new AppError("sms_failed", "We couldn't send your code. Try again shortly.", 502);
    }
    return;
  }
  console.log(`[sms:${provider}] to ${intl.slice(0, 6)}****: ${text.replace(/\d{6}/, "******")}`);
}
