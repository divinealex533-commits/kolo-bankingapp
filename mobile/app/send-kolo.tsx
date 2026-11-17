import React, { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { Button, Card, Field, Note, Screen } from "@/components/ui";
import { useAuthorize } from "@/components/Authorize";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { naira, toKobo } from "@/lib/money";
import { useSession } from "@/lib/session";
import { useColors } from "@/lib/theme";

export default function SendKolo() {
  const c = useColors();
  const { me, refresh } = useSession();
  const authorize = useAuthorize();
  const [tag, setTag] = useState("");
  const [who, setWho] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());
  const clean = tag.trim().replace(/^@/, "").toLowerCase();

  useEffect(() => {
    setWho(null); setLookupErr(null);
    if (clean.length < 3) return;
    const t = setTimeout(() => {
      api<{ name: string }>("tag.lookup", { tag: clean }).then((r) => setWho(r.name)).catch((e: ApiError) => setLookupErr(e.message));
    }, 400);
    return () => clearTimeout(t);
  }, [clean]);

  const kobo = toKobo(amount);
  const balance = me?.account?.balance_kobo ?? 0;
  const problem = kobo && kobo > balance ? `You only have ${naira(balance)}.` : null;

  async function send() {
    if (!who || !kobo) return;
    setErr(null);
    try {
      const r = await authorize({
        title: `Send ${naira(kobo)}`, subtitle: `to ${who} (@${clean}) · free`,
        run: (s) => api<{ transaction: { id: string } }>("transfer.kolo", { tag: clean, amount_kobo: kobo, narration: note, idempotency_key: idem.current, ...s }),
      });
      await refresh();
      router.replace({ pathname: "/receipt", params: { id: r.transaction.id } });
    } catch (e) { const x = e as ApiError; if (x.code !== "cancelled") setErr(x.message); }
  }

  return (
    <Screen title="Send to Kolo tag">
      <Field label="Kolo tag" value={tag} onChangeText={setTag} autoCapitalize="none" autoCorrect={false} placeholder="@username" error={lookupErr} help="Instant and free between Kolo users." />
      {who ? <Card style={{ padding: 12 }}><Text style={{ color: c.pos, fontWeight: "800" }}>✓ {who}</Text></Card> : null}
      <Field label="Amount" big value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="₦0" error={problem} />
      <Field label="Note (optional)" value={note} onChangeText={setNote} maxLength={60} placeholder="Add a note" />
      {err ? <Note tone="error">{err}</Note> : null}
      <Button title="Continue" onPress={send} disabled={!who || !kobo || !!problem} />
    </Screen>
  );
}
