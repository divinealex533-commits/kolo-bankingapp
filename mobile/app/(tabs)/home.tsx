import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Card, Divider, H2, Note } from "@/components/ui";
import { TxnRow, Txn } from "@/components/TxnRow";
import { fmtAcct, naira } from "@/lib/money";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export default function Home() {
  const c = useColors();
  const { me, refresh } = useSession();
  const [txns, setTxns] = useState<Txn[]>([]);
  const [hide, setHide] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [r] = await Promise.all([api<{ transactions: Txn[] }>("transactions.list", { limit: 6 }).catch(() => ({ transactions: [] })), refresh()]);
    setTxns(r.transactions);
  }, [refresh]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!me) return null;
  const unread = me.unread_count;
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const acct = me.account;
  const Q = ({ label, glyph, to }: { label: string; glyph: string; to: string }) => (
    <Pressable accessibilityRole="button" onPress={() => router.push(to as never)} style={st.q}>
      <View style={[st.qi, { backgroundColor: c.surface, borderColor: c.line }]}><Text style={{ fontSize: 20, color: c.link }}>{glyph}</Text></View>
      <Text style={{ color: c.ink, fontSize: 12, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {me.sandbox ? <Text style={[st.pill, { color: c.muted, borderColor: c.line, backgroundColor: c.surface2 }]}>TEST MODE · NO REAL MONEY</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={[st.avatar, { backgroundColor: c.accent }]}><Text style={{ color: c.accentInk, fontWeight: "800" }}>{me.profile.first_name[0]}{me.profile.last_name[0]}</Text></View>
          <View style={{ flex: 1 }}><Text style={{ color: c.muted, fontSize: 13 }}>{greet}</Text><Text style={{ color: c.ink, fontSize: 19, fontWeight: "800" }}>{me.profile.first_name}</Text></View>
          <Pressable accessibilityLabel={`Notifications, ${unread} unread`} onPress={() => router.push("/notifications")} style={[st.bell, { backgroundColor: c.surface, borderColor: c.line }]}>
            <Text style={{ fontSize: 18 }}>🔔</Text>
            {unread ? <View style={[st.badge, { backgroundColor: c.neg }]}><Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{unread}</Text></View> : null}
          </Pressable>
        </View>

        {me.profile.frozen ? (
          <Pressable onPress={() => router.push("/security")} style={[st.alert, { backgroundColor: c.neg }]}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>🧊 Your account is frozen. Outgoing payments are blocked. Tap to manage.</Text>
          </Pressable>
        ) : null}

        <View style={[st.bal, { backgroundColor: c.brand }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: c.onBrand, opacity: 0.85 }}>Available balance</Text>
            <Pressable accessibilityLabel={hide ? "Show balance" : "Hide balance"} onPress={() => setHide(!hide)}><Text style={{ color: c.onBrand }}>{hide ? "🙈" : "👁"}</Text></Pressable>
          </View>
          <Text style={{ color: c.onBrand, fontSize: 36, fontWeight: "800", letterSpacing: -0.8 }}>{hide ? "₦ ••••••" : naira(acct?.balance_kobo ?? 0)}</Text>
          <Pressable onPress={async () => { if (!acct) return; await Clipboard.setStringAsync(acct.account_number); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            <Text style={{ color: c.onBrand, opacity: 0.9 }}>{acct?.bank_name} · {fmtAcct(acct?.account_number)}  {copied ? "✓ Copied" : "⧉ Copy"}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable onPress={() => router.push("/receive")} style={[st.bb, { backgroundColor: c.onBrand }]}><Text style={{ color: c.brand2, fontWeight: "800" }}>＋ Add money</Text></Pressable>
            <Pressable onPress={() => router.push("/send-bank")} style={[st.bb, { backgroundColor: "rgba(255,255,255,.15)" }]}><Text style={{ color: c.onBrand, fontWeight: "800" }}>↗ Send</Text></Pressable>
          </View>
        </View>

        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Q label="Kolo tag" glyph="@" to="/send-kolo" />
          <Q label="To bank" glyph="🏦" to="/send-bank" />
          <Q label="Receive" glyph="↙" to="/receive" />
          <Q label="Security" glyph="🛡" to="/security" />
        </View>

        <H2>Recent activity</H2>
        <Card>
          {txns.length ? txns.map((t, i) => <View key={t.id}>{i ? <Divider /> : null}<TxnRow t={t} hide={hide} /></View>) :
            <View style={{ padding: 20 }}><Note>No transactions yet. Add money to your account number to get started.</Note></View>}
        </Card>
        {txns.length ? <Pressable onPress={() => router.push("/history")}><Text style={{ color: c.link, fontWeight: "700", textAlign: "center" }}>See all transactions</Text></Pressable> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  pill: { alignSelf: "center", fontSize: 11, fontWeight: "800", letterSpacing: 1, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden" },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  bell: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  alert: { padding: 14, borderRadius: 14 },
  bal: { borderRadius: 22, padding: 20, gap: 12 },
  bb: { flex: 1, paddingVertical: 13, borderRadius: 14, alignItems: "center" },
  q: { alignItems: "center", gap: 6, width: "23%" },
  qi: { width: 54, height: 54, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
