// Phone sign-in: the app asks for an SMS code, swaps it for a session token, and sends that
// token with every request. Only a hash of the token is stored, so a database leak can't be used to sign in.
import { audit, isSandbox, notify, one, q } from "./db";
import { AppError, clientIp } from "./http";
import { rateLimit, randomToken, safeEqual, sendSms, sha256, sixDigits } from "./security";
import { env } from "./db";

const SESSION_DAYS = 30;
const LOGIN_CODE_MINUTES = 5;
const LOGIN_MAX_ATTEMPTS = 3;

export type Profile = {
  id: string; first_name: string; last_name: string; phone: string | null; tag: string | null; tier: number;
  kyc_status: string; frozen: boolean; daily_limit_kobo: number | null; otp_large: boolean; is_admin: boolean; pidgin: boolean; dob: string | null;
};
export type Ctx = { userId: string; phone: string; profile: Profile; sessionId: string; deviceId: string; ip: string; req: Request };

/** 0803 123 4567 / +2348031234567 / 2348031234567 → 2348031234567 */
export function normalizePhone(input: unknown): string {
  const d = String(input ?? "").replace(/\D/g, "");
  const n = d.startsWith("234") ? d : d.startsWith("0") ? "234" + d.slice(1) : "234" + d;
  if (!/^234[789][01]\d{8}$/.test(n)) throw new AppError("bad_phone", "Enter a valid Nigerian phone number, like 0803 123 4567.");
  return n;
}

const loginHash = (phone: string, code: string) => sha256(`login:${phone}:${code}:${env("PIN_PEPPER")}`);
const adminPhones = () => (process.env.ADMIN_PHONES ?? "").split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean);

export async function startLogin(phoneInput: unknown, req: Request) {
  const phone = normalizePhone(phoneInput);
  const ip = clientIp(req);
  await rateLimit(`ip:${ip}`, "login_start", 20, 600);
  await rateLimit(`phone:${phone}`, "login_start", 5, 600);
  const code = sixDigits();
  await q(`insert into login_codes (phone, code_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`, [phone, loginHash(phone, code), LOGIN_CODE_MINUTES]);
  await sendSms(phone, `${code} is your Kolo sign-in code. It expires in ${LOGIN_CODE_MINUTES} minutes. Never share it with anyone.`);
  return { sent: true, phone, dev_code: isSandbox() ? code : undefined };
}

export async function verifyLogin(b: Record<string, unknown>, req: Request) {
  const phone = normalizePhone(b.phone);
  const code = String(b.code ?? "");
  const deviceId = String(b.device_id ?? "").slice(0, 64);
  const deviceName = String(b.device_name ?? "Unknown device").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 60) || "Unknown device";
  const ip = clientIp(req);
  if (!/^\d{6}$/.test(code)) throw new AppError("bad_code", "Enter the 6-digit code we sent you.");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) throw new AppError("bad_device", "Update the app and try again.");
  await rateLimit(`ip:${ip}`, "login_verify", 30, 600);

  const c = await one(`select * from login_codes where phone = $1 and consumed_at is null order by created_at desc limit 1`, [phone]);
  if (!c || new Date(c.expires_at) < new Date()) throw new AppError("code_expired", "That code has expired. Request a new one.", 401);
  if (c.attempts >= LOGIN_MAX_ATTEMPTS) throw new AppError("code_locked", "Too many wrong codes. Request a new one.", 401);
  if (!safeEqual(loginHash(phone, code), c.code_hash)) {
    await q("update login_codes set attempts = attempts + 1 where id = $1", [c.id]);
    const left = LOGIN_MAX_ATTEMPTS - c.attempts - 1;
    throw new AppError("code_wrong", left > 0 ? `That code is wrong. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is wrong. Request a new one.", 401);
  }
  const used = await q("update login_codes set consumed_at = now() where id = $1 and consumed_at is null returning id", [c.id]);
  if (!used.length) throw new AppError("code_expired", "That code was already used. Request a new one.", 401);

  const u = await one<{ id: string }>("select ensure_user($1) as id", [phone]);
  const userId = u!.id;
  if (adminPhones().includes(phone)) await q("update profiles set is_admin = true where id = $1 and not is_admin", [userId]);

  const known = await one("select 1 as k from sessions where user_id = $1 and device_id = $2 limit 1", [userId, deviceId]);
  const hadOthers = await one("select 1 as k from sessions where user_id = $1 limit 1", [userId]);
  const token = randomToken();
  await q(
    `insert into sessions (user_id, token_hash, device_id, device_name, ip, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [userId, sha256(token), deviceId, deviceName, ip, SESSION_DAYS],
  );
  if (hadOthers && !known) {
    await notify(userId, "New device signed in", `${deviceName} just signed in to your Kolo account. If this wasn't you, freeze your account now.`, "security");
  }
  await audit(userId, "auth.login", { deviceName, newDevice: !known }, ip);
  return { token };
}

const PROFILE_COLS = "p.id, p.first_name, p.last_name, p.phone, p.tag, p.tier, p.kyc_status, p.frozen, p.daily_limit_kobo, p.otp_large, p.is_admin, p.pidgin, p.dob";

export async function requireSession(req: Request): Promise<Ctx> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token.length < 20) throw new AppError("unauthorized", "Please sign in again.", 401);
  const row = await one(
    `select s.id as session_id, s.device_id, s.last_seen, u.phone as user_phone, ${PROFILE_COLS}
       from sessions s join users u on u.id = s.user_id join profiles p on p.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row) throw new AppError("unauthorized", "Your session has ended. Please sign in again.", 401);
  if (Date.now() - new Date(row.last_seen).getTime() > 5 * 60_000) {
    await q("update sessions set last_seen = now() where id = $1", [row.session_id]);
  }
  const { session_id, device_id, user_phone, last_seen: _ls, ...profile } = row;
  if (adminPhones().includes(user_phone)) profile.is_admin = true;
  return { userId: profile.id, phone: user_phone, profile: profile as Profile, sessionId: session_id, deviceId: device_id, ip: clientIp(req), req };
}

export async function logout(c: Ctx) {
  await q("update sessions set revoked_at = now() where id = $1", [c.sessionId]);
  return { ok: true };
}

export async function listDevices(c: Ctx) {
  const rows = await q(
    `select id, device_name as name, last_seen, created_at, device_id from sessions
      where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen desc`,
    [c.userId],
  );
  return { devices: rows.map(({ device_id, ...d }) => ({ ...d, current: d.id === c.sessionId })) };
}

export async function revokeDevice(c: Ctx, id: string) {
  if (id === c.sessionId) throw new AppError("current_device", "To sign out of this phone, use Sign out instead.");
  const r = await q("update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning device_name", [id, c.userId]);
  if (!r.length) throw new AppError("not_found", "That device is already signed out.", 404);
  await audit(c.userId, "device.revoked", { name: r[0].device_name }, c.ip);
  await notify(c.userId, "Device signed out", `${r[0].device_name} was signed out of your account.`, "security");
  return { ok: true };
}
