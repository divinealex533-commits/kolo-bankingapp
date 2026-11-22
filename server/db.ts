// Database access. In production this talks to Neon over HTTPS (works well on Vercel).
// Every money movement is a single call to one of the SQL functions in db/001_core.sql,
// so each one is atomic on its own.
import { neon } from "@neondatabase/serverless";

export type Row = Record<string, any>;
type Runner = (text: string, params: unknown[]) => Promise<Row[]>;

let runner: Runner | null = null;

/** Tests swap in their own runner. */
export function setQueryRunner(r: Runner) { runner = r; }

function getRunner(): Runner {
  if (runner) return runner;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Connect the Neon database to this Vercel project.");
  const sql = neon(url);
  runner = (text, params) => sql.query(text, params) as Promise<Row[]>;
  return runner;
}

// Postgres bigint arrives as a string; money columns are always safe whole numbers, so convert them.
const NUMERIC_KEYS = /(_kobo|^count|^n|_count)$/;
function normalize(row: Row): Row {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "string" && NUMERIC_KEYS.test(k) && /^-?\d+$/.test(v)) row[k] = Number(v);
  }
  return row;
}

export async function q<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await getRunner()(text, params);
  return rows.map(normalize) as T[];
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

export const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing environment variable ${k}`);
  return v;
};
export const isSandbox = () => (process.env.KOLO_ENV ?? "sandbox") === "sandbox";

export const naira = (kobo: number) =>
  "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function audit(userId: string | null, action: string, meta: Record<string, unknown> = {}, ip: string | null = null, actor = "user") {
  await q("insert into audit_log (user_id, action, meta, ip, actor) values ($1, $2, $3, $4, $5)", [userId, action, JSON.stringify(meta), ip, actor]);
}

export async function notify(userId: string, title: string, body: string, kind: "credit" | "debit" | "security" | "info" = "info") {
  await q("insert into notifications (user_id, title, body, kind) values ($1, $2, $3, $4)", [userId, title, body, kind]);
  // Phase 3: also send a push notification to the user's phone.
}
