import type { BankProvider, KycProvider } from "./types";
import { MockBank, MockKyc } from "./mock";
import { NinePSB } from "./ninepsb";

// BANK_PROVIDER=mock (default) or 9psb. KYC_PROVIDER=mock (default); add a real one (9PSB, Dojah, Prembly…) later.
let bank: BankProvider | null = null;
let kyc: KycProvider | null = null;
const production = () => (process.env.KOLO_ENV ?? "sandbox") === "production";

export function bankProvider(): BankProvider {
  if (bank) return bank;
  if ((process.env.BANK_PROVIDER ?? "mock") === "9psb") bank = new NinePSB();
  else {
    if (production()) throw new Error("The test bank cannot run in production. Set BANK_PROVIDER=9psb.");
    bank = new MockBank();
  }
  return bank;
}

export function kycProvider(): KycProvider {
  if (kyc) return kyc;
  const id = process.env.KYC_PROVIDER ?? "mock";
  if (id !== "mock") throw new Error(`KYC provider "${id}" isn't implemented yet.`);
  if (production()) throw new Error("Mock KYC cannot run in production.");
  kyc = new MockKyc();
  return kyc;
}

export type { Bank, BankProvider, KycProvider, TransferResult, WebhookEvent } from "./types";
