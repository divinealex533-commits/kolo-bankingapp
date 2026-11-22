// 9PSB adapter — fill this in from the API documentation 9PSB gives you.
//
// 9PSB shares its wallet / virtual-account / transfer API privately with partners, so the
// exact URLs, auth scheme and field names are NOT guessed here. Each method below says what
// it must do and what it must return; map 9PSB's request and response onto that.
//
// Secrets (Vercel → Project → Settings → Environment Variables, never in code or in the app):
//   NINEPSB_BASE_URL, NINEPSB_CLIENT_ID, NINEPSB_CLIENT_SECRET (or API key), NINEPSB_WEBHOOK_SECRET
//
// Checklist when the docs arrive:
//   [ ] auth: how to get/refresh an access token (cache it in memory until it expires)
//   [ ] create wallet / virtual account for a customer (needs BVN + DOB + phone)
//   [ ] bank list with NIP codes
//   [ ] name enquiry (returns a session id that the transfer must reuse)
//   [ ] outbound transfer (send our `reference` as their merchant/client reference)
//   [ ] transfer status requery by our reference
//   [ ] inbound credit webhook + how it is signed; outbound transfer status webhook
//   [ ] their sandbox test accounts and test BVNs
import type { BankProvider, Bank, TransferResult, VirtualAccount, WebhookEvent } from "./types";
import { AppError } from "../http";

const notReady = (what: string): never => {
  throw new AppError("provider_not_configured", `9PSB ${what} isn't connected yet. Set BANK_PROVIDER=mock until the 9PSB integration is finished.`, 503);
};

export class NinePSB implements BankProvider {
  readonly id = "9psb";
  private base = process.env.NINEPSB_BASE_URL ?? "";
  private token: { value: string; exp: number } | null = null;

  // Shared request helper. Adjust headers/auth to match the docs.
  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!this.base) notReady("API URL");
    const res = await fetch(this.base + path, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await this.accessToken()}` },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) { console.error("9psb error", path, res.status, text.slice(0, 500)); throw new AppError("bank_error", "The bank didn't respond properly. No money moved.", 502); }
    return JSON.parse(text) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 30_000) return this.token.value;
    // TODO(9psb): request a token with NINEPSB_CLIENT_ID / NINEPSB_CLIENT_SECRET and set this.token.
    return notReady("authentication");
  }

  listBanks(): Promise<Bank[]> {
    // TODO(9psb): call the bank-list endpoint and map to { code, name }. Cache for a day.
    return notReady("bank list");
  }

  createVirtualAccount(_i: { userId: string; firstName: string; lastName: string; phone: string; bvn: string; dob: string }): Promise<VirtualAccount> {
    // TODO(9psb): open a wallet for the customer and return its NUBAN account number.
    // Use userId as the external/customer reference so retries don't create duplicates.
    return notReady("account opening");
  }

  nameEnquiry(_bankCode: string, _accountNumber: string): Promise<{ accountName: string; sessionId?: string }> {
    // TODO(9psb): name enquiry. Return the official account name and the session id.
    return notReady("name enquiry");
  }

  transfer(_i: { reference: string; amountKobo: number; bankCode: string; accountNumber: string; accountName: string; narration: string; senderName: string; senderAccountNumber: string; sessionId?: string }): Promise<TransferResult> {
    // TODO(9psb): send the transfer. Amount is in kobo here — convert if their API wants naira.
    // Map their response codes: success → "successful", processing/timeout → "pending", definite failure → "failed".
    // IMPORTANT: on a network timeout, return "pending", never "failed" — the reconcile job will requery.
    return notReady("transfers");
  }

  transferStatus(_reference: string): Promise<TransferResult> {
    // TODO(9psb): requery a transfer by our reference.
    return notReady("transfer status");
  }

  parseWebhook(_req: Request): Promise<WebhookEvent[]> {
    // TODO(9psb): verify the signature with NINEPSB_WEBHOOK_SECRET exactly as their docs say,
    // then map inbound credits to { type: "credit", ... } and transfer updates to { type: "transfer_status", ... }.
    // Throw AppError("bad_signature", ..., 401) if verification fails.
    return notReady("webhooks");
  }
}
