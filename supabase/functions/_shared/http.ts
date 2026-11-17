// Shared HTTP helpers: CORS, JSON responses, and one error type the app can rely on.

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-device-name, x-idempotency-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Database errors raised by our SQL functions, mapped to messages people can act on.
const DB_ERRORS: Record<string, [number, string]> = {
  insufficient_funds: [400, "You don't have enough money for this. Your balance didn't change."],
  account_frozen: [403, "Your account is frozen. Unfreeze it in Security to send money."],
  no_account: [400, "Finish setting up your account first."],
  recipient_unavailable: [400, "That Kolo account can't receive money right now."],
  same_account: [400, "You can't send money to yourself."],
  invalid_amount: [400, "Enter an amount greater than zero."],
  account_not_found: [404, "Account not found."],
};

export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
      const msg = String((e as { message?: string })?.message ?? e);
      for (const [code, [status, message]] of Object.entries(DB_ERRORS)) {
        if (msg.includes(code)) return json({ error: { code, message } }, status);
      }
      console.error("unhandled", e);
      return json({ error: { code: "server_error", message: "Something went wrong on our side. No money moved. Try again." } }, 500);
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return await req.json() as T; } catch { throw new AppError("bad_request", "The request body must be JSON."); }
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
