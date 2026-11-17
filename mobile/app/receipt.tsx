import React from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Screen } from "@/components/ui";
import { TxnDetail, useTxn } from "@/components/TxnDetail";
import { naira } from "@/lib/money";
import { useColors } from "@/lib/theme";

export default function Receipt() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTxn(id);
  const ok = t?.status === "successful", pending = t?.status === "pending";
  const head = !t ? "" : ok ? "Sent ✅" : pending ? "On its way" : "Didn't go through";
  const sub = !t ? "" : ok ? "The money has been delivered." : pending ? "The bank is processing it. We'll notify you when it lands." : "The full amount, fee included, is back in your balance.";
  return (
    <Screen title="Receipt" back={false}>
      <View style={{ alignItems: "center", gap: 8, paddingVertical: 16 }}>
        <View style={{ width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", backgroundColor: ok ? c.pos : pending ? c.accent : c.neg }}>
          <Text style={{ color: "#fff", fontSize: 34, fontWeight: "800" }}>{ok ? "✓" : pending ? "…" : "!"}</Text>
        </View>
        <Text style={{ color: c.ink, fontSize: 22, fontWeight: "800" }}>{head}</Text>
        {t ? <Text style={{ color: c.ink, fontSize: 30, fontWeight: "800" }}>{naira(t.amount_kobo)}</Text> : null}
        <Text style={{ color: c.muted, textAlign: "center" }}>{sub}</Text>
      </View>
      <TxnDetail t={t} />
      <Button title="Done" onPress={() => router.replace("/home")} />
    </Screen>
  );
}
