// Runs every minute (see README: pg_cron). Finds transfers stuck in "pending" and asks the bank
// what happened, then settles or refunds them. Protected by the CRON_SECRET header.
//   supabase functions deploy reconcile --no-verify-jwt
import { AppError, handler, json } from "../_shared/http.ts";
import { admin, audit, env, naira, notify } from "../_shared/db.ts";
import { bankProvider } from "../_shared/bank/index.ts";

Deno.serve(handler(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) throw new AppError("forbidden", "Forbidden", 403);
  const bank = bankProvider();
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: stuck } = await admin.from("transactions").select("*")
    .eq("status", "pending").eq("category", "bank_transfer").lt("created_at", cutoff).order("created_at").limit(50);

  const results: Record<string, string> = {};
  for (const t of stuck ?? []) {
    try {
      const r = await bank.transferStatus(t.reference);
      if (r.status === "successful") {
        await admin.rpc("settle_debit", { p_txn: t.id, p_provider_ref: r.providerRef });
        results[t.reference] = "settled";
      } else if (r.status === "failed") {
        await admin.rpc("reverse_debit", { p_txn: t.id, p_reason: r.reason });
        await notify(t.user_id, "Transfer failed, money returned", `${naira(t.amount_kobo + t.fee_kobo)} is back in your balance.`, "credit");
        results[t.reference] = "reversed";
      } else {
        const ageH = (Date.now() - new Date(t.created_at).getTime()) / 3_600_000;
        if (ageH > 24) await audit(t.user_id, "transfer.stuck", { reference: t.reference, hours: Math.round(ageH) }, undefined, "system");
        results[t.reference] = "still pending";
      }
    } catch (e) {
      console.error("reconcile", t.reference, e);
      results[t.reference] = "error";
    }
  }
  return json({ checked: stuck?.length ?? 0, results });
}));
