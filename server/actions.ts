// Kolo API: one endpoint (/api/v1), many actions. The app sends { action, ...params }.
// Every money movement is checked here (PIN, one-time code, limits, rate limits) and then
// executed by the SQL functions, so a modified app can never bypass the rules.
import { AppError, json, readJson } from "./http";
import { audit, isSandbox, naira, notify, one, q, Row } from "./db";
import { Ctx, listDevices, logout, Profile, requireSession, revokeDevice, startLogin, verifyLogin } from "./auth";
import { assertStrongPin, createOtp, hasPin, OtpPurpose, rateLimit, setPin, sha256, verifyOtp, verifyPin } from "./security";
import { bankProvider, kycProvider, TransferResult } from "./bank";
import { finishTransfer, recheck } from "./transfers";
import { env } from "./db";
import { randomUUID } from "node:crypto";

const FEE_BANK_KOBO = Number(process.env.FEE_BANK_KOBO ?? 1000);        // ₦10 per bank transfer
const OTP_MIN_KOBO = Number(process.env.OTP_MIN_KOBO ?? 5_000_000);      // ₦50,000 and above needs a one-time code
const MIN_TRANSFER_KOBO = 10_000;                                          // ₦100

type C = Ctx & { b: Record<string, any> };
type Action = (c: C) => Promise<unknown>;

