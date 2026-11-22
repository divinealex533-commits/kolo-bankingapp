import React, { useCallback, useEffect, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Card, Chip, Divider, H2, Note, Row, Screen } from "@/components/ui";
import { useAuthorize } from "@/components/Authorize";
import { api, ApiError } from "@/lib/api";
import { naira, when } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

type Device = { id: string; name: string; last_seen: string; current: boolean };

export default function Security() {
  const c = useColors();
  const { me, refresh } = useSession();
  const authorize = useAuthorize();
  const [devices, setDevices] = useState<Device[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const loadDevices = useCallback(() => { api<{ devices: Device[] }>("devices.list").then((r) => setDevices(r.devices)).catch(() => {}); }, []);
  useEffect(loadDevices, [loadDevices]);
  if (!me) return null;
  const p = me.profile, tierMax = me.tier.daily_kobo, current = Math.min(tierMax, p.daily_limit_kobo ?? tierMax);
  const presets = [2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000, 500_000_000].filter((v) => v < tierMax).concat(tierMax);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setErr(null);
    try { await fn(); await refresh(); if (done) Alert.alert(done); }
    catch (e) { const x = e as ApiError; if (x.code !== "cancelled") setErr(x.message); }
  };

  return (
    <Screen title="Security centre">
      <H2>Emergency</H2>
      {p.frozen ? (
        <>
          <Note tone="error">Your account is frozen. Outgoing payments are blocked; money can still come in.</Note>
          <Button title="Unfreeze my account" onPress={() => run(() => authorize({ title: "Unfreeze account", subtitle: "Confirm it's really you", run: (s) => api("security.unfreeze", s) }), "Account unfrozen")} />
        </>
      ) : (
        <>
          <Button title="🧊 Freeze my account" kind="danger" onPress={() => Alert.alert("Freeze your account?", "Every transfer and payment will be blocked until you unfreeze. Use this if your phone is lost or something looks wrong.", [{ text: "Cancel" }, { text: "Freeze now", style: "destructive", onPress: () => run(() => api("security.freeze"), "Account frozen. Your money is safe.") }])} />
          <Note>No PIN needed to freeze, so you can do it fast. Unfreezing needs your PIN and a code.</Note>
        </>
      )}

      <H2>Protections</H2>
      <Card>
        <Row icon="🔑" title="Change transaction PIN" sub="Needs your current PIN and a code" onPress={() => router.push("/change-pin")} /><Divider />
        <Row icon="🔐" title="Codes for big transfers" sub={`SMS code for ${naira(me.otp_min_kobo, { decimals: false })} and above`}
          right={<Switch value={p.otp_large} onValueChange={(on) => run(() => on ? api("security.otp_large", { on }) : authorize({ title: "Turn off codes?", subtitle: "Big transfers will only need your PIN", run: (s) => api("security.otp_large", { on, ...s }) }))} />} />
      </Card>

      <H2>Daily spending limit</H2>
      <Card style={{ padding: 16, gap: 12 }}>
        <Text style={{ color: c.ink, fontWeight: "800", fontSize: 20 }}>{naira(current, { decimals: false })} per day</Text>
        <Note>A lower limit protects you if your phone is stolen. Raising it needs your PIN and a code; lowering it is instant.</Note>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {presets.map((v) => <Chip key={v} label={naira(v, { decimals: false })} on={v === current} onPress={() => run(() => v > current
            ? authorize({ title: `Raise limit to ${naira(v, { decimals: false })}`, run: (s) => api("security.limit", { daily_limit_kobo: v, ...s }) })
            : api("security.limit", { daily_limit_kobo: v }))} />)}
        </View>
      </Card>

      <H2>Signed-in devices</H2>
      <Card>
        {devices.map((d, i) => (
          <View key={d.id}>
            {i ? <Divider /> : null}
            <Row icon="📱" title={d.name} sub={d.current ? "This phone" : `Last active ${when(d.last_seen)}`}
              right={d.current ? <View /> : <Text accessibilityRole="button" style={{ color: c.neg, fontWeight: "700" }} onPress={() => run(async () => {
                await authorize({ title: `Remove ${d.name}?`, subtitle: "It will be signed out", run: (s) => api("devices.revoke", { id: d.id, ...s }) });
                loadDevices();
              }, "Device removed")}>Remove</Text>} />
          </View>
        ))}
      </Card>
      {err ? <Note tone="error">{err}</Note> : null}
      <Card style={{ padding: 14 }}><Note>🛡️ Kolo will never ask for your PIN, code or password by call, SMS or WhatsApp. Anyone who asks is a scammer. Hang up, and freeze your account if you shared anything.</Note></Card>
    </Screen>
  );
}
