import React, { useState } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";
import { Screen } from "@/components/ui";
import { PinPad } from "@/components/PinPad";
import { useAuthorize } from "@/components/Authorize";
import { api, ApiError } from "@/lib/api";

export default function ChangePin() {
  const authorize = useAuthorize();
  const [first, setFirst] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>();
  return (
    <Screen title="Change PIN">
      {first === null ? (
        <PinPad key="a" message={msg} title="Choose a new PIN" subtitle="Avoid 1234, repeated digits and birth years."
          onComplete={async (p) => { setMsg(undefined); setFirst(p); return null; }} />
      ) : (
        <PinPad key="b" title="Enter the new PIN again" onCancel={() => setFirst(null)}
          onComplete={async (p) => {
            if (p !== first) { setMsg("The PINs didn't match. Start again."); setFirst(null); return null; }
            try {
              await authorize({ title: "Enter your CURRENT PIN", subtitle: "To confirm it's you", run: (s) => api("pin.change", { old_pin: s.pin, new_pin: p, otp_id: s.otp_id, otp_code: s.otp_code }) });
              Alert.alert("PIN changed", "Use your new PIN from now on."); router.back(); return null;
            } catch (e) { const x = e as ApiError; if (x.code !== "cancelled") setMsg(x.message); setFirst(null); return null; }
          }} />
      )}
    </Screen>
  );
}
