// supabase/functions/_shared/http.ts
var cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-device-name, x-idempotency-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};
var AppError = class extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
  code;
  status;
  extra;
};
function json(body2, status = 200) {
  return new Response(JSON.stringify(body2), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
var DB_ERRORS = {
  insufficient_funds: [400, "You don't have enough money for this. Your balance didn't change."],
  account_frozen: [403, "Your account is frozen. Unfreeze it in Security to send money."],
  no_account: [400, "Finish setting up your account first."],
  recipient_unavailable: [400, "That Kolo account can't receive money right now."],
  same_account: [400, "You can't send money to yourself."],
  invalid_amount: [400, "Enter an amount greater than zero."],
  account_not_found: [404, "Account not found."]
};
function handler(fn) {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
      const msg = String(e?.message ?? e);
      for (const [code, [status, message]] of Object.entries(DB_ERRORS)) {
        if (msg.includes(code)) return json({ error: { code, message } }, status);
      }
      console.error("unhandled", e);
      return json({ error: { code: "server_error", message: "Something went wrong on our side. No money moved. Try again." } }, 500);
    }
  };
}
async function body(req) {
  try {
    return await req.json();
  } catch {
    throw new AppError("bad_request", "The request body must be JSON.");
  }
}
var clientIp = (req) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

