// Quick check that the API and database are reachable: GET /api/health
import { handler, json } from "../server/http";
import { isSandbox, one } from "../server/db";

export const GET = handler(async () => {
  const db = await one<{ v: string }>("select max(version) as v from schema_migrations");
  return json({ ok: true, database: db?.v ? `ready (${db.v})` : "connected, but the tables are missing", mode: isSandbox() ? "test" : "live" });
});
