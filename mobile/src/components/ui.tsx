import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useColors, font } from "@/lib/theme";

export function Screen({ title, back = true, children, right, scroll = true }: { title?: string; back?: boolean; children: React.ReactNode; right?: React.ReactNode; scroll?: boolean }) {
  const c = useColors();
  const Body = scroll ? ScrollView : View;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      {title ? (
        <View style={s.head}>
          {back ? <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={[s.iconBtn, { backgroundColor: c.surface, borderColor: c.line }]}><Text style={{ color: c.ink, fontSize: 20 }}>‹</Text></Pressable> : null}
          <Text style={[s.title, { color: c.ink }]} numberOfLines={1}>{title}</Text>
          <View style={{ flex: 1 }} />
          {right}
        </View>
      ) : null}
      <Body {...(scroll ? { contentContainerStyle: s.body, keyboardShouldPersistTaps: "handled" as const } : { style: [s.body, { flex: 1 }] })}>{children}</Body>
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: 18 }, style]}>{children}</View>;
}

export function Button({ title, onPress, kind = "primary", disabled, loading }: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; loading?: boolean }) {
  const c = useColors();
  const bg = kind === "primary" ? c.brand : kind === "danger" ? c.neg : c.surface;
  const fg = kind === "secondary" ? c.ink : c.onBrand;
  return (
    <Pressable accessibilityRole="button" disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === "secondary" ? c.line : bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, help, big, ...p }: TextInputProps & { label: string; error?: string | null; help?: string; big?: boolean }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.label, { color: c.muted }]}>{label}</Text>
      <TextInput placeholderTextColor={c.muted} {...p}
        style={[s.input, big && s.big, { backgroundColor: c.surface, borderColor: error ? c.neg : c.line, color: c.ink }, p.style]} />
      {error ? <Text style={{ color: c.neg, fontWeight: "600" }}>{error}</Text> : help ? <Text style={{ color: c.muted, fontSize: 13 }}>{help}</Text> : null}
    </View>
  );
}

export function Row({ title, sub, onPress, right, icon }: { title: string; sub?: string; onPress?: () => void; right?: React.ReactNode; icon?: string }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole={onPress ? "button" : undefined} onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.row, { opacity: pressed ? 0.7 : 1 }]}>
      {icon ? <View style={[s.rowIcon, { backgroundColor: c.surface2 }]}><Text style={{ fontSize: 18 }}>{icon}</Text></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: c.ink, fontWeight: "700", fontSize: 15 }} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={{ color: c.muted, fontSize: 13, marginTop: 2 }} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right ?? (onPress ? <Text style={{ color: c.muted, fontSize: 20 }}>›</Text> : null)}
    </Pressable>
  );
}

export const Divider = () => { const c = useColors(); return <View style={{ height: 1, backgroundColor: c.line }} />; };

export function H2({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text style={[font.display, { color: c.ink, fontSize: 17, marginTop: 22, marginBottom: 10 }]}>{children}</Text>;
}

export function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "error" | "ok" }) {
  const c = useColors();
  const color = tone === "error" ? c.neg : tone === "ok" ? c.pos : c.muted;
  return <Text style={{ color, fontSize: 14, lineHeight: 20, fontWeight: tone === "info" ? "500" : "600" }}>{children}</Text>;
}

export function Chip({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  const c = useColors();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} onPress={onPress} style={[s.chip, { backgroundColor: on ? c.brand : c.surface, borderColor: on ? c.brand : c.line }]}><Text style={{ color: on ? c.onBrand : c.ink, fontWeight: "700" }}>{label}</Text></Pressable>;
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "800", letterSpacing: -0.3, flexShrink: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 14 },
  btn: { minHeight: 54, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  btnText: { fontWeight: "800", fontSize: 16 },
  label: { fontSize: 13, fontWeight: "700" },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16 },
  big: { fontSize: 26, fontWeight: "800", paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  rowIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
});
