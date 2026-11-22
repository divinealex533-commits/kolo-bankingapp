// Every banking partner (9PSB, the test bank, any future one) implements this interface.
// The rest of Kolo only talks to these methods, so switching partners never touches app logic.

export type Bank = { code: string; name: string };

export type VirtualAccount = { accountNumber: string; accountName: string; bankName: string; providerRef: string };

export type TransferResult =
  | { status: "successful"; providerRef: string }
  | { status: "pending"; providerRef: string }               // bank accepted it, final answer comes later
  | { status: "failed"; reason: string; providerRef?: string };

export type WebhookEvent =
  | { type: "credit"; eventId: string; accountNumber: string; amountKobo: number; providerRef: string; senderName?: string; senderBank?: string; narration?: string }
  | { type: "transfer_status"; eventId: string; reference: string; providerRef: string; status: "successful" | "failed"; reason?: string }
  | { type: "ignored"; eventId: string };

export interface BankProvider {
  readonly id: string;
  listBanks(): Promise<Bank[]>;
  createVirtualAccount(input: { userId: string; firstName: string; lastName: string; phone: string; bvn: string; dob: string }): Promise<VirtualAccount>;
  nameEnquiry(bankCode: string, accountNumber: string): Promise<{ accountName: string; sessionId?: string }>;
  transfer(input: {
    reference: string; amountKobo: number; bankCode: string; accountNumber: string; accountName: string;
    narration: string; senderName: string; senderAccountNumber: string; sessionId?: string;
  }): Promise<TransferResult>;
  transferStatus(reference: string): Promise<TransferResult>;
  // Must verify the signature and throw if it's not genuinely from the bank.
  parseWebhook(req: Request): Promise<WebhookEvent[]>;
}

export type KycResult = { match: boolean; firstName?: string; lastName?: string; reason?: string };
export interface KycProvider {
  readonly id: string;
  verifyBvn(input: { bvn: string; firstName: string; lastName: string; dob: string; phone: string }): Promise<KycResult>;
  verifyNin(input: { nin: string; firstName: string; lastName: string; dob: string }): Promise<KycResult>;
}
