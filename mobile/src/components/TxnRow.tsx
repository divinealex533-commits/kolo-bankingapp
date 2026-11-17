import React from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { naira, when } from "@/lib/money";
import { useColors } from "@/lib/theme";

export type Txn = {
  id: string; reference: string; direction: "debit" | "credit"; category: string; amount_kobo: number; fee_kobo: number;
  status: "pending" | "successful" | "failed" | "reversed"; counterparty: Record<string, string>; narration: string | null;
  created_at: string; balance_after_kobo: number | null; failure_reason: string | null;
};

export const txnTitle = (t: Txn) =>
  t.counterparty?.name || (t.category === "deposit" ? "Deposit" : t.category === "reversal" ? "Refund" : "Transaction");

const ICON: Record<string, string> = { bank_transfer: "↗", kolo_transfer: "@", deposit: "↙" };

export function TxnRow({ t, hide }: { t: Txn; hide?: boolean }) {
  const c = useColors();
  const sub = t.status === "pending" ? "Processing…" : t.status === "reversed" ? "Failed · refunded" : when(t.created_at);
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push(`/txn/${t.id}`)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: t.direction === "credit" ? c.pos : c.muted, fontSize: 17, fontWeight: "800" }}>{t.direction === "credit" ? "↙" : ICON[t.category] ?? "↗"}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: c.ink, fontWeight: "700" }}>{txnTitle(t)}</Text>
        <Text style={{ color: t.status === "pending" ? c.accent : c.muted, fontSize: 12, marginTop: 2 }}>{sub}</Text>
      </View>
      <Text style={{ color: t.direction === "credit" ? c.pos : t.status === "reversed" ? c.muted : c.ink, fontWeight: "800", textDecorationLine: t.status === "reversed" ? "line-through" : "none" }}>
        {hide ? "••••" : `${t.direction === "credit" ? "+" : "−"}${naira(t.amount_kobo)}`}
      </Text>
    </Pressable>
  );
}
