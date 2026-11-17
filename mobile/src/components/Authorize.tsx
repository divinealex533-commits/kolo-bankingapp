import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/lib/api";
import { useColors } from "@/lib/theme";
import { PinPad } from "./PinPad";

// authorize() asks for the PIN, runs the server action, and if the server says a one-time
// code is needed, asks for that too and runs it again. The PIN never leaves memory.
export type Secrets = { pin: string; otp_id?: string; otp_code?: string };
type Req<T> = { title: string; subtitle?: string; run: (s: Secrets) => Promise<T> };
type Ctx = <T>(r: Req<T>) => Promise<T>;

const AuthorizeContext = createContext<Ctx>(() => Promise.reject(new Error("AuthorizeProvider missing")));
export const useAuthorize = () => useContext(AuthorizeContext);

const STAY_ON_PIN = new Set(["wrong_pin", "pin_required"]);
const STAY_ON_OTP = new Set(["otp_wrong", "otp_required"]);

export function AuthorizeProvider({ children }: { children: React.ReactNode }) {
  const c = useColors();
  const [req, setReq] = useState<Req<any> | null>(null);
  const [stage, setStage] = useState<"pin" | "otp">("pin");
  const [otp, setOtp] = useState<{ id: string; dev?: string; msg?: string } | null>(null);
  const pinRef = useRef("");
  const settle = useRef<{ ok: (v: any) => void; fail: (e: any) => void } | null>(null);

  const authorize = useCallback<Ctx>((r) => new Promise((ok, fail) => {
    settle.current = { ok, fail }; pinRef.current = ""; setOtp(null); setStage("pin"); setReq(r);
  }), []);

  const close = (result: { ok?: any; err?: any }) => {
    const s = settle.current; settle.current = null; pinRef.current = ""; setReq(null); setOtp(null);
    if (s) "err" in result ? s.fail(result.err) : s.ok(result.ok);
  };

  async function attempt(secrets: Secrets): Promise<string | null> {
    try { const v = await req!.run(secrets); close({ ok: v }); return null; }
    catch (e) {
      const err = e as ApiError;
      if (err.extra?.otp_required && err.extra?.otp_id) {
        setOtp({ id: err.extra.otp_id, dev: err.extra.dev_code, msg: err.message }); setStage("otp"); return null;
      }
      if (stage === "pin" && STAY_ON_PIN.has(err.code)) return err.message;
      if (stage === "otp" && STAY_ON_OTP.has(err.code)) return err.message;
      close({ err }); return null;
    }
  }

  return (
    <AuthorizeContext.Provider value={authorize}>
      {children}
      <Modal visible={!!req} animationType="slide" transparent onRequestClose={() => close({ err: new ApiError("cancelled", "Cancelled") })}>
        <View style={st.backdrop}>
          <SafeAreaView edges={["bottom"]} style={[st.sheet, { backgroundColor: c.surface }]}>
            <View style={[st.grab, { backgroundColor: c.line }]} />
            {req && stage === "pin" ? (
              <PinPad key="pin" title={req.title} subtitle={req.subtitle} message="Enter your 4-digit PIN"
                onCancel={() => close({ err: new ApiError("cancelled", "Cancelled") })}
                onComplete={async (pin) => { pinRef.current = pin; return attempt({ pin }); }} />
            ) : null}
            {req && stage === "otp" && otp ? (
              <PinPad key="otp" length={6} title="Enter the 6-digit code" subtitle="We sent it to your phone by SMS"
                message={otp.msg}
                banner={otp.dev ? <Pressable style={[st.dev, { borderColor: c.accent }]}><Text style={{ color: c.ink }}>Test mode code: <Text style={{ fontWeight: "800", letterSpacing: 2 }}>{otp.dev}</Text></Text></Pressable> : null}
                onCancel={() => close({ err: new ApiError("cancelled", "Cancelled") })}
                onComplete={(code) => attempt({ pin: pinRef.current, otp_id: otp.id, otp_code: code })} />
            ) : null}
          </SafeAreaView>
        </View>
      </Modal>
    </AuthorizeContext.Provider>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(4,12,11,.55)" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 12 },
  grab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, marginBottom: 6 },
  dev: { borderWidth: 1, borderStyle: "dashed", borderRadius: 12, padding: 10, alignItems: "center" },
});
