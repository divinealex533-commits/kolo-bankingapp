// Receives notifications from the bank: money coming in, and final status of outgoing transfers.
// Deploy WITHOUT JWT verification (the bank has no Supabase login); the signature check is the guard.
//   supabase functions deploy bank-webhook --no-verify-jwt
import { handler, json } from "../_shared/http.ts";
import { admin, audit, naira, notify } from "../_shared/db.ts";
import { bankProvider } from "../_shared/bank/index.ts";

Deno.serve(handler(async (req) => {
  const bank = bankProvider();
  const events = await bank.parseWebhook(req); // throws 401 on a bad signature

  for (const ev of events) {
    // Each event is processed at most once.
    const { error: dup } = await admin.from("webhook_events").insert({ provider: bank.id, event_id: ev.eventId, payload: ev });
    if (dup) { if (dup.code === "23505") continue; throw dup; }

    if (ev.type === "credit") {
      const { data: txn, error } = await admin.rpc("credit_deposit", {
        p_account_number: ev.accountNumber, p_amount: ev.amountKobo, p_provider_ref: ev.providerRef,
        p_counterparty: { name: ev.senderName ?? "", bank_name: ev.senderBank ?? "" }, p_narration: ev.narration ?? "",
      });
      if (error) { console.error("credit failed", ev, error); throw error; }
      await notify(txn.user_id, "Credit alert", `${naira(ev.amountKobo)} from ${ev.senderName || "a bank transfer"}${ev.senderBank ? ` (${ev.senderBank})` : ""}. Balance ${naira(txn.balance_after_kobo)}.`, "credit");
      await audit(txn.user_id, "deposit", { amount: ev.amountKobo, ref: ev.providerRef }, undefined, "system");
    }

    if (ev.type === "transfer_status") {
      const { data: t } = await admin.from("transactions").select("*").eq("reference", ev.reference).maybeSingle();
      if (t && t.status === "pending") {
        const fn = ev.status === "successful" ? "settle_debit" : "reverse_debit";
        const { data: final } = await admin.rpc(fn, ev.status === "successful" ? { p_txn: t.id, p_provider_ref: ev.providerRef } : { p_txn: t.id, p_reason: ev.reason ?? "Rejected by the receiving bank" });
        if (final?.status === "reversed") await notify(t.user_id, "Transfer failed, money returned", `${naira(t.amount_kobo + t.fee_kobo)} is back in your balance.`, "credit");
        await audit(t.user_id, "transfer.status", { reference: t.reference, status: final?.status }, undefined, "system");
      }
    }

    await admin.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("provider", bank.id).eq("event_id", ev.eventId);
  }
  return json({ ok: true });
}));
