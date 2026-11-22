// Finishing outbound transfers: settle, refund, or keep waiting — used by the API, the bank webhook and the checker.
import { audit, naira, notify, one, q, Row } from "./db";
import { bankProvider, TransferResult } from "./bank";

export async function finishTransfer(txnId: string, result: TransferResult): Promise<Row> {
  if (result.status === "successful") return (await one("select * from settle_debit($1, $2)", [txnId, result.providerRef]))!;
  if (result.status === "failed") return (await one("select * from reverse_debit($1, $2)", [txnId, result.reason]))!;
  if (result.providerRef) await q("update transactions set provider_ref = $2 where id = $1 and provider_ref is null", [txnId, result.providerRef]);
  return (await one("select * from transactions where id = $1", [txnId]))!;
}

/** Ask the bank what happened to a pending transfer and act on the answer. */
export async function recheck(t: Row, actor = "system"): Promise<Row> {
  if (t.status !== "pending" || t.category !== "bank_transfer") return t;
  const final = await finishTransfer(t.id, await bankProvider().transferStatus(t.reference));
  if (final.status === "reversed") {
    await notify(t.user_id, "Transfer failed, money returned", `${naira(t.amount_kobo + t.fee_kobo)} is back in your balance.`, "credit");
  } else if (final.status === "pending") {
    const ageH = (Date.now() - new Date(t.created_at).getTime()) / 3_600_000;
    if (ageH > 24) await audit(t.user_id, "transfer.stuck", { reference: t.reference, hours: Math.round(ageH) }, null, actor);
  }
  if (final.status !== t.status) await audit(t.user_id, "transfer.status", { reference: t.reference, status: final.status }, null, actor);
  return final;
}

/** Check every transfer that has been pending for more than a minute. */
export async function reconcilePending(limit = 50) {
  const stuck = await q(
    `select * from transactions where status = 'pending' and category = 'bank_transfer' and created_at < now() - interval '1 minute' order by created_at limit $1`,
    [limit],
  );
  const results: Record<string, string> = {};
  for (const t of stuck) {
    try { results[t.reference] = (await recheck(t)).status; }
    catch (e) { console.error("reconcile", t.reference, e); results[t.reference] = "error"; }
  }
  return { checked: stuck.length, results };
}
