// PIN hashing, one-time codes and SMS. The PIN is never stored or logged in plain text.
import { admin, audit, env, isSandbox, notify, Profile } from "./db.ts";
import { AppError } from "./http.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

export async function sha256(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

// PBKDF2-SHA256 with a per-user salt plus a server-side pepper (PIN_PEPPER secret).
const PIN_ITERATIONS = 310_000;
async function pbkdf2(pin: string, saltHex: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin + env("PIN_PEPPER")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, key, 256);
  return hex(bits);
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const WEAK_PINS = new Set(["1234", "4321", "0123", "1212", "2580", "1122", "6969", "1004", "2000", "2001", "2002", "2003", "2004", "2005"]);
export function assertStrongPin(pin: string, profile?: Pick<Profile, "phone">) {
  if (!/^\d{4}$/.test(pin)) throw new AppError("bad_pin", "Your PIN must be exactly 4 digits.");
  if (/^(\d)\1{3}$/.test(pin) || WEAK_PINS.has(pin) || /^19\d\d$|^20[0-2]\d$/.test(pin)) {
    throw new AppError("weak_pin", "That PIN is too easy to guess. Avoid repeated digits, 1234 and birth years.");
  }
  if (profile?.phone && profile.phone.replace(/\D/g, "").endsWith(pin)) throw new AppError("weak_pin", "Don't use the last digits of your phone number as your PIN.");
}

export async function hasPin(userId: string) {
  const { data } = await admin.from("security_secrets").select("pin_hash").eq("user_id", userId).single();
  return !!data?.pin_hash;
}

export async function setPin(userId: string, pin: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(pin, salt, PIN_ITERATIONS);
  await admin.from("security_secrets").upsert({
    user_id: userId, pin_hash: hash, pin_salt: salt, pin_iterations: PIN_ITERATIONS,
    pin_fails: 0, pin_locked_until: null, pin_set_at: new Date().toISOString(),
  });
}

const MAX_PIN_FAILS = 5;
const PIN_LOCK_MINUTES = 30;
export async function verifyPin(userId: string, pin: unknown, req?: Request) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw new AppError("pin_required", "Enter your 4-digit PIN.");
  const { data: s } = await admin.from("security_secrets").select("*").eq("user_id", userId).single();
  if (!s?.pin_hash) throw new AppError("pin_not_set", "Set up your transaction PIN first.");
  if (s.pin_locked_until && new Date(s.pin_locked_until) > new Date()) {
    const mins = Math.ceil((new Date(s.pin_locked_until).getTime() - Date.now()) / 60000);
    throw new AppError("pin_locked", `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 423);
  }
  const ok = safeEqual(await pbkdf2(pin, s.pin_salt, s.pin_iterations), s.pin_hash);
  if (ok) {
    if (s.pin_fails) await admin.from("security_secrets").update({ pin_fails: 0 }).eq("user_id", userId);
    return;
  }
  const fails = s.pin_fails + 1;
  if (fails >= MAX_PIN_FAILS) {
    await admin.from("security_secrets").update({ pin_fails: 0, pin_locked_until: new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() }).eq("user_id", userId);
    await audit(userId, "pin.locked", {}, req);
    await notify(userId, "PIN locked", `Someone entered the wrong PIN ${MAX_PIN_FAILS} times. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes. If this wasn't you, freeze your account.`, "security");
    throw new AppError("pin_locked", `Too many wrong attempts. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes.`, 423);
  }
  await admin.from("security_secrets").update({ pin_fails: fails }).eq("user_id", userId);
  throw new AppError("wrong_pin", `Wrong PIN. ${MAX_PIN_FAILS - fails} ${MAX_PIN_FAILS - fails === 1 ? "try" : "tries"} left.`, 401, { tries_left: MAX_PIN_FAILS - fails });
}

// ───────────────────────── one-time codes ─────────────────────────
export type OtpPurpose = "transfer" | "pin_change" | "unfreeze" | "limit_raise" | "otp_off";
const OTP_TTL_MIN = 5, OTP_MAX_ATTEMPTS = 3;

export async function createOtp(userId: string, phone: string | null, purpose: OtpPurpose, what: string) {
  if (!phone) throw new AppError("no_phone", "Add a phone number to receive codes.");
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const { data, error } = await admin.from("otp_codes").insert({
    user_id: userId, purpose, code_hash: await sha256(`${userId}:${purpose}:${code}:${env("PIN_PEPPER")}`),
    expires_at: new Date(Date.now() + OTP_TTL_MIN * 60000).toISOString(),
  }).select("id").single();
  if (error) throw error;
  await sendSms(phone, `${code} is your Kolo code to ${what}. It expires in ${OTP_TTL_MIN} minutes. Never share it with anyone, not even Kolo staff.`);
  return { otp_id: data.id as string, dev_code: isSandbox() ? code : undefined };
}

export async function verifyOtp(userId: string, purpose: OtpPurpose, otpId: unknown, code: unknown) {
  if (typeof otpId !== "string" || typeof code !== "string") throw new AppError("otp_required", "Enter the 6-digit code we sent you.", 401, { otp_required: true });
  const { data: o } = await admin.from("otp_codes").select("*").eq("id", otpId).eq("user_id", userId).eq("purpose", purpose).maybeSingle();
  if (!o || o.consumed_at) throw new AppError("otp_invalid", "That code is no longer valid. Request a new one.", 401, { otp_required: true });
  if (new Date(o.expires_at) < new Date()) throw new AppError("otp_expired", "That code has expired. Request a new one.", 401, { otp_required: true });
  if (o.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("otp_locked", "Too many wrong codes. Request a new one.", 401, { otp_required: true });
  const ok = safeEqual(await sha256(`${userId}:${purpose}:${code}:${env("PIN_PEPPER")}`), o.code_hash);
  if (!ok) {
    await admin.from("otp_codes").update({ attempts: o.attempts + 1 }).eq("id", o.id);
    throw new AppError("otp_wrong", `That code is wrong. ${OTP_MAX_ATTEMPTS - o.attempts - 1} tries left.`, 401, { otp_required: true });
  }
  // single use: only one request can consume it
  const { data: used } = await admin.from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", o.id).is("consumed_at", null).select("id");
  if (!used?.length) throw new AppError("otp_invalid", "That code was already used.", 401, { otp_required: true });
}

// ───────────────────────── SMS ─────────────────────────
// SMS_PROVIDER=termii sends real texts via Termii (popular in Nigeria). Anything else just logs.
// Check Termii's current docs for the endpoint and sender-ID rules before going live.
async function sendSms(to: string, text: string) {
  const provider = Deno.env.get("SMS_PROVIDER") ?? "log";
  const intl = to.replace(/\D/g, "").replace(/^0/, "234");
  if (provider === "termii") {
    const res = await fetch(env("TERMII_BASE_URL", "https://api.ng.termii.com") + "/api/sms/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env("TERMII_API_KEY"), to: intl, from: env("TERMII_SENDER_ID", "Kolo"), sms: text, type: "plain", channel: "dnd" }),
    });
    if (!res.ok) { console.error("sms failed", res.status, await res.text()); throw new AppError("sms_failed", "We couldn't send your code. Try again shortly.", 502); }
    return;
  }
  console.log(`[sms:${provider}] to ${intl.slice(0, 6)}****: ${text.replace(/\d{6}/, "******")}`);
}
