import React, { useCallback, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Chip, Note } from "@/components/ui";
import { Txn, TxnRow } from "@/components/TxnRow";
import { supabase } from "@/lib/supabase";
import { useColors } from "@/lib/theme";

const PAGE = 30;

export default function History() {
  const c = useColors();
  const [filter, setFilter] = useState<"all" | "credit" | "debit">("all");
  const [rows, setRows] = useState<Txn[]>([]);
  const [done, setDone] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (reset: boolean, f = filter) => {
    const from = reset ? 0 : rows.length;
    let q = supabase.from("transactions").select("*").order("created_at", { ascending: false }).range(from, from + PAGE - 1);
    if (f !== "all") q = q.eq("direction", f);
    const { data } = await q;
    const got = (data as Txn[]) ?? [];
    setRows((r) => (reset ? got : [...r, ...got])); setDone(got.length < PAGE);
  }, [filter, rows.length]);

  useFocusEffect(useCallback(() => { load(true); }, [filter])); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "left", "right"]}>
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={{ color: c.ink, fontSize: 22, fontWeight: "800" }}>Transactions</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {([["all", "All"], ["credit", "Money in"], ["debit", "Money out"]] as const).map(([k, l]) => <Chip key={k} label={l} on={filter === k} onPress={() => setFilter(k)} />)}
        </View>
      </View>
      <FlatList data={rows} keyExtractor={(t) => t.id}
        contentContainerStyle={{ marginHorizontal: 16, backgroundColor: c.surface, borderRadius: 18, borderWidth: 1, borderColor: c.line, overflow: "hidden" }}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: c.line }} />}
        renderItem={({ item }) => <TxnRow t={item} />}
        ListEmptyComponent={<View style={{ padding: 20 }}><Note>Nothing here yet.</Note></View>}
        onEndReached={() => { if (!done) load(false); }} onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />} />
    </SafeAreaView>
  );
}
