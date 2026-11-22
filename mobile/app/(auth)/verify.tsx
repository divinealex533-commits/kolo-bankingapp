import React, { useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui";
import { PinPad } from "@/components/PinPad";
import { api, ApiError, deviceInfo } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export default function Verify() {
  const c = useColors();
  const { signIn } = useSession();
  const { phone, dev } = useLocalSearchParams<{ phone: string; dev?: string }>();
  const shown = String(phone ?? "").replace(/^234/, "0");
  const [msg] = useState(`We sent a 6-digit code to ${shown}`);
  return (
    <Screen title="Verify your number">
      <PinPad length={6} title="Enter the code" subtitle={msg}
        banner={dev ? (
          <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: c.accent, borderRadius: 12, padding: 10, alignItems: "center" }}>
            <Text style={{ color: c.ink }}>Test mode code: <Text style={{ fontWeight: "800", letterSpacing: 2 }}>{dev}</Text></Text>
          </View>
        ) : null}
        onComplete={async (code) => {
          try {
            const r = await api<{ token: string }>("auth.verify", { phone, code, ...(await deviceInfo()) });
            await signIn(r.token); // the gate in _layout moves on automatically
            return null;
          } catch (e) { return (e as ApiError).message; }
        }} />
    </Screen>
  );
}
