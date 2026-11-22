import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Card, Divider, Note, Screen } from "@/components/ui";
import { when } from "@/lib/money";
import { api } from "@/lib/api";
import { useColors } from "@/lib/theme";

type N = { id: number; title: string; body: string; kind: string; read: boolean; created_at: string };
const ICON: Record<string, string> = { credit: "↙", debit: "↗", security: "🛡", info: "ℹ︎" };

export default function Notifications() {
  const c = useColors();
  const [items, setItems] = useState<N[] | null>(null);
  useEffect(() => {
    // Opening the list marks everything as read on the server.
    api<{ notifications: N[] }>("notifications.list").then((r) => setItems(r.notifications)).catch(() => setItems([]));
  }, []);
  return (
    <Screen title="Notifications">
      <Card>
        {items?.length ? items.map((n, i) => (
          <View key={n.id}>
            {i ? <Divider /> : null}
            <View style={{ flexDirection: "row", gap: 12, padding: 14 }}>
              <Text style={{ fontSize: 18, color: n.kind === "credit" ? c.pos : n.kind === "security" ? c.neg : c.muted }}>{ICON[n.kind] ?? "•"}</Text>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: c.ink, fontWeight: n.read ? "600" : "800" }}>{n.title}</Text>
                <Text style={{ color: c.muted, lineHeight: 19 }}>{n.body}</Text>
                <Text style={{ color: c.muted, fontSize: 12 }}>{when(n.created_at)}</Text>
              </View>
            </View>
          </View>
        )) : <View style={{ padding: 20 }}><Note>{items ? "No notifications yet." : "Loading…"}</Note></View>}
      </Card>
    </Screen>
  );
}
