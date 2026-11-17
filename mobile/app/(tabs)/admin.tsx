import React, { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Button, Card, Chip, Divider, Field, H2, Note, Row, Screen } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { naira, toKobo, when } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

type Overview = { users: number; verified: number; pending_transfers: number; ledger_mismatches: number; customer_balances_kobo: number; fee_income_kobo: number; in_flight_kobo: number; volume_24h_in_kobo: number; volume_24h_out_kobo: number; sandbox: boolean };
type U = { id: string; first_name: string; last_name: string; tag: string; phone: string; tier: number; kyc_status: string; frozen: boolean };
type T = { id: string; reference: string; status: string; amount_kobo: number; direction: string; category: string; created_at: string; profiles?: { first_name: string; last_name: string; tag: string } };

// Only visible to accounts with profiles.is_admin = true. The server checks again on every call.
export default function Admin() {
  const c = useColors();
  const { me } = useSession();
  const [o, setO] = useState<Overview | null>(null);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<U[]>([]);
  const [txns, setTxns] = useState<T[]>([]);
  const [status, setStatus] = useState("pending");
  const [dep, setDep] = useState({ acct: "", amt: "" });
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ov, u, t] = await Promise.all([api<Overview>("admin.overview"), api<{ users: U[] }>("admin.users", { q }), api<{ transactions: T[] }>("admin.transactions", { status })]);
      setO(ov); setUsers(u.users ?? []); setTxns(t.transactions ?? []); setErr(null);
    } catch (e) { setErr((e as ApiError).message); }
  }, [q, status]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  if (!me?.profile.is_admin) return <Screen title="Admin" back={false}><Note>Admins only.</Note></Screen>;

  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); Alert.alert(done); load(); } catch (e) { Alert.alert("Couldn't do that", (e as ApiError).message); } };
  const Stat = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
    <View style={{ width: "48%", padding: 14, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: warn ? c.neg : c.line }}>
      <Text style={{ color: c.muted, fontSize: 12, fontWeight: "700" }}>{k}</Text>
      <Text style={{ color: warn ? c.neg : c.ink, fontSize: 18, fontWeight: "800", marginTop: 4 }}>{v}</Text>
    </View>
  );

  return (
    <Screen title="Admin" back={false}>
      {err ? <Note tone="error">{err}</Note> : null}
      {o ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 }}>
          <Stat k="Customer money held" v={naira(o.customer_balances_kobo, { decimals: false })} />
          <Stat k="Fee income" v={naira(o.fee_income_kobo)} />
          <Stat k="Users / verified" v={`${o.users} / ${o.verified}`} />
          <Stat k="Pending transfers" v={String(o.pending_transfers)} warn={o.pending_transfers > 0} />
          <Stat k="In 24h" v={naira(o.volume_24h_in_kobo, { decimals: false })} />
          <Stat k="Out 24h" v={naira(o.volume_24h_out_kobo, { decimals: false })} />
          <Stat k="Money in flight" v={naira(o.in_flight_kobo, { decimals: false })} />
          <Stat k="Ledger health" v={o.ledger_mismatches ? `${o.ledger_mismatches} mismatch!` : "Balanced ✓"} warn={o.ledger_mismatches > 0} />
        </View>
      ) : null}

      {o?.sandbox ? (
        <>
          <H2>Test deposit (test mode only)</H2>
          <Card style={{ padding: 14, gap: 10 }}>
            <Field label="Account number" value={dep.acct} onChangeText={(v) => setDep({ ...dep, acct: v.replace(/\D/g, "").slice(0, 10) })} keyboardType="number-pad" placeholder={me.account?.account_number} />
            <Field label="Amount" value={dep.amt} onChangeText={(v) => setDep({ ...dep, amt: v })} keyboardType="decimal-pad" placeholder="₦50,000" />
            <Button title="Add test money" disabled={dep.acct.length !== 10 || !toKobo(dep.amt)} onPress={() => act(() => api("admin.test_deposit", { account_number: dep.acct, amount_kobo: toKobo(dep.amt) }), "Test money added")} />
          </Card>
        </>
      ) : null}

      <H2>Transactions</H2>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {["pending", "successful", "reversed", "all"].map((s) => <Chip key={s} label={s} on={status === s} onPress={() => setStatus(s)} />)}
      </View>
      <Card>
        {txns.length ? txns.map((t, i) => (
          <View key={t.id}>
            {i ? <Divider /> : null}
            <Row title={`${t.direction === "credit" ? "+" : "−"}${naira(t.amount_kobo)} · ${t.category}`} sub={`${t.profiles ? "@" + t.profiles.tag : ""} · ${t.status} · ${when(t.created_at)}\n${t.reference}`}
              onPress={t.status === "pending" ? () => act(() => api("admin.requery", { txn_id: t.id }), "Requeried") : undefined}
              right={t.status === "pending" ? <Text style={{ color: c.link, fontWeight: "700" }}>Requery</Text> : <View />} />
          </View>
        )) : <View style={{ padding: 16 }}><Note>None.</Note></View>}
      </Card>

      <H2>Customers</H2>
      <Field label="Search" value={q} onChangeText={setQ} placeholder="Name, @tag or phone" onSubmitEditing={load} returnKeyType="search" autoCapitalize="none" />
      <Card>
        {users.map((u, i) => (
          <View key={u.id}>
            {i ? <Divider /> : null}
            <Row title={`${u.first_name || "—"} ${u.last_name} ${u.frozen ? "🧊" : ""}`} sub={`@${u.tag ?? "—"} · ${u.phone ?? ""} · Tier ${u.tier} · ${u.kyc_status}`}
              right={<Text style={{ color: u.frozen ? c.pos : c.neg, fontWeight: "700" }} onPress={() => Alert.alert(u.frozen ? "Remove hold?" : "Put account on hold?", `${u.first_name} ${u.last_name}`, [{ text: "Cancel" }, { text: u.frozen ? "Unfreeze" : "Freeze", style: "destructive", onPress: () => act(() => api("admin.freeze", { user_id: u.id, frozen: !u.frozen, reason: "admin action" }), u.frozen ? "Hold removed" : "Account on hold") }])}>{u.frozen ? "Unfreeze" : "Freeze"}</Text>} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
