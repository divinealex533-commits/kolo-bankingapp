import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Field, Note, Screen } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useColors } from "@/lib/theme";

export default function Welcome() {
  const c = useColors();
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function next() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ phone: string; dev_code?: string }>("auth.start", { phone });
      router.push({ pathname: "/verify", params: { phone: r.phone, dev: r.dev_code ?? "" } });
    } catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <Screen back={false}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ gap: 16, paddingTop: 48 }}>
        <View style={{ gap: 10 }}>
          <Text style={{ color: c.accent, fontSize: 44, fontWeight: "800", letterSpacing: -1 }}>Kolo</Text>
          <Text style={{ color: c.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.4 }}>Send, save and grow your money.</Text>
          <Note>Sign in or create an account with your phone number. We'll text you a code.</Note>
        </View>
        <Field label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="0803 123 4567" autoComplete="tel" error={err} maxLength={16} />
        <Button title="Continue" onPress={next} loading={busy} disabled={phone.replace(/\D/g, "").length < 10} />
        <Note>By continuing you agree to Kolo's terms and privacy policy.</Note>
      </KeyboardAvoidingView>
    </Screen>
  );
}
