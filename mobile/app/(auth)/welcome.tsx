import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Field, Note, Screen } from "@/components/ui";
import { supabase } from "@/lib/supabase";
import { useColors } from "@/lib/theme";

// Nigerian number → +234 format. 08031234567 → +2348031234567
export const toIntl = (p: string) => { const d = p.replace(/\D/g, ""); return d.startsWith("234") ? "+" + d : d.startsWith("0") ? "+234" + d.slice(1) : "+234" + d; };
const valid = (p: string) => /^(\+?234|0)[789][01]\d{8}$/.test(p.replace(/[\s-]/g, ""));

export default function Welcome() {
  const c = useColors();
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function next() {
    if (!valid(phone)) { setErr("Enter a valid Nigerian phone number, like 0803 123 4567."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithOtp({ phone: toIntl(phone) });
    setBusy(false);
    if (error) { setErr(error.message.includes("rate") ? "Too many tries. Wait a minute and try again." : "We couldn't send a code to that number. Check it and try again."); return; }
    router.push({ pathname: "/verify", params: { phone: toIntl(phone) } });
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
        <Button title="Continue" onPress={next} loading={busy} />
        <Note>By continuing you agree to Kolo's terms and privacy policy.</Note>
      </KeyboardAvoidingView>
    </Screen>
  );
}
