// Test bank for development. Behaves like a real partner, moves no real money.
//   Account numbers ending in 0000 → "account not found"
//   Transfers to accounts ending in 9999 → stay pending, then succeed on the next status check
//   Transfers of exactly ₦4,040 → fail (to test reversals)
import type { Bank, BankProvider, KycProvider, TransferResult, WebhookEvent } from "./types.ts";
import { AppError } from "../http.ts";
import { sha256 } from "../security.ts";

const FIRST = ["Chidi", "Amaka", "Tunde", "Ngozi", "Ibrahim", "Fatima", "Emeka", "Yetunde", "Segun", "Aisha", "Obinna", "Funmilayo", "Musa", "Halima"];
const LAST = ["Okafor", "Adeyemi", "Bello", "Eze", "Okonkwo", "Abubakar", "Balogun", "Nwosu", "Ogunleye", "Danjuma", "Lawal", "Yusuf"];
const BANKS: Bank[] = ["Access Bank", "Ecobank", "Fidelity Bank", "First Bank", "FCMB", "GTBank", "Keystone Bank", "Kuda", "Moniepoint", "Opay", "PalmPay", "Polaris Bank", "Providus Bank", "Stanbic IBTC", "Sterling Bank", "UBA", "Union Bank", "Wema Bank", "Zenith Bank"]
  .map((name, i) => ({ code: `T${String(i + 1).padStart(3, "0")}`, name })); // test codes only; real NIP codes come from 9PSB

const pending = new Map<string, number>();

function nameFor(seed: string) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h >>>= 0;
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`.toUpperCase();
}

export class MockBank implements BankProvider {
  readonly id = "mock";
  listBanks() { return Promise.resolve(BANKS); }

  async createVirtualAccount(input: { userId: string; firstName: string; lastName: string }) {
    const digits = (await sha256(input.userId)).replace(/\D/g, "").padEnd(9, "7").slice(0, 9);
    return { accountNumber: "9" + digits, accountName: `${input.firstName} ${input.lastName}`.toUpperCase(), bankName: "Kolo Test Bank", providerRef: "MOCK-" + input.userId };
  }

  nameEnquiry(bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new AppError("bad_account", "Account numbers have 10 digits.");
    if (accountNumber.endsWith("0000")) throw new AppError("account_not_found", "We couldn't find that account. Check the number and bank.", 404);
    return Promise.resolve({ accountName: nameFor(bankCode + accountNumber), sessionId: "MOCKSESSION" + Date.now() });
  }

  transfer(input: { reference: string; amountKobo: number; accountNumber: string }): Promise<TransferResult> {
    const providerRef = "MOCKTX" + input.reference;
    if (input.amountKobo === 404000) return Promise.resolve({ status: "failed", reason: "Beneficiary bank unavailable", providerRef });
    if (input.accountNumber.endsWith("9999")) { pending.set(input.reference, Date.now()); return Promise.resolve({ status: "pending", providerRef }); }
    return Promise.resolve({ status: "successful", providerRef });
  }

  transferStatus(reference: string): Promise<TransferResult> {
    pending.delete(reference);
    return Promise.resolve({ status: "successful", providerRef: "MOCKTX" + reference });
  }

  // Test webhooks are signed with HMAC-SHA256 of the raw body using MOCK_WEBHOOK_SECRET,
  // sent in the x-kolo-signature header. Body: { id, type: "credit", account_number, amount_kobo, ref, sender_name }
  async parseWebhook(req: Request): Promise<WebhookEvent[]> {
    const raw = await req.text();
    const secret = Deno.env.get("MOCK_WEBHOOK_SECRET");
    if (!secret) throw new AppError("not_configured", "MOCK_WEBHOOK_SECRET is not set.", 500);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (sig !== req.headers.get("x-kolo-signature")) throw new AppError("bad_signature", "Invalid signature.", 401);
    const b = JSON.parse(raw);
    if (b.type === "credit") return [{ type: "credit", eventId: b.id, accountNumber: b.account_number, amountKobo: Number(b.amount_kobo), providerRef: b.ref, senderName: b.sender_name, senderBank: b.sender_bank, narration: b.narration }];
    return [{ type: "ignored", eventId: b.id }];
  }
}

export class MockKyc implements KycProvider {
  readonly id = "mock";
  // Test rule: BVN/NIN starting with 0 fails, anything else (11 digits) matches.
  verifyBvn(input: { bvn: string }) {
    if (!/^\d{11}$/.test(input.bvn)) return Promise.resolve({ match: false, reason: "A BVN has 11 digits." });
    return Promise.resolve(input.bvn.startsWith("0") ? { match: false, reason: "The details don't match this BVN." } : { match: true });
  }
  verifyNin(input: { nin: string }) {
    if (!/^\d{11}$/.test(input.nin)) return Promise.resolve({ match: false, reason: "A NIN has 11 digits." });
    return Promise.resolve(input.nin.startsWith("0") ? { match: false, reason: "The details don't match this NIN." } : { match: true });
  }
}
