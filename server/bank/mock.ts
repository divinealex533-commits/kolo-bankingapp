// Test bank for development. Behaves like a real partner, moves no real money.
//   Account numbers ending in 0000 → "account not found"
//   Transfers to accounts ending in 9999 → "pending", then successful when re-checked
//   Transfers of exactly ₦4,040 → fail (to test refunds)
import type { Bank, BankProvider, KycProvider, TransferResult, WebhookEvent } from "./types";
import { AppError } from "../http";
import { env } from "../db";
import { hmacSha256, safeEqual, sha256 } from "../security";

const FIRST = ["Chidi", "Amaka", "Tunde", "Ngozi", "Ibrahim", "Fatima", "Emeka", "Yetunde", "Segun", "Aisha", "Obinna", "Funmilayo", "Musa", "Halima"];
const LAST = ["Okafor", "Adeyemi", "Bello", "Eze", "Okonkwo", "Abubakar", "Balogun", "Nwosu", "Ogunleye", "Danjuma", "Lawal", "Yusuf"];
const BANKS: Bank[] = ["Access Bank", "Ecobank", "Fidelity Bank", "First Bank", "FCMB", "GTBank", "Keystone Bank", "Kuda", "Moniepoint", "Opay", "PalmPay", "Polaris Bank", "Providus Bank", "Stanbic IBTC", "Sterling Bank", "UBA", "Union Bank", "Wema Bank", "Zenith Bank"]
  .map((name, i) => ({ code: `T${String(i + 1).padStart(3, "0")}`, name })); // test codes only; real NIP codes come from 9PSB

function nameFor(seed: string) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h >>>= 0;
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`.toUpperCase();
}

export class MockBank implements BankProvider {
  readonly id = "mock";
  async listBanks() { return BANKS; }

  async createVirtualAccount(input: { userId: string; firstName: string; lastName: string }) {
    const digits = sha256(input.userId).replace(/\D/g, "").padEnd(9, "7").slice(0, 9);
    return { accountNumber: "9" + digits, accountName: `${input.firstName} ${input.lastName}`.toUpperCase(), bankName: "Kolo Test Bank", providerRef: "MOCK-" + input.userId };
  }

  async nameEnquiry(bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new AppError("bad_account", "Account numbers have 10 digits.");
    if (accountNumber.endsWith("0000")) throw new AppError("account_not_found", "We couldn't find that account. Check the number and bank.", 404);
    return { accountName: nameFor(bankCode + accountNumber), sessionId: "MOCKSESSION" + Date.now() };
  }

  async transfer(input: { reference: string; amountKobo: number; accountNumber: string }): Promise<TransferResult> {
    const providerRef = "MOCKTX" + input.reference;
    if (input.amountKobo === 404000) return { status: "failed", reason: "Beneficiary bank unavailable", providerRef };
    if (input.accountNumber.endsWith("9999")) return { status: "pending", providerRef };
    return { status: "successful", providerRef };
  }

  async transferStatus(reference: string): Promise<TransferResult> {
    return { status: "successful", providerRef: "MOCKTX" + reference };
  }

  // Test webhooks are signed with HMAC-SHA256 of the raw body using MOCK_WEBHOOK_SECRET,
  // sent in the x-kolo-signature header. Body: { id, type: "credit", account_number, amount_kobo, ref, sender_name }
  async parseWebhook(req: Request): Promise<WebhookEvent[]> {
    const raw = await req.text();
    const sig = req.headers.get("x-kolo-signature") ?? "";
    if (!safeEqual(hmacSha256(env("MOCK_WEBHOOK_SECRET"), raw), sig)) throw new AppError("bad_signature", "Invalid signature.", 401);
    const b = JSON.parse(raw);
    if (b.type === "credit") return [{ type: "credit", eventId: String(b.id), accountNumber: String(b.account_number), amountKobo: Number(b.amount_kobo), providerRef: String(b.ref), senderName: b.sender_name, senderBank: b.sender_bank, narration: b.narration }];
    return [{ type: "ignored", eventId: String(b.id) }];
  }
}

export class MockKyc implements KycProvider {
  readonly id = "mock";
  // Test rule: an 11-digit BVN/NIN that starts with 0 fails; anything else matches.
  async verifyBvn(input: { bvn: string }) {
    if (!/^\d{11}$/.test(input.bvn)) return { match: false, reason: "A BVN has 11 digits." };
    return input.bvn.startsWith("0") ? { match: false, reason: "The details don't match this BVN." } : { match: true };
  }
  async verifyNin(input: { nin: string }) {
    if (!/^\d{11}$/.test(input.nin)) return { match: false, reason: "A NIN has 11 digits." };
    return input.nin.startsWith("0") ? { match: false, reason: "The details don't match this NIN." } : { match: true };
  }
}
