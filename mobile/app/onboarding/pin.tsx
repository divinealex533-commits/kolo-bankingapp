import React, { useState } from "react";
import { Screen } from "@/components/ui";
import { PinPad } from "@/components/PinPad";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function SetPin() {
  const { refresh } = useSession();
  const [first, setFirst] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>();
  return (
    <Screen title="Create your PIN" back={false}>
      {first === null ? (
        <PinPad key="a" message={msg} title="Choose a 4-digit PIN" subtitle="You'll use it to approve every payment. Avoid 1234, repeated digits and birth years."
          onComplete={async (p) => {
            if (/^(\d)\1{3}$/.test(p) || ["1234", "4321", "0123", "1212"].includes(p)) return "That PIN is too easy to guess. Pick another.";
            setMsg(undefined); setFirst(p); return null;
          }} />
      ) : (
        <PinPad key="b" title="Enter it again" subtitle="Just to be sure."
          onCancel={() => setFirst(null)}
          onComplete={async (p) => {
            if (p !== first) { setMsg("The PINs didn't match. Start again."); setFirst(null); return null; }
            try { await api("pin.set", { pin: p }); await refresh(); return null; }
            catch (e) { setMsg((e as ApiError).message); setFirst(null); return null; }
          }} />
      )}
    </Screen>
  );
}
