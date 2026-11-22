import React, { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Card, Divider, H2, Row, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { useColors } from "@/lib/theme";

type Ben = { id: string; account_name: string; account_number: string; bank_code: string; bank_name: string };

export default function Payments() {
  const c = useColors();
  const [bens, setBens] = useState<Ben[]>([]);
  useFocusEffect(useCallback(() => { api<{ beneficiaries: Ben[] }>("beneficiaries.list").then((r) => setBens(r.beneficiaries)).catch(() => {}); }, []));

  return (
    <Screen title="Payments" back={false}>
      <Card>
        <Row icon="🏦" title="Send to bank account" sub="Any Nigerian bank" onPress={() => router.push("/send-bank")} /><Divider />
        <Row icon="@" title="Send to Kolo tag" sub="Instant and free" onPress={() => router.push("/send-kolo")} /><Divider />
        <Row icon="↙" title="Receive money" sub="Your account number" onPress={() => router.push("/receive")} />
      </Card>
      <H2>Airtime, data & bills</H2>
      <Card><View style={{ padding: 16 }}><Text style={{ color: c.muted }}>Coming in Phase 2, together with savings goals and Break Kolo.</Text></View></Card>
      {bens.length ? (
        <>
          <H2>Saved beneficiaries</H2>
          <Card>
            {bens.map((b, i) => (
              <View key={b.id}>
                {i ? <Divider /> : null}
                <Row title={b.account_name} sub={`${b.bank_name} · ${b.account_number}`}
                  onPress={() => router.push({ pathname: "/send-bank", params: { bank_code: b.bank_code, bank_name: b.bank_name, account_number: b.account_number } })}
                  right={<Text accessibilityRole="button" onPress={() => Alert.alert("Remove beneficiary?", b.account_name, [{ text: "Cancel" }, { text: "Remove", style: "destructive", onPress: async () => { await api("beneficiaries.delete", { id: b.id }); setBens((x) => x.filter((y) => y.id !== b.id)); } }])} style={{ color: c.muted, fontSize: 18, padding: 6 }}>✕</Text>} />
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