// ───────────────────────── input checks ─────────────────────────
const int = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError("bad_amount", `Enter a valid ${name}.`);
  return n;
};
const str = (v: unknown, name: string, re?: RegExp, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max || (re && !re.test(v.trim()))) throw new AppError("bad_input", `Check the ${name} and try again.`);
  return v.trim();
};
const uuid = (v: unknown, name: string) => str(v, name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const cleanNarration = (v: unknown) => (typeof v === "string" ? v.replace(/[^\p{L}\p{N} .,'&()\-/]/gu, "").slice(0, 60) : "");

// ───────────────────────── helpers ─────────────────────────
const myAccount = (userId: string) =>
  one("select account_number, account_name, bank_name, balance_kobo, status from accounts where user_id = $1", [userId]);

async function spentToday(userId: string) {
  return Number((await one<{ spent_kobo: number }>("select spent_today($1) as spent_kobo", [userId]))?.spent_kobo ?? 0);
}

async function checkLimits(p: Profile, totalKobo: number) {
  if (p.frozen) throw new AppError("account_frozen", "Your account is frozen. Unfreeze it in Security to send money.", 403);
  if (p.kyc_status !== "verified" || p.tier < 1) throw new AppError("kyc_required", "Verify your identity before sending money.", 403);
  const tier = (await one("select * from tiers where tier = $1", [p.tier]))!;
  if (totalKobo > tier.single_kobo) throw new AppError("over_single_limit", `${tier.name} lets you send up to ${naira(tier.single_kobo)} at once. Upgrade your account to send more.`);
  const daily = Math.min(tier.daily_kobo, p.daily_limit_kobo ?? Number.MAX_SAFE_INTEGER);
  const spent = await spentToday(p.id);
  if (spent + totalKobo > daily) throw new AppError("over_daily_limit", `This would pass your daily limit of ${naira(daily)}. You've used ${naira(spent)} today.`);
}

async function sendOtp(c: C, purpose: OtpPurpose, what: string) {
  await rateLimit(c.userId, "otp", 5, 600);
  return createOtp(c.userId, c.phone, purpose, what);
}

/** Throws otp_required (with a fresh code sent) unless a valid code came with the request. */
async function requireOtp(c: C, purpose: OtpPurpose, what: string) {
  if (!c.b.otp_id) {
    const sent = await sendOtp(c, purpose, what);
    throw new AppError("otp_required", "We sent a 6-digit code to your phone. Enter it to continue.", 401, { otp_required: true, ...sent });
  }
  await verifyOtp(c.userId, purpose, c.b.otp_id, c.b.otp_code);
}

const TXN_COLS = "id, reference, direction, category, amount_kobo, fee_kobo, status, counterparty, narration, failure_reason, balance_after_kobo, created_at";
const publicTxn = (t: Row) => {
  const { id, reference, direction, category, amount_kobo, fee_kobo, status, counterparty, narration, failure_reason, balance_after_kobo, created_at } = t;
  return { id, reference, direction, category, amount_kobo, fee_kobo, status, counterparty, narration, failure_reason, balance_after_kobo, created_at };
};

// ───────────────────────── actions (need sign-in) ─────────────────────────
const actions: Record<string, Action> = {
  async me(c) {
    const [tier, account, pinSet, tiers, spent, unread] = await Promise.all([
      one("select * from tiers where tier = $1", [c.profile.tier]),
      myAccount(c.userId), hasPin(c.userId), q("select * from tiers order by tier"), spentToday(c.userId),
      one<{ n: number }>("select count(*) as n from notifications where user_id = $1 and not read", [c.userId]),
    ]);
    return { profile: c.profile, account, tier, tiers, pin_set: pinSet, spent_today_kobo: spent, unread_count: unread?.n ?? 0, fee_bank_kobo: FEE_BANK_KOBO, otp_min_kobo: OTP_MIN_KOBO, sandbox: isSandbox() };
  },

  "auth.logout": (c) => logout(c),

  // ───────── onboarding ─────────
  async "kyc.submit"(c) {
    if (c.profile.kyc_status === "verified") throw new AppError("already_verified", "Your identity is already verified.");
    await rateLimit(c.userId, "kyc", 5, 3600);
    const first = str(c.b.first_name, "first name", /^[\p{L}' -]{2,40}$/u), last = str(c.b.last_name, "last name", /^[\p{L}' -]{2,40}$/u);
    const dob = str(c.b.dob, "date of birth", /^\d{4}-\d{2}-\d{2}$/);
    const bvn = str(c.b.bvn, "BVN", /^\d{11}$/);
    const tag = str(c.b.tag, "Kolo tag", /^@?[a-zA-Z0-9_.]{3,20}$/).replace(/^@/, "").toLowerCase();
    const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000);
    if (!(age >= 18 && age < 120)) throw new AppError("underage", "You must be 18 or older to open a Kolo account.");
    if (await one("select 1 as x from profiles where tag = $1 and id <> $2", [tag, c.userId])) throw new AppError("tag_taken", "That Kolo tag is taken. Try another.");
    const bvnHash = sha256(bvn + env("PIN_PEPPER"));
    if (await one("select 1 as x from profiles where bvn_hash = $1 and id <> $2", [bvnHash, c.userId])) throw new AppError("bvn_used", "This BVN is already linked to another Kolo account.");

    const res = await kycProvider().verifyBvn({ bvn, firstName: first, lastName: last, dob, phone: c.phone });
    if (!res.match) {
      await audit(c.userId, "kyc.bvn_failed", { reason: res.reason }, c.ip);
      throw new AppError("kyc_failed", res.reason ?? "Those details don't match your BVN. Check your name and date of birth exactly as on your BVN.");
    }
    const va = await bankProvider().createVirtualAccount({ userId: c.userId, firstName: first, lastName: last, phone: c.phone, bvn, dob });
    await q(
      `update profiles set first_name = $2, last_name = $3, dob = $4, tag = $5, bvn_hash = $6, bvn_last4 = $7, kyc_status = 'verified', tier = 1 where id = $1`,
      [c.userId, first, last, dob, tag, bvnHash, bvn.slice(-4)],
    );
    await q(
      `insert into accounts (user_id, kind, account_number, account_name, bank_name, provider, provider_ref) values ($1, 'customer', $2, $3, $4, $5, $6)
       on conflict (user_id) do update set account_number = excluded.account_number, account_name = excluded.account_name, bank_name = excluded.bank_name, provider = excluded.provider, provider_ref = excluded.provider_ref`,
      [c.userId, va.accountNumber, va.accountName, va.bankName, bankProvider().id, va.providerRef],
    );
    await audit(c.userId, "kyc.verified", { tier: 1 }, c.ip);
    await notify(c.userId, "Welcome to Kolo 🎉", `Your account number is ${va.accountNumber}. Share it to receive money from any bank.`);
    return { account_number: va.accountNumber, bank_name: va.bankName };
  },

  async "kyc.upgrade"(c) {
    if (c.profile.tier !== 1) throw new AppError("bad_tier", c.profile.tier >= 2 ? "You're already on Tier 2 or higher." : "Verify your BVN first.");
    await rateLimit(c.userId, "kyc", 5, 3600);
    const nin = str(c.b.nin, "NIN", /^\d{11}$/);
    const res = await kycProvider().verifyNin({ nin, firstName: c.profile.first_name, lastName: c.profile.last_name, dob: String(c.profile.dob ?? "") });
    if (!res.match) throw new AppError("kyc_failed", res.reason ?? "Those details don't match your NIN.");
    await q("update profiles set nin_last4 = $2, tier = 2 where id = $1", [c.userId, nin.slice(-4)]);
    await audit(c.userId, "kyc.tier2", {}, c.ip);
    await notify(c.userId, "You're on Tier 2", "Your limits just went up.");
    return { tier: 2 };
  },

  // ───────── PIN ─────────
  async "pin.set"(c) {
    if (await hasPin(c.userId)) throw new AppError("pin_exists", "You already have a PIN. Use Change PIN instead.");
    const pin = str(c.b.pin, "PIN"); assertStrongPin(pin, c.phone);
    await setPin(c.userId, pin);
    await audit(c.userId, "pin.set", {}, c.ip);
    return { ok: true };
  },

  async "pin.change"(c) {
    await verifyPin(c.userId, c.b.old_pin, c.ip);
    const pin = str(c.b.new_pin, "new PIN"); assertStrongPin(pin, c.phone);
    await requireOtp(c, "pin_change", "change your PIN");
    await setPin(c.userId, pin);
    await audit(c.userId, "pin.changed", {}, c.ip);
    await notify(c.userId, "PIN changed", "Your transaction PIN was changed. If this wasn't you, freeze your account now.", "security");
    return { ok: true };
  },

  async "pin.check"(c) { await rateLimit(c.userId, "pin_check", 20, 300); await verifyPin(c.userId, c.b.pin, c.ip); return { ok: true }; },

  // ───────── reading your data ─────────
  async "transactions.list"(c) {
    const limit = Math.min(50, Math.max(1, Number(c.b.limit) || 30)), offset = Math.max(0, Number(c.b.offset) || 0);
    const dir = c.b.direction === "credit" || c.b.direction === "debit" ? c.b.direction : null;
    const rows = await q(
      `select ${TXN_COLS} from transactions where user_id = $1 and ($2::txn_direction is null or direction = $2::txn_direction) order by created_at desc limit $3 offset $4`,
      [c.userId, dir, limit, offset],
    );
    return { transactions: rows.map(publicTxn) };
  },

  async "transactions.get"(c) {
    let t = await one(`select * from transactions where id = $1 and user_id = $2`, [uuid(c.b.id, "transaction"), c.userId]);
    if (!t) throw new AppError("not_found", "Transaction not found.", 404);
    // Free-plan friendly: a pending transfer is re-checked with the bank when its owner looks at it.
    if (t.status === "pending" && t.category === "bank_transfer" && Date.now() - new Date(t.created_at).getTime() > 30_000) {
      try { await rateLimit(c.userId, "recheck", 10, 60); t = await recheck(t); } catch (e) { if (!(e instanceof AppError)) console.error("recheck", e); }
    }
    return { transaction: publicTxn(t) };
  },

  async "notifications.list"(c) {
    const rows = await q("select id, title, body, kind, read, created_at from notifications where user_id = $1 order by created_at desc limit 100", [c.userId]);
    await q("update notifications set read = true where user_id = $1 and not read", [c.userId]);
    return { notifications: rows };
  },

  async "beneficiaries.list"(c) {
    return { beneficiaries: await q("select id, account_name, account_number, bank_code, bank_name from beneficiaries where user_id = $1 order by created_at desc", [c.userId]) };
  },
  async "beneficiaries.delete"(c) {
    await q("delete from beneficiaries where id = $1 and user_id = $2", [uuid(c.b.id, "beneficiary"), c.userId]);
    return { ok: true };
  },

  "devices.list": (c) => listDevices(c),
  async "devices.revoke"(c) {
    await verifyPin(c.userId, c.b.pin, c.ip);
    return revokeDevice(c, uuid(c.b.id, "device"));
  },

  // ───────── lookups ─────────
  async "banks.list"() { return { banks: await bankProvider().listBanks() }; },

  async "name.enquiry"(c) {
    await rateLimit(c.userId, "name_enquiry", 30, 300);
    const r = await bankProvider().nameEnquiry(str(c.b.bank_code, "bank"), str(c.b.account_number, "account number", /^\d{10}$/));
    return { account_name: r.accountName };
  },

  async "tag.lookup"(c) {
    await rateLimit(c.userId, "tag_lookup", 30, 300);
    const tag = str(c.b.tag, "Kolo tag").replace(/^@/, "").toLowerCase();
    const p = await one("select id, first_name, last_name, tag from profiles where tag = $1 and kyc_status = 'verified'", [tag]);
    if (!p) throw new AppError("tag_not_found", "No Kolo user has that tag.", 404);
    if (p.id === c.userId) throw new AppError("tag_not_found", "That's your own tag.", 404);
    return { name: `${p.first_name} ${p.last_name}`, tag: p.tag };
  },

  // ───────── transfers ─────────
  async "transfer.bank"(c) {
    const amount = int(c.b.amount_kobo, "amount");
    if (amount < MIN_TRANSFER_KOBO) throw new AppError("too_small", `The minimum transfer is ${naira(MIN_TRANSFER_KOBO)}.`);
    const bankCode = str(c.b.bank_code, "bank"), bankName = str(c.b.bank_name, "bank name", undefined, 80);
    const acct = str(c.b.account_number, "account number", /^\d{10}$/);
    const idem = str(c.b.idempotency_key, "request id", /^[A-Za-z0-9-]{8,64}$/);
    const narration = cleanNarration(c.b.narration);
    await rateLimit(c.userId, "transfer", 20, 60);
    await checkLimits(c.profile, amount + FEE_BANK_KOBO);
    await verifyPin(c.userId, c.b.pin, c.ip);
    if (c.profile.otp_large && amount + FEE_BANK_KOBO >= OTP_MIN_KOBO) await requireOtp(c, "transfer", `send ${naira(amount)}`);

    const account = await myAccount(c.userId);
    if (!account) throw new AppError("no_account", "Finish setting up your account first.");
    const bank = bankProvider();
    const enq = await bank.nameEnquiry(bankCode, acct); // never trust a name sent by the app
    const reference = "KLT" + sha256(idem + c.userId).slice(0, 20).toUpperCase();
    const before = await one("select * from transactions where user_id = $1 and idempotency_key = $2", [c.userId, idem]);
    if (before) return { transaction: publicTxn(before), replay: true }; // same request sent twice
    const txn = (await one(`select * from begin_debit($1, $2, $3, 'bank_transfer', $4, $5, $6, $7)`, [
      c.userId, amount, FEE_BANK_KOBO, reference, JSON.stringify({ name: enq.accountName, bank_name: bankName, bank_code: bankCode, account_number: acct }), narration, idem,
    ]))!;

    let result: TransferResult;
    try {
      result = await bank.transfer({ reference, amountKobo: amount, bankCode, accountNumber: acct, accountName: enq.accountName, narration: narration || "Kolo transfer", senderName: `${c.profile.first_name} ${c.profile.last_name}`, senderAccountNumber: account.account_number, sessionId: enq.sessionId });
    } catch (e) {
      // Definitely not sent (bad setup or rejected input) → refund now. Unknown (timeout/5xx) → stays pending; the checker decides.
      result = e instanceof AppError && (e.status < 500 || e.code === "provider_not_configured") ? { status: "failed", reason: e.message } : { status: "pending", providerRef: "" };
      console.error("transfer error", reference, e);
    }
    const final = await finishTransfer(txn.id, result);
    if (final.status === "reversed") {
      await notify(c.userId, "Transfer failed, money returned", `Your transfer of ${naira(amount)} to ${enq.accountName} didn't go through. ${naira(amount + FEE_BANK_KOBO)} is back in your balance.`, "credit");
    } else {
      await notify(c.userId, "Debit alert", `${naira(amount + FEE_BANK_KOBO)} sent to ${enq.accountName} (${bankName}). Balance ${naira(final.balance_after_kobo)}.`, "debit");
      if (c.b.save_beneficiary) {
        await q(`insert into beneficiaries (user_id, account_name, account_number, bank_code, bank_name) values ($1, $2, $3, $4, $5)
                 on conflict (user_id, bank_code, account_number) do update set account_name = excluded.account_name`, [c.userId, enq.accountName, acct, bankCode, bankName]);
      }
    }
    await audit(c.userId, "transfer.bank", { reference, amount, status: final.status }, c.ip);
    return { transaction: publicTxn(final) };
  },

  async "transfer.kolo"(c) {
    const amount = int(c.b.amount_kobo, "amount");
    const tag = str(c.b.tag, "Kolo tag").replace(/^@/, "").toLowerCase();
    const idem = str(c.b.idempotency_key, "request id", /^[A-Za-z0-9-]{8,64}$/);
    await rateLimit(c.userId, "transfer", 20, 60);
    await checkLimits(c.profile, amount);
    await verifyPin(c.userId, c.b.pin, c.ip);
    if (c.profile.otp_large && amount >= OTP_MIN_KOBO) await requireOtp(c, "transfer", `send ${naira(amount)} to @${tag}`);
    const to = await one("select id, first_name, last_name from profiles where tag = $1 and kyc_status = 'verified'", [tag]);
    if (!to) throw new AppError("tag_not_found", "No Kolo user has that tag.", 404);
    const reference = "KLK" + sha256(idem + c.userId).slice(0, 20).toUpperCase();
    const before = await one("select id from transactions where user_id = $1 and idempotency_key = $2", [c.userId, idem]);
    const txn = (await one("select * from internal_transfer($1, $2, $3, $4, $5, $6)", [c.userId, to.id, amount, reference, cleanNarration(c.b.narration), idem]))!;
    if (!before) {
      await notify(c.userId, "Debit alert", `${naira(amount)} sent to ${to.first_name} ${to.last_name} (@${tag}). Balance ${naira(txn.balance_after_kobo)}.`, "debit");
      await notify(to.id, "Credit alert", `${c.profile.first_name} ${c.profile.last_name} (@${c.profile.tag}) sent you ${naira(amount)}.`, "credit");
      await audit(c.userId, "transfer.kolo", { reference, amount, to: to.id }, c.ip);
    }
    return { transaction: publicTxn(txn) };
  },

  // ───────── security centre ─────────
  // Freezing needs no PIN on purpose: if your phone is stolen, speed matters.
  async "security.freeze"(c) {
    await q("update profiles set frozen = true where id = $1", [c.userId]);
    await q("update accounts set status = 'frozen' where user_id = $1", [c.userId]);
    await audit(c.userId, "security.frozen", {}, c.ip);
    await notify(c.userId, "Account frozen", "All outgoing payments are blocked. Money can still come in.", "security");
    return { frozen: true };
  },

  async "security.unfreeze"(c) {
    // If our team froze the account, only our team can lift it.
    const last = await one("select action from audit_log where user_id = $1 and action in ('admin.frozen', 'admin.unfrozen') order by created_at desc limit 1", [c.userId]);
    if (last?.action === "admin.frozen") throw new AppError("admin_hold", "Our team placed a hold on this account. Contact support to lift it.", 403);
    await verifyPin(c.userId, c.b.pin, c.ip);
    await requireOtp(c, "unfreeze", "unfreeze your account");
    await q("update profiles set frozen = false where id = $1", [c.userId]);
    await q("update accounts set status = 'active' where user_id = $1", [c.userId]);
    await audit(c.userId, "security.unfrozen", {}, c.ip);
    await notify(c.userId, "Account unfrozen", "You can send money again.", "security");
    return { frozen: false };
  },

  async "security.limit"(c) {
    const v = int(c.b.daily_limit_kobo, "limit");
    const tier = (await one("select daily_kobo from tiers where tier = $1", [c.profile.tier]))!;
    if (v > tier.daily_kobo) throw new AppError("over_tier", `Your account level allows up to ${naira(tier.daily_kobo)} a day.`);
    const current = c.profile.daily_limit_kobo ?? tier.daily_kobo;
    if (v > current) {
      await verifyPin(c.userId, c.b.pin, c.ip);
      await requireOtp(c, "limit_raise", "raise your daily limit");
    }
    await q("update profiles set daily_limit_kobo = $2 where id = $1", [c.userId, v]);
    await audit(c.userId, "security.limit", { from: current, to: v }, c.ip);
    return { daily_limit_kobo: v };
  },

  async "security.otp_large"(c) {
    const on = !!c.b.on;
    if (!on) {
      await verifyPin(c.userId, c.b.pin, c.ip);
      await requireOtp(c, "otp_off", "turn off codes for big transfers");
    }
    await q("update profiles set otp_large = $2 where id = $1", [c.userId, on]);
    await audit(c.userId, "security.otp_large", { on }, c.ip);
    return { otp_large: on };
  },

  async "prefs.update"(c) {
    if (typeof c.b.pidgin !== "boolean") throw new AppError("bad_input", "Nothing to update.");
    await q("update profiles set pidgin = $2 where id = $1", [c.userId, c.b.pidgin]);
    return { pidgin: c.b.pidgin };
  },

  // ───────── admin (profiles.is_admin, or phone listed in ADMIN_PHONES) ─────────
  async "admin.overview"(c) {
    adminOnly(c);
    const [users, verified, pending, mism, sums, vol] = await Promise.all([
      one<{ n: number }>("select count(*) as n from profiles"),
      one<{ n: number }>("select count(*) as n from profiles where kyc_status = 'verified'"),
      one<{ n: number }>("select count(*) as n from transactions where status = 'pending'"),
      one<{ n: number }>("select count(*) as n from ledger_mismatches"),
      q<{ kind: string; total_kobo: number }>("select kind, coalesce(sum(balance_kobo), 0)::bigint as total_kobo from accounts group by kind"),
      q<{ direction: string; total_kobo: number }>(`select direction, coalesce(sum(amount_kobo), 0)::bigint as total_kobo from transactions where status = 'successful' and created_at > now() - interval '24 hours' group by direction`),
    ]);
    const sum = (k: string) => sums.find((s) => s.kind === k)?.total_kobo ?? 0;
    const v = (d: string) => vol.find((x) => x.direction === d)?.total_kobo ?? 0;
    return {
      users: users?.n ?? 0, verified: verified?.n ?? 0, pending_transfers: pending?.n ?? 0, ledger_mismatches: mism?.n ?? 0,
      customer_balances_kobo: sum("customer"), fee_income_kobo: sum("fees"), in_flight_kobo: sum("suspense"),
      volume_24h_in_kobo: v("credit"), volume_24h_out_kobo: v("debit"), sandbox: isSandbox(),
    };
  },

  async "admin.users"(c) {
    adminOnly(c);
    const term = typeof c.b.q === "string" ? c.b.q.replace(/^@/, "").replace(/[%_\\]/g, "").slice(0, 40) : "";
    const users = await q(
      `select id, first_name, last_name, tag, phone, tier, kyc_status, frozen, created_at from profiles
        where $1 = '' or tag ilike '%' || $1 || '%' or phone ilike '%' || $1 || '%' or first_name ilike '%' || $1 || '%' or last_name ilike '%' || $1 || '%'
        order by created_at desc limit 50`,
      [term],
    );
    return { users };
  },

  async "admin.transactions"(c) {
    adminOnly(c);
    const status = ["pending", "successful", "failed", "reversed"].includes(c.b.status) ? c.b.status : null;
    const rows = await q(
      `select t.${TXN_COLS.split(", ").join(", t.")}, p.first_name, p.last_name, p.tag
         from transactions t left join profiles p on p.id = t.user_id
        where ($1::txn_status is null or t.status = $1::txn_status) order by t.created_at desc limit 100`,
      [status],
    );
    return { transactions: rows };
  },

  async "admin.freeze"(c) {
    adminOnly(c);
    const id = uuid(c.b.user_id, "user"), frozen = !!c.b.frozen;
    await q("update profiles set frozen = $2 where id = $1", [id, frozen]);
    await q("update accounts set status = $2 where user_id = $1", [id, frozen ? "frozen" : "active"]);
    await audit(id, frozen ? "admin.frozen" : "admin.unfrozen", { reason: cleanNarration(c.b.reason) }, c.ip, `admin:${c.userId}`);
    await notify(id, frozen ? "Account on hold" : "Hold removed", frozen ? "Our team placed a temporary hold on your account. Contact support." : "You can use your account normally again.", "security");
    return { frozen };
  },

  async "admin.requery"(c) {
    adminOnly(c);
    const t = await one("select * from transactions where id = $1", [uuid(c.b.txn_id, "transaction")]);
    if (!t || t.status !== "pending") throw new AppError("not_pending", "Only pending transfers can be re-checked.");
    return { transaction: publicTxn(await recheck(t, `admin:${c.userId}`)) };
  },

  // Test money, for test mode only. Refuses to run in production.
  async "admin.test_deposit"(c) {
    adminOnly(c);
    if (!isSandbox()) throw new AppError("forbidden", "Test deposits are disabled in production.", 403);
    const amount = int(c.b.amount_kobo, "amount");
    const acct = str(c.b.account_number, "account number", /^\d{10}$/);
    const txn = (await one("select * from credit_deposit($1, $2, $3, $4, $5)", [
      acct, amount, "TEST-" + randomUUID(), JSON.stringify({ name: "Kolo Test Funding", bank_name: "Test" }), "Test deposit",
    ]))!;
    await notify(txn.user_id, "Credit alert", `${naira(amount)} test deposit received. Balance ${naira(txn.balance_after_kobo)}.`, "credit");
    await audit(txn.user_id, "admin.test_deposit", { amount }, c.ip, `admin:${c.userId}`);
    return { transaction: publicTxn(txn) };
  },
};

function adminOnly(c: C) { if (!c.profile.is_admin) throw new AppError("forbidden", "Admins only.", 403); }

// Actions that work before signing in.
const PUBLIC: Record<string, (b: Record<string, any>, req: Request) => Promise<unknown>> = {
  "auth.start": (b, req) => startLogin(b.phone, req),
  "auth.verify": (b, req) => verifyLogin(b, req),
};

export async function route(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new AppError("method", "Use POST.", 405);
  const b = await readJson<Record<string, any>>(req);
  const name = String(b.action ?? "");
  if (PUBLIC[name]) return json(await PUBLIC[name](b, req));
  const fn = actions[name];
  if (!fn) throw new AppError("unknown_action", "Unknown action.", 404);
  const ctx = await requireSession(req);
  return json((await fn({ ...ctx, b })) ?? { ok: true });
}

