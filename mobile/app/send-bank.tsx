import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Card, Chip, Field, Note, Screen } from "@/components/ui";
import { useAuthorize } from "@/components/Authorize";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { naira, toKobo } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

type Bank = { code: string; name: string };

export default function SendBank() {
  const c = useColors();
  const p = useLocalSearchParams<{ bank_code?: string; bank_name?: string; account_number?: string }>();
  const { me, refresh } = useSession();
  const authorize = useAuthorize();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [picker, setPicker] = useState(false);
  const [q, setQ] = useState("");
  const [bank, setBank] = useState<Bank | null>(p.bank_code ? { code: p.bank_code, name: p.bank_name ?? "" } : null);
  const [acct, setAcct] = useState(p.account_number ?? "");
  const [name, setName] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [save, setSave] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());

  useEffect(() => { api<{ banks: Bank[] }>("banks.list").then((r) => setBanks(r.banks)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    setName(null); setLookupErr(null);
    if (!bank || !/^\d{10}$/.test(acct)) return;
    let live = true;
    api<{ account_name: string }>("name.enquiry", { bank_code: bank.code, account_number: acct })
      .then((r) => live && setName(r.account_name)).catch((e: ApiError) => live && setLookupErr(e.message));
    return () => { live = false; };
  }, [bank, acct]);

  const kobo = toKobo(amount);
  const fee = me?.fee_bank_kobo ?? 0;
  const total = (kobo ?? 0) + fee;
  const balance = me?.account?.balance_kobo ?? 0;
  const problem = kobo === null ? null : total > balance ? `You only have ${naira(balance)}.` : null;
  const filtered = useMemo(() => banks.filter((b) => b.name.toLowerCase().includes(q.toLowerCase())), [banks, q]);

  async function send() {
    if (!bank || !name || !kobo) return;
    setErr(null);
    try {
      const r = await authorize({
        title: `Send ${naira(kobo)}`, subtitle: `to ${name} · ${bank.name}\nFee ${naira(fee)} · Total ${naira(total)}`,
        run: (s) => api<{ transaction: { id: string; status: string } }>("transfer.bank", {
          bank_code: bank.code, bank_name: bank.name, account_number: acct, amount_kobo: kobo, narration: note,
          idempotency_key: idem.current, save_beneficiary: save, ...s,
        }),
      });
      await refresh();
      router.replace({ pathname: "/receipt", params: { id: r.transaction.id } });
    } catch (e) {
      const x = e as ApiError;
      if (x.code !== "cancelled") setErr(x.message);
    }
  }

  return (
    <Screen title="Send to bank">
      <Field label="Bank" value={bank?.name ?? ""} placeholder="Choose a bank" editable={false} onPressIn={() => setPicker(true)} />
      <Field label="Account number" value={acct} onChangeText={(v) => setAcct(v.replace(/\D/g, "").slice(0, 10))} keyboardType="number-pad" maxLength={10} placeholder="10 digits" error={lookupErr} />
      {name ? <Card style={{ padding: 12 }}><Text style={{ color: c.pos, fontWeight: "800" }}>✓ {name}</Text></Card> : null}
      <Field label="Amount" big value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="₦0" error={problem} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {[100000, 500000, 1000000, 2000000].map((k) => <Chip key={k} label={naira(k, { decimals: false })} onPress={() => setAmount(String(k / 100))} />)}
      </View>
      <Field label="Narration (optional)" value={note} onChangeText={setNote} maxLength={60} placeholder="What's it for?" />
      <Pressable onPress={() => setSave(!save)} accessibilityRole="checkbox" accessibilityState={{ checked: save }}><Text style={{ color: c.ink }}>{save ? "☑" : "☐"}  Save as beneficiary</Text></Pressable>
      {kobo ? (
        <Card style={{ padding: 14, gap: 6 }}>
          <Note>Transfer fee: {naira(fee)}</Note>
          <Note>Total: {naira(total)}</Note>
          {me && total >= me.otp_min_kobo && me.profile.otp_large ? <Note>🔐 We'll text you a code to confirm this one.</Note> : null}
        </Card>
      ) : null}
      {err ? <Note tone="error">{err}</Note> : null}
      <Button title="Continue" onPress={send} disabled={!bank || !name || !kobo || !!problem} />

      <Modal visible={picker} animationType="slide" onRequestClose={() => setPicker(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, padding: 16, gap: 12 }}>
          <TextInput autoFocus placeholder="Search banks" placeholderTextColor={c.muted} value={q} onChangeText={setQ}
            style={{ borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, color: c.ink, borderRadius: 14, padding: 14, fontSize: 16 }} />
          <FlatList data={filtered} keyExtractor={(b) => b.code} keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable onPress={() => { setBank(item); setPicker(false); setQ(""); }} style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.line }}>
                <Text style={{ color: c.ink, fontSize: 16, fontWeight: "600" }}>{item.name}</Text>
              </Pressable>
            )} />
          <Button title="Close" kind="secondary" onPress={() => setPicker(false)} />
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}
