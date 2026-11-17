import React, { useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, Note, Screen } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function Kyc() {
  const { refresh, signOut } = useSession();
  const [f, setF] = useState({ first_name: "", last_name: "", dob: "", bvn: "", tag: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  async function submit() {
    setErr(null);
    // DD/MM/YYYY → YYYY-MM-DD
    const m = f.dob.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) { setErr("Enter your date of birth as DD/MM/YYYY."); return; }
    const dob = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    setBusy(true);
    try {
      await api("kyc.submit", { ...f, dob, tag: f.tag.replace(/^@/, "").toLowerCase(), bvn: f.bvn.replace(/\D/g, "") });
      await refresh();
    } catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <Screen title="Verify your identity" back={false}>
      <Note>Banks in Nigeria must confirm who their customers are. Enter your details exactly as they appear on your BVN.</Note>
      <Field label="First name" value={f.first_name} onChangeText={set("first_name")} autoCapitalize="words" autoComplete="given-name" />
      <Field label="Last name" value={f.last_name} onChangeText={set("last_name")} autoCapitalize="words" autoComplete="family-name" />
      <Field label="Date of birth" value={f.dob} onChangeText={set("dob")} placeholder="DD/MM/YYYY" keyboardType="numbers-and-punctuation" maxLength={10} />
      <Field label="BVN" value={f.bvn} onChangeText={set("bvn")} keyboardType="number-pad" maxLength={11} secureTextEntry
        help="Dial *565*0# on the phone number linked to your bank to get your BVN. We only store the last 4 digits." />
      <Field label="Choose your Kolo tag" value={f.tag} onChangeText={set("tag")} autoCapitalize="none" placeholder="@yourname"
        help="Friends can send you money instantly with your tag. Letters, numbers, dots and underscores." />
      {err ? <Note tone="error">{err}</Note> : null}
      <Button title="Verify and open my account" onPress={submit} loading={busy} />
      <Card style={{ padding: 14 }}><Note>🔒 Your BVN is checked with the bank and never shown to anyone. It doesn't give Kolo access to your other bank accounts.</Note></Card>
      <View style={{ alignItems: "center" }}><Button title="Sign out" kind="secondary" onPress={signOut} /></View>
    </Screen>
  );
}
