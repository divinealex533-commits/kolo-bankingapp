import React, { useState } from "react";
import { Share, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Button, Card, Divider, Note, Screen } from "@/components/ui";
import { fmtAcct } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export default function Receive() {
  const c = useColors();
  const { me } = useSession();
  const [copied, setCopied] = useState(false);
  const a = me?.account;
  if (!a) return <Screen title="Receive money"><Note>Your account number appears here once your identity is verified.</Note></Screen>;
  const Row = ({ k, v, big }: { k: string; v: string; big?: boolean }) => (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, gap: 12 }}>
      <Text style={{ color: c.muted }}>{k}</Text>
      <Text style={{ color: c.ink, fontWeight: "800", fontSize: big ? 22 : 16, letterSpacing: big ? 1 : 0, flexShrink: 1, textAlign: "right" }}>{v}</Text>
    </View>
  );
  return (
    <Screen title="Receive money">
      <Note>Send money to this account from any Nigerian bank app. It lands in your Kolo balance in seconds.</Note>
      <Card>
        <Row k="Account number" v={fmtAcct(a.account_number)} big /><Divider />
        <Row k="Account name" v={a.account_name} /><Divider />
        <Row k="Bank" v={a.bank_name} />
      </Card>
      <Button title={copied ? "Copied ✓" : "Copy account number"} onPress={async () => { await Clipboard.setStringAsync(a.account_number); setCopied(true); setTimeout(() => setCopied(false), 1500); }} />
      <Button title="Share details" kind="secondary" onPress={() => Share.share({ message: `${a.account_name}\n${a.account_number}\n${a.bank_name}` })} />
      {me?.profile.tag ? <Note>Kolo users can also pay you instantly at @{me.profile.tag}.</Note> : null}
      {me?.tier.max_balance_kobo ? <Note>Your account level ({me.tier.name}) has a maximum balance. Upgrade in Me → Account level to receive larger amounts.</Note> : null}
    </Screen>
  );
}
