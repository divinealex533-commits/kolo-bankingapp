// Kolo API — one function, many actions. The app calls it with { action, ...params }.
// Every money movement is checked here (PIN, one-time code, limits, rate limits) and then
// executed by the locked-down SQL functions, so a modified app can never bypass the rules.
import { AppError, body, handler, json } from "../_shared/http.ts";
import { admin, audit, checkLimits, isSandbox, naira, newReference, notify, Profile, rateLimit, requireUser } from "../_shared/db.ts";
import { assertStrongPin, createOtp, hasPin, OtpPurpose, setPin, sha256, verifyOtp, verifyPin } from "../_shared/security.ts";
import { bankProvider, kycProvider, TransferResult } from "../_shared/bank/index.ts";

const FEE_BANK_KOBO = Number(Deno.env.get("FEE_BANK_KOBO") ?? 1000);        // ₦10 per bank transfer
const OTP_MIN_KOBO = Number(Deno.env.get("OTP_MIN_KOBO") ?? 5_000_000);      // ₦50,000 and above needs a one-time code
const MIN_TRANSFER_KOBO = 10_000;                                              // ₦100

type Ctx = { user: { id: string; phone?: string }; profile: Profile; req: Request; b: Record<string, any> };
type Action = (c: Ctx) => Promise<unknown>;

