// The bank calls this when money arrives or a transfer finishes. Its signature is checked before anything happens.
import { handler, json } from "../server/http";
import { audit, naira, notify, one, q } from "../server/db";
import { bankProvider } from "../server/bank";
import { finishTransfer } from "../server/transfers";

export const POST = handler(async (req) => {
  const bank = bankProvider();
  const events = await bank.parseWebhook(req); // throws 401 on a bad signature

  for (const ev of events) {
    // Each event is processed at most once.
    const fresh = await q(
      "insert into webhook_events (provider, event_id, payload) values ($1, $2, $3) on conflict (provider, event_id) do nothing returning id",
      [bank.id, ev.eventId, JSON.stringify(ev)],
    );
    if (!fresh.length) continue;

    if (ev.type === "credit") {
      const txn = (await one("select * from credit_deposit($1, $2, $3, $4, $5)", [
        ev.accountNumber, ev.amountKobo, ev.providerRef, JSON.stringify({ name: ev.senderName ?? "", bank_name: ev.senderBank ?? "" }), ev.narration ?? "",
      ]))!;
      await notify(txn.user_id, "Credit alert", `${naira(ev.amountKobo)} from ${ev.senderName || "a bank transfer"}${ev.senderBank ? ` (${ev.senderBank})` : ""}. Balance ${naira(txn.balance_after_kobo)}.`, "credit");
      await audit(txn.user_id, "deposit", { amount: ev.amountKobo, ref: ev.providerRef }, null, "system");
    }

    if (ev.type === "transfer_status") {
      const t = await one("select * from transactions where reference = $1", [ev.reference]);
      if (t && t.status === "pending") {
        const final = await finishTransfer(t.id, ev.status === "successful" ? { status: "successful", providerRef: ev.providerRef } : { status: "failed", reason: ev.reason ?? "Rejected by the receiving bank", providerRef: ev.providerRef });
        if (final.status === "reversed") await notify(t.user_id, "Transfer failed, money returned", `${naira(t.amount_kobo + t.fee_kobo)} is back in your balance.`, "credit");
        await audit(t.user_id, "transfer.status", { reference: t.reference, status: final.status }, null, "system");
      }
    }

    await q("update webhook_events set processed_at = now() where provider = $1 and event_id = $2", [bank.id, ev.eventId]);
  }
  return json({ ok: true });
});
