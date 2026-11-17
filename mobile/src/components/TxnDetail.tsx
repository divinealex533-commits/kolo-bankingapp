import React, { useEffect, useState } from "react";
import { ActivityIndicator, Share, Text, View } from "react-native";
import { Button, Card, Divider } from "@/components/ui";
import { Txn, txnTitle } from "@/components/TxnRow";
import { naira } from "@/lib/money";
import { supabase } from "@/lib/supabase";
import { useColors } from "@/lib/theme";

export function useTxn(id?: string) {
  const [t, setT] = useState<Txn | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () => supabase.from("transactions").select("*").eq("id", id).single().then(({ data }) => live && setT(data as Txn));
    load();
    const poll = setInterval(load, 4000); // pending transfers update by themselves
    return () => { live = false; clearInterval(poll); };
  }, [id]);
  return t;
}

const STATUS: Record<Txn["status"], string> = { pending: "Processing", successful: "Successful", failed: "Failed", reversed: "Failed · refunded" };

export function TxnDetail({ t }: { t: Txn | null }) {
  const c = useColors();
  if (!t) return <ActivityIndicator color={c.brand} />;
  const cp = t.counterparty ?? {};
  const rows: [string, string][] = [
    ["Status", STATUS[t.status]],
    [t.direction === "credit" ? "From" : "To", txnTitle(t)],
    ...(cp.bank_name ? [["Bank", cp.bank_name] as [string, string]] : []),
    ...(cp.account_number ? [["Account", cp.account_number] as [string, string]] : []),
    ...(cp.tag ? [["Kolo tag", "@" + cp.tag] as [string, string]] : []),
    ...(t.narration ? [["Narration", t.narration] as [string, string]] : []),
    ["Amount", naira(t.amount_kobo)],
    ["Fee", naira(t.fee_kobo)],
    ...(t.failure_reason ? [["Reason", t.failure_reason] as [string, string]] : []),
    ["Date", new Date(t.created_at).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" })],
    ["Reference", t.reference],
  ];
  const color = t.status === "successful" ? c.pos : t.status === "pending" ? c.accent : c.neg;
  return (
    <View style={{ gap: 14 }}>
      <Card>
        {rows.map(([k, v], i) => (
          <View key={k}>
            {i ? <Divider /> : null}
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, padding: 14 }}>
              <Text style={{ color: c.muted }}>{k}</Text>
              <Text selectable style={{ color: k === "Status" ? color : c.ink, fontWeight: "700", flexShrink: 1, textAlign: "right" }}>{v}</Text>
            </View>
          </View>
        ))}
      </Card>
      <Button title="Share receipt" kind="secondary" onPress={() => Share.share({ message: `Kolo receipt\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}` })} />
    </View>
  );
}
