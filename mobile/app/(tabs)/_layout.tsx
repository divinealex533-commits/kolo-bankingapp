import React from "react";
import { Text } from "react-native";
import { Tabs } from "expo-router";
import { useColors } from "@/lib/theme";
import { useSession } from "@/lib/session";

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;

export default function TabsLayout() {
  const c = useColors();
  const { me } = useSession();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: c.link, tabBarInactiveTintColor: c.muted,
      tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line },
      tabBarLabelStyle: { fontWeight: "700" },
    }}>
      <Tabs.Screen name="home" options={{ title: "Home", tabBarIcon: icon("⌂") }} />
      <Tabs.Screen name="payments" options={{ title: "Payments", tabBarIcon: icon("⇄") }} />
      <Tabs.Screen name="history" options={{ title: "History", tabBarIcon: icon("☰") }} />
      <Tabs.Screen name="me" options={{ title: "Me", tabBarIcon: icon("◉") }} />
      <Tabs.Screen name="admin" options={{ title: "Admin", tabBarIcon: icon("★"), href: me?.profile.is_admin ? undefined : null }} />
    </Tabs>
  );
}
