// Re-checks transfers stuck in "pending" with the bank.
// Vercel's daily cron calls it (it sends "Authorization: Bearer CRON_SECRET" by itself).
// For every-minute checks on the free plan, point a free service such as cron-job.org at this URL with the same header.
import { AppError, handler, json } from "../../server/http";
import { env } from "../../server/db";
import { safeEqual } from "../../server/security";
import { reconcilePending } from "../../server/transfers";

const run = handler(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env("CRON_SECRET")}`)) throw new AppError("forbidden", "Forbidden", 403);
  return json(await reconcilePending());
});
export const GET = (req: Request) => run(req);
export const POST = (req: Request) => run(req);