const int = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError("bad_amount", `Enter a valid ${name}.`);
  return n;
};
const str = (v: unknown, name: string, re?: RegExp, max = 200) => {
  if (typeof v !== "string" || !v.trim() || v.length > max || (re && !re.test(v.trim()))) throw new AppError("bad_input", `Check the ${name} and try again.`);
  return v.trim();
};
const cleanNarration = (v: unknown) => typeof v === "string" ? v.replace(/[^\p{L}\p{N} .,'&()\-/]/gu, "").slice(0, 60) : "";

async function myAccount(userId: string) {
  const { data } = await admin.from("accounts").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

async function requireOtpIfNeeded(c: Ctx, totalKobo: number, what: string) {
  if (!c.profile.otp_large || totalKobo < OTP_MIN_KOBO) return;
  if (!c.b.otp_id) {
    const sent = await sendOtp(c, "transfer", what);
    throw new AppError("otp_required", "We sent a 6-digit code to your phone. Enter it to continue.", 401, { otp_required: true, ...sent });
  }
  await verifyOtp(c.user.id, "transfer", c.b.otp_id, c.b.otp_code);
}

async function sendOtp(c: Ctx, purpose: OtpPurpose, what: string) {
  await rateLimit(c.user.id, "otp", 5, 600);
  return await createOtp(c.user.id, c.profile.phone ?? c.user.phone ?? null, purpose, what);
}

async function finishTransfer(txnId: string, result: TransferResult) {
  if (result.status === "successful") return (await admin.rpc("settle_debit", { p_txn: txnId, p_provider_ref: result.providerRef })).data;
  if (result.status === "failed") return (await admin.rpc("reverse_debit", { p_txn: txnId, p_reason: result.reason })).data;
  if (result.providerRef) await admin.from("transactions").update({ provider_ref: result.providerRef }).eq("id", txnId).is("provider_ref", null);
  return (await admin.from("transactions").select("*").eq("id", txnId).single()).data;
}

const actions: Record<string, Action> = {
  // ───────── profile ─────────
  async me(c) {
    const [{ data: tier }, account, pinSet, { data: tiers }] = await Promise.all([
      admin.from("tiers").select("*").eq("tier", c.profile.tier).single(),
      myAccount(c.user.id), hasPin(c.user.id), admin.from("tiers").select("*").order("tier"),
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
    const age = (Date.now() - new Date(dob).getTime()) / (365.25 * 86400000);
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
    await notify(c.user.id, "Welcome to Kolo 🎉", `Your account number is ${va.accountNumber}. Share it to receive money from any bank.`, "info");
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
    const pin = str(c.b.pin, "PIN"); assertStrongPin(pin, c.profile);
    await setPin(c.user.id, pin);
    await audit(c.user.id, "pin.set", {}, c.req);
    return { ok: true };
  },

  async "pin.change"(c) {
    await verifyPin(c.user.id, c.b.old_pin, c.req);
    const pin = str(c.b.new_pin, "new PIN"); assertStrongPin(pin, c.profile);
    if (!c.b.otp_id) { const sent = await sendOtp(c, "pin_change", "change your PIN"); throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent }); }
    await verifyOtp(c.user.id, "pin_change", c.b.otp_id, c.b.otp_code);
    await setPin(c.user.id, pin);
    await audit(c.user.id, "pin.changed", {}, c.req);
    await notify(c.user.id, "PIN changed", "Your transaction PIN was changed. If this wasn't you, freeze your account now.", "security");
    return { ok: true };
  },

  async "pin.check"(c) { await rateLimit(c.user.id, "pin_check", 20, 300); await verifyPin(c.user.id, c.b.pin, c.req); return { ok: true }; },

  // ───────── lookups ─────────
  async "banks.list"() { return { banks: await bankProvider().listBanks() }; },

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
    const bankCode = str(c.b.bank_code, "bank"), bankName = str(c.b.bank_name, "bank name", undefined, 80);
    const acct = str(c.b.account_number, "account number", /^\d{10}$/);
    const idem = str(c.b.idempotency_key, "request id", /^[A-Za-z0-9-]{8,64}$/);
    const narration = cleanNarration(c.b.narration);
    await rateLimit(c.user.id, "transfer", 10, 60);
    await checkLimits(c.profile, amount + FEE_BANK_KOBO);
    await verifyPin(c.user.id, c.b.pin, c.req);
    await requireOtpIfNeeded(c, amount + FEE_BANK_KOBO, `send ${naira(amount)}`);

    const account = await myAccount(c.user.id);
    if (!account) throw new AppError("no_account", "Finish setting up your account first.");
    const bank = bankProvider();
    const enq = await bank.nameEnquiry(bankCode, acct);                // never trust the name the app sends
    const reference = newReference("KLT");
    const { data: txn, error } = await admin.rpc("begin_debit", {
      p_user: c.user.id, p_amount: amount, p_fee: FEE_BANK_KOBO, p_category: "bank_transfer", p_reference: reference,
      p_counterparty: { name: enq.accountName, bank_name: bankName, bank_code: bankCode, account_number: acct }, p_narration: narration, p_idem: idem,
    });
    if (error) throw error;
    if (txn.reference !== reference) return { transaction: txn, replay: true };   // same request sent twice

    let result: TransferResult;
    try {
      result = await bank.transfer({ reference, amountKobo: amount, bankCode, accountNumber: acct, accountName: enq.accountName, narration: narration || `Kolo transfer`, senderName: `${c.profile.first_name} ${c.profile.last_name}`, senderAccountNumber: account.account_number, sessionId: enq.sessionId });
    } catch (e) {
      // Definitely not sent (config/validation) → refund now. Unknown (timeout/5xx) → pending, reconcile decides.
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
    const purpose = str(c.b.purpose, "purpose") as OtpPurpose;
    const what: Record<string, string> = { transfer: "confirm a transfer", pin_change: "change your PIN", unfreeze: "unfreeze your account", limit_raise: "raise your daily limit", otp_off: "turn off codes for big transfers" };
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
    if (!c.b.otp_id) { const sent = await sendOtp(c, "unfreeze", "unfreeze your account"); throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent }); }
    await verifyOtp(c.user.id, "unfreeze", c.b.otp_id, c.b.otp_code);
    // If our team froze the account, only our team can lift it.
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
      if (!c.b.otp_id) { const sent = await sendOtp(c, "limit_raise", "raise your daily limit"); throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent }); }
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
      if (!c.b.otp_id) { const sent = await sendOtp(c, "otp_off", "turn off codes for big transfers"); throw new AppError("otp_required", "Enter the code we sent to your phone.", 401, { otp_required: true, ...sent }); }
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
    // Signing out every other session is the safe default when a device is removed.
    await admin.auth.admin.signOut(c.req.headers.get("Authorization")!.replace(/^Bearer\s+/i, ""), "others");
    await audit(c.user.id, "device.revoked", { id }, c.req);
    return { ok: true };
  },

  async "prefs.update"(c) {
    const patch: Record<string, unknown> = {};
    if (typeof c.b.pidgin === "boolean") patch.pidgin = c.b.pidgin;
    if (!Object.keys(patch).length) throw new AppError("bad_input", "Nothing to update.");
    await admin.from("profiles").update(patch).eq("id", c.user.id);
    return patch;
  },

  // ───────── admin (profiles.is_admin = true) ─────────
  async "admin.overview"(c) {
    adminOnly(c);
    const [users, verified, pending, mism, accts] = await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin.from("profiles").select("id", { count: "exact", head: true }).eq("kyc_status", "verified"),
      admin.from("transactions").select("id", { count: "exact", head: true }).eq("status", "pending"),
      admin.from("ledger_mismatches").select("id", { count: "exact", head: true }),
      admin.from("accounts").select("kind, balance_kobo"),
    ]);
    const sum = (k: string) => (accts.data ?? []).filter((a) => a.kind === k).reduce((s, a) => s + Number(a.balance_kobo), 0);
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: vol } = await admin.from("transactions").select("amount_kobo, direction").gte("created_at", since).eq("status", "successful");
    return {
      users: users.count, verified: verified.count, pending_transfers: pending.count, ledger_mismatches: mism.count,
      customer_balances_kobo: sum("customer"), fee_income_kobo: sum("fees"), in_flight_kobo: sum("suspense"),
      volume_24h_in_kobo: (vol ?? []).filter((t) => t.direction === "credit").reduce((s, t) => s + Number(t.amount_kobo), 0),
      volume_24h_out_kobo: (vol ?? []).filter((t) => t.direction === "debit").reduce((s, t) => s + Number(t.amount_kobo), 0),
      sandbox: isSandbox(),
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
      admin.from("audit_log").select("*").eq("user_id", id).order("created_at", { ascending: false }).limit(50),
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
  },
};

function adminOnly(c: Ctx) { if (!c.profile.is_admin) throw new AppError("forbidden", "Admins only.", 403); }

Deno.serve(handler(async (req) => {
  if (req.method !== "POST") throw new AppError("method", "Use POST.", 405);
  const b = await body<Record<string, any>>(req);
  const fn = actions[String(b.action)];
  if (!fn) throw new AppError("unknown_action", "Unknown action.", 404);
  const { user, profile } = await requireUser(req);
  return json(await fn({ user, profile, req, b }) ?? { ok: true });
}));
