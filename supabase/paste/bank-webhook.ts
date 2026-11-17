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
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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
var clientIp = (req) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

// supabase/functions/_shared/db.ts
import { createClient } from "npm:@supabase/supabase-js@2";
var env = (k, fallback) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === void 0) throw new Error(`Missing environment variable ${k}`);
  return v;
};
var admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false }
});
async function audit(userId, action, meta = {}, req, actor = "user") {
  await admin.from("audit_log").insert({ user_id: userId, action, meta, actor, ip: req ? clientIp(req) : null });
}
async function notify(userId, title, body, kind = "info") {
  await admin.from("notifications").insert({ user_id: userId, title, body, kind });
}
var naira = (kobo) => "\u20A6" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// supabase/functions/_shared/security.ts
var enc = new TextEncoder();
var hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
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

// supabase/functions/bank-webhook/index.ts
Deno.serve(handler(async (req) => {
  const bank2 = bankProvider();
  const events = await bank2.parseWebhook(req);
  for (const ev of events) {
    const { error: dup } = await admin.from("webhook_events").insert({ provider: bank2.id, event_id: ev.eventId, payload: ev });
    if (dup) {
      if (dup.code === "23505") continue;
      throw dup;
    }
    if (ev.type === "credit") {
      const { data: txn, error } = await admin.rpc("credit_deposit", {
        p_account_number: ev.accountNumber,
        p_amount: ev.amountKobo,
        p_provider_ref: ev.providerRef,
        p_counterparty: { name: ev.senderName ?? "", bank_name: ev.senderBank ?? "" },
        p_narration: ev.narration ?? ""
      });
      if (error) {
        console.error("credit failed", ev, error);
        throw error;
      }
      await notify(txn.user_id, "Credit alert", `${naira(ev.amountKobo)} from ${ev.senderName || "a bank transfer"}${ev.senderBank ? ` (${ev.senderBank})` : ""}. Balance ${naira(txn.balance_after_kobo)}.`, "credit");
      await audit(txn.user_id, "deposit", { amount: ev.amountKobo, ref: ev.providerRef }, void 0, "system");
    }
    if (ev.type === "transfer_status") {
      const { data: t } = await admin.from("transactions").select("*").eq("reference", ev.reference).maybeSingle();
      if (t && t.status === "pending") {
        const fn = ev.status === "successful" ? "settle_debit" : "reverse_debit";
        const { data: final } = await admin.rpc(fn, ev.status === "successful" ? { p_txn: t.id, p_provider_ref: ev.providerRef } : { p_txn: t.id, p_reason: ev.reason ?? "Rejected by the receiving bank" });
        if (final?.status === "reversed") await notify(t.user_id, "Transfer failed, money returned", `${naira(t.amount_kobo + t.fee_kobo)} is back in your balance.`, "credit");
        await audit(t.user_id, "transfer.status", { reference: t.reference, status: final?.status }, void 0, "system");
      }
    }
    await admin.from("webhook_events").update({ processed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("provider", bank2.id).eq("event_id", ev.eventId);
  }
  return json({ ok: true });
}));
