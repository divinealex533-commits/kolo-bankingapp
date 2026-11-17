import React, { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui";
import { PinPad } from "@/components/PinPad";
import { supabase } from "@/lib/supabase";

export default function Verify() {
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [msg, setMsg] = useState(`We sent a 6-digit code to ${phone}`);
  return (
    <Screen title="Verify your number">
      <PinPad length={6} title="Enter the code" subtitle={msg}
        onComplete={async (token) => {
          const { error } = await supabase.auth.verifyOtp({ phone: String(phone), token, type: "sms" });
          if (error) return error.message.toLowerCase().includes("expired") ? "That code expired. Go back and request a new one." : "That code is wrong. Try again.";
          setMsg("Verified");
          return null; // the gate in _layout moves on automatically
        }} />
    </Screen>
  );
}