// supabase/functions/_shared/db.ts
import { createClient } from "npm:@supabase/supabase-js@2";
var env = (k, fallback) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === void 0) throw new Error(`Missing environment variable ${k}`);
  return v;
};
var isSandbox = () => (Deno.env.get("KOLO_ENV") ?? "sandbox") === "sandbox";
var admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false }
});
async function requireUser(req) {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("unauthorized", "Please sign in again.", 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new AppError("unauthorized", "Your session has expired. Please sign in again.", 401);
  const { data: profile, error: pe } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (pe || !profile) throw new AppError("no_profile", "We couldn't find your profile.", 404);
  await touchDevice(data.user.id, req);
  return { user: { id: data.user.id, phone: data.user.phone ?? void 0 }, profile };
}
async function touchDevice(userId, req) {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return;
  const name = (req.headers.get("x-device-name") ?? "Unknown device").slice(0, 60);
  const { data } = await admin.from("devices").select("id").eq("user_id", userId).eq("device_id", deviceId).maybeSingle();
  if (data) {
    await admin.from("devices").update({ last_seen: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", data.id);
    return;
  }
  await admin.from("devices").insert({ user_id: userId, device_id: deviceId, name });
  await notify(userId, "New device signed in", `${name} just signed in to your Kolo account. If this wasn't you, freeze your account now.`, "security");
  await audit(userId, "device.new", { deviceId, name }, req);
}
async function audit(userId, action, meta = {}, req, actor = "user") {
  await admin.from("audit_log").insert({ user_id: userId, action, meta, actor, ip: req ? clientIp(req) : null });
}
async function notify(userId, title, body2, kind = "info") {
  await admin.from("notifications").insert({ user_id: userId, title, body: body2, kind });
}
async function rateLimit(userId, action, max, windowSeconds) {
  const { data, error } = await admin.rpc("rate_hit", { p_user: userId, p_action: action, p_max: max, p_window: `${windowSeconds} seconds` });
  if (error) throw error;
  if (!data) throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.", 429);
}
var naira = (kobo) => "\u20A6" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
var newReference = (prefix = "KL") => prefix + Date.now().toString(36).toUpperCase() + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();
async function checkLimits(profile, totalKobo) {
  if (profile.frozen) throw new AppError("account_frozen", "Your account is frozen. Unfreeze it in Security to send money.", 403);
  if (profile.kyc_status !== "verified" || profile.tier < 1) throw new AppError("kyc_required", "Verify your identity before sending money.", 403);
  const { data: tier } = await admin.from("tiers").select("*").eq("tier", profile.tier).single();
  if (!tier) throw new Error("tier missing");
  if (totalKobo > tier.single_kobo) {
    throw new AppError("over_single_limit", `${tier.name} lets you send up to ${naira(tier.single_kobo)} at once. Upgrade your account to send more.`);
  }
  const daily = Math.min(tier.daily_kobo, profile.daily_limit_kobo ?? Number.MAX_SAFE_INTEGER);
  const { data: spent, error } = await admin.rpc("spent_today", { p_user: profile.id });
  if (error) throw error;
  if (Number(spent) + totalKobo > daily) {
    throw new AppError("over_daily_limit", `This would pass your daily limit of ${naira(daily)}. You've used ${naira(Number(spent))} today.`);
  }
}

// supabase/functions/_shared/security.ts
var enc = new TextEncoder();
var hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
var fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
var PIN_ITERATIONS = 31e4;
async function pbkdf2(pin, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin + env("PIN_PEPPER")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, key, 256);
  return hex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
var WEAK_PINS = /* @__PURE__ */ new Set(["1234", "4321", "0123", "1212", "2580", "1122", "6969", "1004", "2000", "2001", "2002", "2003", "2004", "2005"]);
function assertStrongPin(pin, profile) {
  if (!/^\d{4}$/.test(pin)) throw new AppError("bad_pin", "Your PIN must be exactly 4 digits.");
  if (/^(\d)\1{3}$/.test(pin) || WEAK_PINS.has(pin) || /^19\d\d$|^20[0-2]\d$/.test(pin)) {
    throw new AppError("weak_pin", "That PIN is too easy to guess. Avoid repeated digits, 1234 and birth years.");
  }
  if (profile?.phone && profile.phone.replace(/\D/g, "").endsWith(pin)) throw new AppError("weak_pin", "Don't use the last digits of your phone number as your PIN.");
}
async function hasPin(userId) {
  const { data } = await admin.from("security_secrets").select("pin_hash").eq("user_id", userId).single();
  return !!data?.pin_hash;
}
async function setPin(userId, pin) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(pin, salt, PIN_ITERATIONS);
  await admin.from("security_secrets").upsert({
    user_id: userId,
    pin_hash: hash,
    pin_salt: salt,
    pin_iterations: PIN_ITERATIONS,
    pin_fails: 0,
    pin_locked_until: null,
    pin_set_at: (/* @__PURE__ */ new Date()).toISOString()
  });
}
var MAX_PIN_FAILS = 5;
var PIN_LOCK_MINUTES = 30;
async function verifyPin(userId, pin, req) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw new AppError("pin_required", "Enter your 4-digit PIN.");
  const { data: s } = await admin.from("security_secrets").select("*").eq("user_id", userId).single();
  if (!s?.pin_hash) throw new AppError("pin_not_set", "Set up your transaction PIN first.");
  if (s.pin_locked_until && new Date(s.pin_locked_until) > /* @__PURE__ */ new Date()) {
    const mins = Math.ceil((new Date(s.pin_locked_until).getTime() - Date.now()) / 6e4);
    throw new AppError("pin_locked", `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, 423);
  }
  const ok = safeEqual(await pbkdf2(pin, s.pin_salt, s.pin_iterations), s.pin_hash);
  if (ok) {
    if (s.pin_fails) await admin.from("security_secrets").update({ pin_fails: 0 }).eq("user_id", userId);
    return;
  }
  const fails = s.pin_fails + 1;
  if (fails >= MAX_PIN_FAILS) {
    await admin.from("security_secrets").update({ pin_fails: 0, pin_locked_until: new Date(Date.now() + PIN_LOCK_MINUTES * 6e4).toISOString() }).eq("user_id", userId);
    await audit(userId, "pin.locked", {}, req);
    await notify(userId, "PIN locked", `Someone entered the wrong PIN ${MAX_PIN_FAILS} times. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes. If this wasn't you, freeze your account.`, "security");
    throw new AppError("pin_locked", `Too many wrong attempts. PIN entry is paused for ${PIN_LOCK_MINUTES} minutes.`, 423);
  }
  await admin.from("security_secrets").update({ pin_fails: fails }).eq("user_id", userId);
  throw new AppError("wrong_pin", `Wrong PIN. ${MAX_PIN_FAILS - fails} ${MAX_PIN_FAILS - fails === 1 ? "try" : "tries"} left.`, 401, { tries_left: MAX_PIN_FAILS - fails });
}
var OTP_TTL_MIN = 5;
var OTP_MAX_ATTEMPTS = 3;
async function createOtp(userId, phone, purpose, what) {
  if (!phone) throw new AppError("no_phone", "Add a phone number to receive codes.");
  const code = String(1e5 + crypto.getRandomValues(new Uint32Array(1))[0] % 9e5);
  const { data, error } = await admin.from("otp_codes").insert({
    user_id: userId,
    purpose,
    code_hash: await sha256(`${userId}:${purpose}:${code}:${env("PIN_PEPPER")}`),
    expires_at: new Date(Date.now() + OTP_TTL_MIN * 6e4).toISOString()
  }).select("id").single();
  if (error) throw error;
  await sendSms(phone, `${code} is your Kolo code to ${what}. It expires in ${OTP_TTL_MIN} minutes. Never share it with anyone, not even Kolo staff.`);
  return { otp_id: data.id, dev_code: isSandbox() ? code : void 0 };
}
async function verifyOtp(userId, purpose, otpId, code) {
  if (typeof otpId !== "string" || typeof code !== "string") throw new AppError("otp_required", "Enter the 6-digit code we sent you.", 401, { otp_required: true });
  const { data: o } = await admin.from("otp_codes").select("*").eq("id", otpId).eq("user_id", userId).eq("purpose", purpose).maybeSingle();
  if (!o || o.consumed_at) throw new AppError("otp_invalid", "That code is no longer valid. Request a new one.", 401, { otp_required: true });
  if (new Date(o.expires_at) < /* @__PURE__ */ new Date()) throw new AppError("otp_expired", "That code has expired. Request a new one.", 401, { otp_required: true });
  if (o.attempts >= OTP_MAX_ATTEMPTS) throw new AppError("otp_locked", "Too many wrong codes. Request a new one.", 401, { otp_required: true });
  const ok = safeEqual(await sha256(`${userId}:${purpose}:${code}:${env("PIN_PEPPER")}`), o.code_hash);
  if (!ok) {
    await admin.from("otp_codes").update({ attempts: o.attempts + 1 }).eq("id", o.id);
    throw new AppError("otp_wrong", `That code is wrong. ${OTP_MAX_ATTEMPTS - o.attempts - 1} tries left.`, 401, { otp_required: true });
  }
  const { data: used } = await admin.from("otp_codes").update({ consumed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", o.id).is("consumed_at", null).select("id");
  if (!used?.length) throw new AppError("otp_invalid", "That code was already used.", 401, { otp_required: true });
}
async function sendSms(to, text) {
  const provider = Deno.env.get("SMS_PROVIDER") ?? "log";
  const intl = to.replace(/\D/g, "").replace(/^0/, "234");
  if (provider === "termii") {
    const res = await fetch(env("TERMII_BASE_URL", "https://api.ng.termii.com") + "/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env("TERMII_API_KEY"), to: intl, from: env("TERMII_SENDER_ID", "Kolo"), sms: text, type: "plain", channel: "dnd" })
    });
    if (!res.ok) {
      console.error("sms failed", res.status, await res.text());
      throw new AppError("sms_failed", "We couldn't send your code. Try again shortly.", 502);
    }
    return;
  }
  console.log(`[sms:${provider}] to ${intl.slice(0, 6)}****: ${text.replace(/\d{6}/, "******")}`);
}

// supabase/functions/_shared/bank/mock.ts
var FIRST = ["Chidi", "Amaka", "Tunde", "Ngozi", "Ibrahim", "Fatima", "Emeka", "Yetunde", "Segun", "Aisha", "Obinna", "Funmilayo", "Musa", "Halima"];
var LAST = ["Okafor", "Adeyemi", "Bello", "Eze", "Okonkwo", "Abubakar", "Balogun", "Nwosu", "Ogunleye", "Danjuma", "Lawal", "Yusuf"];
var BANKS = ["Access Bank", "Ecobank", "Fidelity Bank", "First Bank", "FCMB", "GTBank", "Keystone Bank", "Kuda", "Moniepoint", "Opay", "PalmPay", "Polaris Bank", "Providus Bank", "Stanbic IBTC", "Sterling Bank", "UBA", "Union Bank", "Wema Bank", "Zenith Bank"].map((name, i) => ({ code: `T${String(i + 1).padStart(3, "0")}`, name }));
var pending = /* @__PURE__ */ new Map();
function nameFor(seed) {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`.toUpperCase();
}
var MockBank = class {
  id = "mock";
  listBanks() {
    return Promise.resolve(BANKS);
  }
  async createVirtualAccount(input) {
    const digits = (await sha256(input.userId)).replace(/\D/g, "").padEnd(9, "7").slice(0, 9);
    return { accountNumber: "9" + digits, accountName: `${input.firstName} ${input.lastName}`.toUpperCase(), bankName: "Kolo Test Bank", providerRef: "MOCK-" + input.userId };
  }
  nameEnquiry(bankCode, accountNumber) {
    if (!/^\d{10}$/.test(accountNumber)) throw new AppError("bad_account", "Account numbers have 10 digits.");
    if (accountNumber.endsWith("0000")) throw new AppError("account_not_found", "We couldn't find that account. Check the number and bank.", 404);
    return Promise.resolve({ accountName: nameFor(bankCode + accountNumber), sessionId: "MOCKSESSION" + Date.now() });
  }
  transfer(input) {
    const providerRef = "MOCKTX" + input.reference;
    if (input.amountKobo === 404e3) return Promise.resolve({ status: "failed", reason: "Beneficiary bank unavailable", providerRef });
    if (input.accountNumber.endsWith("9999")) {
      pending.set(input.reference, Date.now());
      return Promise.resolve({ status: "pending", providerRef });
    }
    return Promise.resolve({ status: "successful", providerRef });
  }
  transferStatus(reference) {
    pending.delete(reference);
    return Promise.resolve({ status: "successful", providerRef: "MOCKTX" + reference });
  }
  // Test webhooks are signed with HMAC-SHA256 of the raw body using MOCK_WEBHOOK_SECRET,
  // sent in the x-kolo-signature header. Body: { id, type: "credit", account_number, amount_kobo, ref, sender_name }
  async parseWebhook(req) {
    const raw = await req.text();
    const secret = Deno.env.get("MOCK_WEBHOOK_SECRET");
    if (!secret) throw new AppError("not_configured", "MOCK_WEBHOOK_SECRET is not set.", 500);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b2) => b2.toString(16).padStart(2, "0")).join("");
    if (sig !== req.headers.get("x-kolo-signature")) throw new AppError("bad_signature", "Invalid signature.", 401);
    const b = JSON.parse(raw);
    if (b.type === "credit") return [{ type: "credit", eventId: b.id, accountNumber: b.account_number, amountKobo: Number(b.amount_kobo), providerRef: b.ref, senderName: b.sender_name, senderBank: b.sender_bank, narration: b.narration }];
    return [{ type: "ignored", eventId: b.id }];
  }
};
var MockKyc = class {
  id = "mock";
  // Test rule: BVN/NIN starting with 0 fails, anything else (11 digits) matches.
  verifyBvn(input) {
    if (!/^\d{11}$/.test(input.bvn)) return Promise.resolve({ match: false, reason: "A BVN has 11 digits." });
    return Promise.resolve(input.bvn.startsWith("0") ? { match: false, reason: "The details don't match this BVN." } : { match: true });
  }
  verifyNin(input) {
    if (!/^\d{11}$/.test(input.nin)) return Promise.resolve({ match: false, reason: "A NIN has 11 digits." });
    return Promise.resolve(input.nin.startsWith("0") ? { match: false, reason: "The details don't match this NIN." } : { match: true });
  }
};

// supabase/functions/_shared/bank/ninepsb.ts
var notReady = (what) => {
  throw new AppError("provider_not_configured", `9PSB ${what} isn't connected yet. Set BANK_PROVIDER=mock until the 9PSB integration is finished.`, 503);
};
var NinePSB = class {
  id = "9psb";
  base = Deno.env.get("NINEPSB_BASE_URL") ?? "";
  token = null;
  // Shared request helper. Adjust headers/auth to match the docs.
  async call(path, init = {}) {
    if (!this.base) notReady("API URL");
    const res = await fetch(this.base + path, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await this.accessToken()}` },
      body: init.body ? JSON.stringify(init.body) : void 0,
      signal: AbortSignal.timeout(25e3)
    });
    const text = await res.text();
    if (!res.ok) {
      console.error("9psb error", path, res.status, text.slice(0, 500));
      throw new AppError("bank_error", "The bank didn't respond properly. No money moved.", 502);
    }
    return JSON.parse(text);
  }
  async accessToken() {
    if (this.token && this.token.exp > Date.now() + 3e4) return this.token.value;
    return notReady("authentication");
  }
  listBanks() {
    return notReady("bank list");
  }
  createVirtualAccount(_i) {
    return notReady("account opening");
  }
  nameEnquiry(_bankCode, _accountNumber) {
    return notReady("name enquiry");
  }
  transfer(_i) {
    return notReady("transfers");
  }
  transferStatus(_reference) {
    return notReady("transfer status");
  }
  parseWebhook(_req) {
    return notReady("webhooks");
  }
};

// supabase/functions/_shared/bank/index.ts
var bank = null;
var kyc = null;
function bankProvider() {
  if (bank) return bank;
  const id = Deno.env.get("BANK_PROVIDER") ?? "mock";
  if (id === "9psb") bank = new NinePSB();
  else {
    if ((Deno.env.get("KOLO_ENV") ?? "sandbox") === "production") throw new Error("The test bank cannot run in production. Set BANK_PROVIDER=9psb.");
    bank = new MockBank();
  }
  return bank;
}
function kycProvider() {
  if (kyc) return kyc;
  const id = Deno.env.get("KYC_PROVIDER") ?? "mock";
  if (id !== "mock") throw new Error(`KYC provider "${id}" isn't implemented yet.`);
  if ((Deno.env.get("KOLO_ENV") ?? "sandbox") === "production") throw new Error("Mock KYC cannot run in production.");
  kyc = new MockKyc();
  return kyc;
}

// supabase/functions/api/index.ts
var FEE_BANK_KOBO = Number(Deno.env.get("FEE_BANK_KOBO") ?? 1e3);
var OTP_MIN_KOBO = Number(Deno.env.get("OTP_MIN_KOBO") ?? 5e6);
var MIN_TRANSFER_KOBO = 1e4;
var int = (v, name) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError("bad_amount", `Enter a valid ${name}.`);
  return n;
};
var str = (v, name, re, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max || re && !re.test(v.trim())) throw new AppError("bad_input", `Check the ${name} and try again.`);
  return v.trim();
};
var cleanNarration = (v) => typeof v === "string" ? v.replace(/[^\p{L}\p{N} .,'&()\-/]/gu, "").slice(0, 60) : "";
async function myAccount(userId) {
  const { data } = await admin.from("accounts").select("*").eq("user_id", userId).maybeSingle();
  return data;
}
async function requireOtpIfNeeded(c, totalKobo, what) {
  if (!c.profile.otp_large || totalKobo < OTP_MIN_KOBO) return;
  if (!c.b.otp_id) {
    const sent = await sendOtp(c, "transfer", what);
    throw new AppError("otp_required", "We sent a 6-digit code to your phone. Enter it to continue.", 401, { otp_required: true, ...sent });
  }
  await verifyOtp(c.user.id, "transfer", c.b.otp_id, c.b.otp_code);
}
async function sendOtp(c, purpose, what) {
  await rateLimit(c.user.id, "otp", 5, 600);
  return await createOtp(c.user.id, c.profile.phone ?? c.user.phone ?? null, purpose, what);
}
async function finishTransfer(txnId, result) {
  if (result.status === "successful") return (await admin.rpc("settle_debit", { p_txn: txnId, p_provider_ref: result.providerRef })).data;
  if (result.status === "failed") return (await admin.rpc("reverse_debit", { p_txn: txnId, p_reason: result.reason })).data;
  if (result.providerRef) await admin.from("transactions").update({ provider_ref: result.providerRef }).eq("id", txnId).is("provider_ref", null);
  return (await admin.from("transactions").select("*").eq("id", txnId).single()).data;
}
var actions = {
  // ───────── profile ─────────
  async me(c) {
    const [{ data: tier }, account, pinSet, { data: tiers }] = await Promise.all([
      admin.from("tiers").select("*").eq("tier", c.profile.tier).single(),
      myAccount(c.user.id),
      hasPin(c.user.id),
      admin.from("tiers").select("*").order("tier")
    ]);
    const { data: spent } = await admin.rpc("spent_today", { p_user: c.user.id });
    return { profile: c.profile, account, tier, tiers, pin_set: pinSet, spent_today_kobo: Number(spent ?? 0), fee_bank_kobo: FEE_BANK_KOBO, otp_min_kobo: OTP_MIN_KOBO, sandbox: isSandbox() };
  },
  // ───────── onboarding ─────────
  async "kyc.submit"(c) {
    if (c.profile.kyc_status === "verified") throw new AppError("already_verified", "Your identity is already verified.");
    await rateLimit(c.user.id, "kyc", 5, 3600);
    const first = str(c.b.first_name, "first name", /^[\p{L}' -]{2,40}$/u), last = str(c.b.last_name, "last name", /^[\p{L}' -]{2,40}$/u);
    const dob = str(c.b.dob, "date of birth", /^\d{4}-\d{2}-\d{2}$/);
    const bvn = str(c.b.bvn, "BVN", /^\d{11}$/);
    const tag = str(c.b.tag, "Kolo tag", /^[a-z0-9_.]{3,20}$/).toLowerCase();
    const phone = c.profile.phone ?? c.user.phone ?? "";
    const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 864e5);
    if (!(age >= 18 && age < 120)) throw new AppError("underage", "You must be 18 or older to open a Kolo account.");
    const { data: taken } = await admin.from("profiles").select("id").eq("tag", tag).neq("id", c.user.id).maybeSingle();
    if (taken) throw new AppError("tag_taken", "That Kolo tag is taken. Try another.");
    const bvnHash = await sha256(bvn + Deno.env.get("PIN_PEPPER"));
    const { data: dupe } = await admin.from("profiles").select("id").eq("bvn_hash", bvnHash).neq("id", c.user.id).maybeSingle();
    if (dupe) throw new AppError("bvn_used", "This BVN is already linked to another Kolo account.");
    const res = await kycProvider().verifyBvn({ bvn, firstName: first, lastName: last, dob, phone });
    if (!res.match) {
      await audit(c.user.id, "kyc.bvn_failed", { reason: res.reason }, c.req);
      throw new AppError("kyc_failed", res.reason ?? "Those details don't match your BVN. Check your name and date of birth exactly as on your BVN.");
    }
    const va = await bankProvider().createVirtualAccount({ userId: c.user.id, firstName: first, lastName: last, phone, bvn, dob });
    await admin.from("profiles").update({ first_name: first, last_name: last, dob, tag, bvn_hash: bvnHash, bvn_last4: bvn.slice(-4), kyc_status: "verified", tier: 1 }).eq("id", c.user.id);
    await admin.from("accounts").upsert({ user_id: c.user.id, kind: "customer", account_number: va.accountNumber, account_name: va.accountName, bank_name: va.bankName, provider: bankProvider().id, provider_ref: va.providerRef }, { onConflict: "user_id" });
    await audit(c.user.id, "kyc.verified", { tier: 1 }, c.req);
    await notify(c.user.id, "Welcome to Kolo \u{1F389}", `Your account number is ${va.accountNumber}. Share it to receive money from any bank.`, "info");
    return { account_number: va.accountNumber, bank_name: va.bankName };
  },
  async "kyc.upgrade"(c) {
    if (c.profile.tier !== 1) throw new AppError("bad_tier", c.profile.tier >= 2 ? "You're already on Tier 2 or higher." : "Verify your BVN first.");
    await rateLimit(c.user.id, "kyc", 5, 3600);
    const nin = str(c.b.nin, "NIN", /^\d{11}$/);
    const { data: p } = await admin.from("profiles").select("dob").eq("id", c.user.id).single();
    const res = await kycProvider().verifyNin({ nin, firstName: c.profile.first_name, lastName: c.profile.last_name, dob: p?.dob });
    if (!res.match) throw new AppError("kyc_failed", res.reason ?? "Those details don't match your NIN.");
    await admin.from("profiles").update({ nin_last4: nin.slice(-4), tier: 2 }).eq("id", c.user.id);
    await audit(c.user.id, "kyc.tier2", {}, c.req);
    await notify(c.user.id, "You're on Tier 2", "Your limits just went up.", "info");
    return { tier: 2 };
  },
  // ───────── PIN & codes ─────────
  async "pin.set"(c) {
    if (await hasPin(c.user.id)) throw new AppError("pin_exists", "You already have a PIN. Use Change PIN instead.");
    const pin = str(c.b.pin, "PIN");
    assertStrongPin(pin, c.profile);
    await setPin(c.user.id, pin);
    await audit(c.user.id, "pin.set", {}, c.req);
    return { ok: true };
  },
  async "pin.change"(c) {
    await verifyPin(c.user.id, c.b.old_pin, c.req);
    const pin = str(c.b.new_pin, "new PIN");
    assertStrongPin(pin, c.profile);
    if (!c.b.otp_id) {
      const sent = await sendOtp(c, "pin_change", "change your PIN");
      throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent });
    }
    await verifyOtp(c.user.id, "pin_change", c.b.otp_id, c.b.otp_code);
    await setPin(c.user.id, pin);
    await audit(c.user.id, "pin.changed", {}, c.req);
    await notify(c.user.id, "PIN changed", "Your transaction PIN was changed. If this wasn't you, freeze your account now.", "security");
    return { ok: true };
  },
  async "pin.check"(c) {
    await rateLimit(c.user.id, "pin_check", 20, 300);
    await verifyPin(c.user.id, c.b.pin, c.req);
    return { ok: true };
  },
  // ───────── lookups ─────────
  async "banks.list"() {
    return { banks: await bankProvider().listBanks() };
  },
  async "name.enquiry"(c) {
    await rateLimit(c.user.id, "name_enquiry", 30, 300);
    const r = await bankProvider().nameEnquiry(str(c.b.bank_code, "bank"), str(c.b.account_number, "account number", /^\d{10}$/));
    return { account_name: r.accountName };
  },
  async "tag.lookup"(c) {
    await rateLimit(c.user.id, "tag_lookup", 30, 300);
    const tag = str(c.b.tag, "Kolo tag").replace(/^@/, "").toLowerCase();
    const { data } = await admin.from("profiles").select("id, first_name, last_name, tag").eq("tag", tag).eq("kyc_status", "verified").maybeSingle();
    if (!data || data.id === c.user.id) throw new AppError("tag_not_found", data ? "That's your own tag." : "No Kolo user has that tag.", 404);
    return { name: `${data.first_name} ${data.last_name}`, tag: data.tag };
  },
  // ───────── transfers ─────────
  async "transfer.quote"(c) {
    const amount = int(c.b.amount_kobo, "amount");
    const fee = c.b.kind === "kolo" ? 0 : FEE_BANK_KOBO;
    return { fee_kobo: fee, total_kobo: amount + fee, needs_otp: c.profile.otp_large && amount + fee >= OTP_MIN_KOBO };
  },
  async "transfer.bank"(c) {
    const amount = int(c.b.amount_kobo, "amount");
    if (amount < MIN_TRANSFER_KOBO) throw new AppError("too_small", `The minimum transfer is ${naira(MIN_TRANSFER_KOBO)}.`);
    const bankCode = str(c.b.bank_code, "bank"), bankName = str(c.b.bank_name, "bank name", void 0, 80);
    const acct = str(c.b.account_number, "account number", /^\d{10}$/);
    const idem = str(c.b.idempotency_key, "request id", /^[A-Za-z0-9-]{8,64}$/);
    const narration = cleanNarration(c.b.narration);
    await rateLimit(c.user.id, "transfer", 10, 60);
    await checkLimits(c.profile, amount + FEE_BANK_KOBO);
    await verifyPin(c.user.id, c.b.pin, c.req);
    await requireOtpIfNeeded(c, amount + FEE_BANK_KOBO, `send ${naira(amount)}`);
    const account = await myAccount(c.user.id);
    if (!account) throw new AppError("no_account", "Finish setting up your account first.");
    const bank2 = bankProvider();
    const enq = await bank2.nameEnquiry(bankCode, acct);
    const reference = newReference("KLT");
    const { data: txn, error } = await admin.rpc("begin_debit", {
      p_user: c.user.id,
      p_amount: amount,
      p_fee: FEE_BANK_KOBO,
      p_category: "bank_transfer",
      p_reference: reference,
      p_counterparty: { name: enq.accountName, bank_name: bankName, bank_code: bankCode, account_number: acct },
      p_narration: narration,
      p_idem: idem
    });
    if (error) throw error;
    if (txn.reference !== reference) return { transaction: txn, replay: true };
    let result;
    try {
      result = await bank2.transfer({ reference, amountKobo: amount, bankCode, accountNumber: acct, accountName: enq.accountName, narration: narration || `Kolo transfer`, senderName: `${c.profile.first_name} ${c.profile.last_name}`, senderAccountNumber: account.account_number, sessionId: enq.sessionId });
    } catch (e) {
      result = e instanceof AppError && (e.status < 500 || e.code === "provider_not_configured") ? { status: "failed", reason: e.message } : { status: "pending", providerRef: "" };
      console.error("transfer error", reference, e);
    }
    const final = await finishTransfer(txn.id, result);
    if (final.status === "reversed") {
      await notify(c.user.id, "Transfer failed, money returned", `Your transfer of ${naira(amount)} to ${enq.accountName} didn't go through. ${naira(amount + FEE_BANK_KOBO)} is back in your balance.`, "credit");
    } else {
      await notify(c.user.id, "Debit alert", `${naira(amount + FEE_BANK_KOBO)} sent to ${enq.accountName} (${bankName}). Balance ${naira(final.balance_after_kobo)}.`, "debit");
    }
    if (c.b.save_beneficiary && final.status !== "reversed") {
      await admin.from("beneficiaries").upsert({ user_id: c.user.id, account_name: enq.accountName, account_number: acct, bank_code: bankCode, bank_name: bankName }, { onConflict: "user_id,bank_code,account_number" });
    }
    await audit(c.user.id, "transfer.bank", { reference, amount, status: final.status }, c.req);
    return { transaction: final };
  },
  async "transfer.kolo"(c) {
    const amount = int(c.b.amount_kobo, "amount");
    const tag = str(c.b.tag, "Kolo tag").replace(/^@/, "").toLowerCase();
    const idem = str(c.b.idempotency_key, "request id", /^[A-Za-z0-9-]{8,64}$/);
    await rateLimit(c.user.id, "transfer", 10, 60);
    await checkLimits(c.profile, amount);
    await verifyPin(c.user.id, c.b.pin, c.req);
    await requireOtpIfNeeded(c, amount, `send ${naira(amount)} to @${tag}`);
    const { data: to } = await admin.from("profiles").select("id, first_name, last_name, tier").eq("tag", tag).eq("kyc_status", "verified").maybeSingle();
    if (!to) throw new AppError("tag_not_found", "No Kolo user has that tag.", 404);
    const reference = newReference("KLK");
    const { data: txn, error } = await admin.rpc("internal_transfer", { p_from: c.user.id, p_to: to.id, p_amount: amount, p_reference: reference, p_narration: cleanNarration(c.b.narration), p_idem: idem });
    if (error) throw error;
    if (txn.reference === reference) {
      await notify(c.user.id, "Debit alert", `${naira(amount)} sent to ${to.first_name} ${to.last_name} (@${tag}). Balance ${naira(txn.balance_after_kobo)}.`, "debit");
      await notify(to.id, "Credit alert", `${c.profile.first_name} ${c.profile.last_name} (@${c.profile.tag}) sent you ${naira(amount)}.`, "credit");
      await audit(c.user.id, "transfer.kolo", { reference, amount, to: to.id }, c.req);
    }
    return { transaction: txn };
  },
  // ───────── security centre ─────────
  async "otp.request"(c) {
    const purpose = str(c.b.purpose, "purpose");
    const what = { transfer: "confirm a transfer", pin_change: "change your PIN", unfreeze: "unfreeze your account", limit_raise: "raise your daily limit", otp_off: "turn off codes for big transfers" };
    if (!what[purpose]) throw new AppError("bad_purpose", "Unknown code purpose.");
    return await sendOtp(c, purpose, what[purpose]);
  },
  // Freezing needs no PIN on purpose: if your phone is stolen, speed matters.
  async "security.freeze"(c) {
    await admin.from("profiles").update({ frozen: true }).eq("id", c.user.id);
    await admin.from("accounts").update({ status: "frozen" }).eq("user_id", c.user.id);
    await audit(c.user.id, "security.frozen", {}, c.req);
    await notify(c.user.id, "Account frozen", "All outgoing payments are blocked. Money can still come in.", "security");
    return { frozen: true };
  },
  async "security.unfreeze"(c) {
    await verifyPin(c.user.id, c.b.pin, c.req);
    if (!c.b.otp_id) {
      const sent = await sendOtp(c, "unfreeze", "unfreeze your account");
      throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent });
    }
    await verifyOtp(c.user.id, "unfreeze", c.b.otp_id, c.b.otp_code);
    const { data: lastAdmin } = await admin.from("audit_log").select("action").eq("user_id", c.user.id).in("action", ["admin.frozen", "admin.unfrozen"]).order("created_at", { ascending: false }).limit(1);
    if (lastAdmin?.[0]?.action === "admin.frozen") throw new AppError("admin_hold", "Our team placed a hold on this account. Contact support to lift it.", 403);
    await admin.from("profiles").update({ frozen: false }).eq("id", c.user.id);
    await admin.from("accounts").update({ status: "active" }).eq("user_id", c.user.id);
    await audit(c.user.id, "security.unfrozen", {}, c.req);
    await notify(c.user.id, "Account unfrozen", "You can send money again.", "security");
    return { frozen: false };
  },
  async "security.limit"(c) {
    const v = int(c.b.daily_limit_kobo, "limit");
    const { data: tier } = await admin.from("tiers").select("daily_kobo").eq("tier", c.profile.tier).single();
    if (!tier || v > tier.daily_kobo) throw new AppError("over_tier", `Your account level allows up to ${naira(tier?.daily_kobo ?? 0)} a day.`);
    const current = c.profile.daily_limit_kobo ?? tier.daily_kobo;
    if (v > current) {
      await verifyPin(c.user.id, c.b.pin, c.req);
      if (!c.b.otp_id) {
        const sent = await sendOtp(c, "limit_raise", "raise your daily limit");
        throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent });
      }
      await verifyOtp(c.user.id, "limit_raise", c.b.otp_id, c.b.otp_code);
    }
    await admin.from("profiles").update({ daily_limit_kobo: v }).eq("id", c.user.id);
    await audit(c.user.id, "security.limit", { from: current, to: v }, c.req);
    return { daily_limit_kobo: v };
  },
  async "security.otp_large"(c) {
    const on = !!c.b.on;
    if (!on) {
      await verifyPin(c.user.id, c.b.pin, c.req);
      if (!c.b.otp_id) {
        const sent = await sendOtp(c, "otp_off", "turn off codes for big transfers");
        throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent });
      }
      await verifyOtp(c.user.id, "otp_off", c.b.otp_id, c.b.otp_code);
    }
    await admin.from("profiles").update({ otp_large: on }).eq("id", c.user.id);
    await audit(c.user.id, "security.otp_large", { on }, c.req);
    return { otp_large: on };
  },
  async "devices.revoke"(c) {
    await verifyPin(c.user.id, c.b.pin, c.req);
    const id = str(c.b.id, "device");
    await admin.from("devices").delete().eq("id", id).eq("user_id", c.user.id);
    await admin.auth.admin.signOut(c.req.headers.get("Authorization").replace(/^Bearer\s+/i, ""), "others");
    await audit(c.user.id, "device.revoked", { id }, c.req);
    return { ok: true };
  },
  async "prefs.update"(c) {
    const patch = {};
    if (typeof c.b.pidgin === "boolean") patch.pidgin = c.b.pidgin;
    if (!Object.keys(patch).length) throw new AppError("bad_input", "Nothing to update.");
    await admin.from("profiles").update(patch).eq("id", c.user.id);
    return patch;
  },
  // ───────── admin (profiles.is_admin = true) ─────────
  async "admin.overview"(c) {
    adminOnly(c);
    const [users, verified, pending2, mism, accts] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin.from("profiles").select("id", { count: "exact", head: true }).eq("kyc_status", "verified"),
      admin.from("transactions").select("id", { count: "exact", head: true }).eq("status", "pending"),
      admin.from("ledger_mismatches").select("id", { count: "exact", head: true }),
      admin.from("accounts").select("kind, balance_kobo")
    ]);
    const sum = (k) => (accts.data ?? []).filter((a) => a.kind === k).reduce((s, a) => s + Number(a.balance_kobo), 0);
    const since = new Date(Date.now() - 864e5).toISOString();
    const { data: vol } = await admin.from("transactions").select("amount_kobo, direction").gte("created_at", since).eq("status", "successful");
    return {
      users: users.count,
      verified: verified.count,
      pending_transfers: pending2.count,
      ledger_mismatches: mism.count,
      customer_balances_kobo: sum("customer"),
      fee_income_kobo: sum("fees"),
      in_flight_kobo: sum("suspense"),
      volume_24h_in_kobo: (vol ?? []).filter((t) => t.direction === "credit").reduce((s, t) => s + Number(t.amount_kobo), 0),
      volume_24h_out_kobo: (vol ?? []).filter((t) => t.direction === "debit").reduce((s, t) => s + Number(t.amount_kobo), 0),
      sandbox: isSandbox()
    };
  },
  async "admin.users"(c) {
    adminOnly(c);
    const q = typeof c.b.q === "string" ? c.b.q.replace(/[^\p{L}\p{N}@._ -]/gu, "").slice(0, 40) : "";
    let query = admin.from("profiles").select("id, first_name, last_name, tag, phone, tier, kyc_status, frozen, created_at").order("created_at", { ascending: false }).limit(50);
    if (q) query = query.or(`tag.ilike.%${q.replace(/^@/, "")}%,phone.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
    return { users: (await query).data };
  },
  async "admin.user"(c) {
    adminOnly(c);
    const id = str(c.b.id, "user");
    const [p, a, t, l] = await Promise.all([
      admin.from("profiles").select("*").eq("id", id).single(),
      admin.from("accounts").select("*").eq("user_id", id).maybeSingle(),
      admin.from("transactions").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(50),
      admin.from("audit_log").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(50)
    ]);
    return { profile: p.data, account: a.data, transactions: t.data, audit: l.data };
  },
  async "admin.transactions"(c) {
    adminOnly(c);
    let q = admin.from("transactions").select("*, profiles(first_name, last_name, tag)").order("created_at", { ascending: false }).limit(100);
    if (["pending", "successful", "failed", "reversed"].includes(c.b.status)) q = q.eq("status", c.b.status);
    return { transactions: (await q).data };
  },
  async "admin.freeze"(c) {
    adminOnly(c);
    const id = str(c.b.user_id, "user"), frozen = !!c.b.frozen, reason = cleanNarration(c.b.reason);
    await admin.from("profiles").update({ frozen }).eq("id", id);
    await admin.from("accounts").update({ status: frozen ? "frozen" : "active" }).eq("user_id", id);
    await audit(id, frozen ? "admin.frozen" : "admin.unfrozen", { reason }, c.req, `admin:${c.user.id}`);
    await notify(id, frozen ? "Account on hold" : "Hold removed", frozen ? "Our team placed a temporary hold on your account. Contact support." : "You can use your account normally again.", "security");
    return { frozen };
  },
  async "admin.requery"(c) {
    adminOnly(c);
    const { data: t } = await admin.from("transactions").select("*").eq("id", str(c.b.txn_id, "transaction")).single();
    if (!t || t.status !== "pending") throw new AppError("not_pending", "Only pending transfers can be requeried.");
    const final = await finishTransfer(t.id, await bankProvider().transferStatus(t.reference));
    await audit(t.user_id, "admin.requery", { reference: t.reference, status: final.status }, c.req, `admin:${c.user.id}`);
    return { transaction: final };
  },
  // Test money for the sandbox only. Refuses to run in production.
  async "admin.test_deposit"(c) {
    adminOnly(c);
    if (!isSandbox()) throw new AppError("forbidden", "Test deposits are disabled in production.", 403);
    const amount = int(c.b.amount_kobo, "amount");
    const acct = str(c.b.account_number, "account number", /^\d{10}$/);
    const { data: txn, error } = await admin.rpc("credit_deposit", { p_account_number: acct, p_amount: amount, p_provider_ref: "TEST-" + crypto.randomUUID(), p_counterparty: { name: "Kolo Test Funding", bank_name: "Test" }, p_narration: "Test deposit" });
    if (error) throw error;
    await notify(txn.user_id, "Credit alert", `${naira(amount)} test deposit received.`, "credit");
    return { transaction: txn };
  }
};
function adminOnly(c) {
  if (!c.profile.is_admin) throw new AppError("forbidden", "Admins only.", 403);
}
Deno.serve(handler(async (req) => {
  if (req.method !== "POST") throw new AppError("method", "Use POST.", 405);
  const b = await body(req);
  const fn = actions[String(b.action)];
  if (!fn) throw new AppError("unknown_action", "Unknown action.", 404);
  const { user, profile } = await requireUser(req);
  return json(await fn({ user, profile, req, b }) ?? { ok: true });
}));
