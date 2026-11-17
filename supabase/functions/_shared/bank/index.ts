import type { BankProvider, KycProvider } from "./types.ts";
import { MockBank, MockKyc } from "./mock.ts";
import { NinePSB } from "./ninepsb.ts";

// BANK_PROVIDER=mock (default) or 9psb. KYC_PROVIDER=mock (default); add a real one (9PSB, Dojah, Prembly…) later.
let bank: BankProvider | null = null;
let kyc: KycProvider | null = null;

export function bankProvider(): BankProvider {
  if (bank) return bank;
  const id = Deno.env.get("BANK_PROVIDER") ?? "mock";
  if (id === "9psb") bank = new NinePSB();
  else {
    if ((Deno.env.get("KOLO_ENV") ?? "sandbox") === "production") throw new Error("The test bank cannot run in production. Set BANK_PROVIDER=9psb.");
    bank = new MockBank();
  }
  return bank;
}

export function kycProvider(): KycProvider {
  if (kyc) return kyc;
  const id = Deno.env.get("KYC_PROVIDER") ?? "mock";
  if (id !== "mock") throw new Error(`KYC provider "${id}" isn't implemented yet.`);
  if ((Deno.env.get("KOLO_ENV") ?? "sandbox") === "production") throw new Error("Mock KYC cannot run in production.");
  kyc = new MockKyc();
  return kyc;
}

export type { Bank, BankProvider, KycProvider, TransferResult, WebhookEvent } from "./types.ts";
