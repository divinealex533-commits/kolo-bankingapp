import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/lib/theme";

// Number pad used for the PIN, one-time codes and the lock screen.
// onComplete returns null on success, or a message to show (the pad clears and shakes).
export function PinPad({ length = 4, title, subtitle, message, onComplete, onCancel, onBiometric, dark, banner }: {
  length?: number; title: string; subtitle?: string; message?: string;
  onComplete: (value: string) => Promise<string | null>;
  onCancel?: () => void; onBiometric?: () => void; dark?: boolean; banner?: React.ReactNode;
}) {
  const c = useColors();
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(message ?? "");
  useEffect(() => { setMsg(message ?? ""); }, [message]);
  const fg = dark ? "#f4fbf9" : c.ink, sub = dark ? "rgba(244,251,249,.78)" : c.muted, keyBg = dark ? "rgba(255,255,255,.1)" : c.surface2;

  async function press(k: string) {
    if (busy) return;
    Haptics.selectionAsync().catch(() => {});
    if (k === "del") { setVal((v) => v.slice(0, -1)); return; }
    const next = (val + k).slice(0, length);
    setVal(next);
    if (next.length === length) {
      setBusy(true);
      try {
        const err = await onComplete(next);
        if (err) { setMsg(err); setVal(""); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); }
      } finally { setBusy(false); }
    }
  }

  return (
    <View style={{ gap: 18 }}>
      {banner}
      <View style={{ gap: 6 }}>
        <Text style={[st.title, { color: fg }]}>{title}</Text>
        {subtitle ? <Text style={[st.sub, { color: sub }]}>{subtitle}</Text> : null}
      </View>
      <View style={st.dots} accessibilityLabel={`${val.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, i) => (
          <View key={i} style={[st.dot, length > 4 && st.dotSm, { borderColor: dark ? "rgba(255,255,255,.45)" : c.line, backgroundColor: i < val.length ? (dark ? c.accent : c.brand) : "transparent" }]} />
        ))}
      </View>
      <View style={{ minHeight: 22, alignItems: "center" }}>
        {busy ? <ActivityIndicator color={fg} /> : <Text accessibilityLiveRegion="polite" style={[st.sub, { color: msg ? (dark ? "#ffd59a" : c.neg) : sub }]}>{msg}</Text>}
      </View>
      {onBiometric ? <Pressable onPress={onBiometric} style={st.bio}><Text style={{ color: fg, fontWeight: "700" }}>Use Face ID / fingerprint</Text></Pressable> : null}
      <View style={st.keys}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", onCancel ? "cancel" : "", "0", "del"].map((k, i) => (
          k === "" ? <View key={i} style={st.key} /> :
          <Pressable key={i} accessibilityRole="button" accessibilityLabel={k === "del" ? "Delete" : k === "cancel" ? "Cancel" : k}
            onPress={() => (k === "cancel" ? onCancel?.() : press(k))}
            style={({ pressed }) => [st.key, { backgroundColor: k === "cancel" ? "transparent" : keyBg, opacity: pressed ? 0.6 : 1 }]}>
            <Text style={{ color: fg, fontSize: k === "cancel" ? 15 : 24, fontWeight: k === "cancel" ? "700" : "800" }}>{k === "del" ? "⌫" : k === "cancel" ? "Cancel" : k}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  title: { fontSize: 20, fontWeight: "800", textAlign: "center" },
  sub: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 14 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  dotSm: { width: 14, height: 14 },
  keys: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  key: { width: "31.5%", height: 60, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  bio: { alignSelf: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,.14)" },
});
