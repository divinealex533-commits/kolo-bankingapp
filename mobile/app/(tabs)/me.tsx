import React, { useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Card, Divider, Field, H2, Note, Row, Screen } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { naira } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export default function Me() {
  const c = useColors();
  const { me, refresh, signOut } = useSession();
  const [nin, setNin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me) return null;
  const p = me.profile, next = me.tiers.find((t) => t.tier === p.tier + 1);
  const daily = Math.min(me.tier.daily_kobo, p.daily_limit_kobo ?? Number.MAX_SAFE_INTEGER);

  async function upgrade() {
    setBusy(true); setErr(null);
    try { await api("kyc.upgrade", { nin }); await refresh(); setNin(""); Alert.alert("Upgraded", "You're now on Tier 2. Your limits went up."); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  return (
    <Screen title="Me" back={false}>
      <Card style={{ padding: 16, flexDirection: "row", alignItems: "center", gap: 14 }}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: c.accent, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: c.accentInk, fontWeight: "800", fontSize: 18 }}>{p.first_name[0]}{p.last_name[0]}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.ink, fontWeight: "800", fontSize: 17 }}>{p.first_name} {p.last_name}</Text>
          <Text style={{ color: c.muted }}>@{p.tag} · {p.phone}</Text>
        </View>
      </Card>

      <H2>Account level</H2>
      <Card>
        <Row title={me.tier.name} sub={`Up to ${naira(me.tier.single_kobo, { decimals: false })} per transfer`} /><Divider />
        <Row title="Your daily limit" sub={`${naira(daily, { decimals: false })} · used ${naira(me.spent_today_kobo, { decimals: false })} today`} onPress={() => router.push("/security")} />
      </Card>
      {next && p.tier === 1 ? (
        <Card style={{ padding: 16, gap: 12 }}>
          <Text style={{ color: c.ink, fontWeight: "800" }}>Upgrade to {next.name}</Text>
          <Note>Add your NIN to send up to {naira(next.single_kobo, { decimals: false })} at once.</Note>
          <Field label="NIN" value={nin} onChangeText={(v) => setNin(v.replace(/\D/g, ""))} keyboardType="number-pad" maxLength={11} secureTextEntry error={err} help="Dial *346# to get your NIN." />
          <Button title="Verify NIN" onPress={upgrade} loading={busy} disabled={nin.length !== 11} />
        </Card>
      ) : null}

      <H2>Settings</H2>
      <Card>
        <Row icon="🛡" title="Security centre" sub="PIN, limits, devices, freeze account" onPress={() => router.push("/security")} /><Divider />
        <Row icon="🔔" title="Notifications" sub="Alerts and security events" onPress={() => router.push("/notifications")} /><Divider />
        <Row icon="🇳🇬" title="Talk to me in Pidgin" sub="Coming with Phase 3" right={<Switch value={p.pidgin} onValueChange={async (v) => { await api("prefs.update", { pidgin: v }); refresh(); }} />} />
      </Card>
      <Button title="Sign out" kind="secondary" onPress={() => Alert.alert("Sign out?", "You'll need your phone number and a code to sign back in.", [{ text: "Cancel" }, { text: "Sign out", style: "destructive", onPress: signOut }])} />
      <Note>Kolo {me.sandbox ? "· test mode" : ""}</Note>
    </Screen>
  );
}
