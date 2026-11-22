import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as LocalAuthentication from "expo-local-authentication";
import { usePreventScreenCapture } from "expo-screen-capture";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PinPad } from "./PinPad";

// Screenshot blocking only exists on phones; the web version skips it.
const usePreventCapture = Platform.OS === "web" ? () => {} : usePreventScreenCapture;

const BACKGROUND_LOCK_MS = 30_000;   // lock if the app was away for 30 seconds
const IDLE_LOCK_MS = 2 * 60_000;     // lock after 2 minutes without a touch

// Wraps the whole app: blocks screenshots (Android), hides content in the app switcher,
// and asks for Face ID / PIN when you come back or stop using the app.
export function AppLock({ children }: { children: React.ReactNode }) {
  usePreventCapture();
  const { me, signOut } = useSession();
  const enabled = !!me?.pin_set;
  const [locked, setLocked] = useState(true);
  const [covered, setCovered] = useState(false);
  const awayAt = useRef<number | null>(null);
  const lastTouch = useRef(Date.now());

  const bio = useCallback(async () => {
    const ok = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
    if (!ok) return;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Kolo", disableDeviceFallback: true, cancelLabel: "Use PIN" });
    if (r.success) { setLocked(false); lastTouch.current = Date.now(); }
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") { setCovered(true); awayAt.current ??= Date.now(); return; }
      setCovered(false);
      if (awayAt.current && Date.now() - awayAt.current > BACKGROUND_LOCK_MS) setLocked(true);
      awayAt.current = null;
    });
    const t = setInterval(() => { if (Date.now() - lastTouch.current > IDLE_LOCK_MS) setLocked(true); }, 5000);
    return () => { sub.remove(); clearInterval(t); };
  }, []);

  useEffect(() => { if (enabled && locked) bio(); }, [enabled, locked, bio]);

  const showLock = enabled && locked;
  return (
    <View style={{ flex: 1 }} onTouchStart={() => { lastTouch.current = Date.now(); }}>
      {children}
      {showLock ? (
        <View style={[StyleSheet.absoluteFill, st.lock]}>
          <SafeAreaView style={{ flex: 1, justifyContent: "center", paddingHorizontal: 20 }}>
            <Text style={st.brand}>Kolo</Text>
            <PinPad dark title={`Welcome back${me?.profile.first_name ? ", " + me.profile.first_name : ""}`} subtitle="Enter your PIN to unlock" onBiometric={bio}
              onComplete={async (pin) => {
                try { await api("pin.check", { pin }); setLocked(false); lastTouch.current = Date.now(); return null; }
                catch (e) { const err = e as ApiError; if (err.code === "unauthorized") { await signOut(); return null; } return err.message; }
              }} />
            <Text style={st.out} onPress={signOut}>Not you? Sign out</Text>
          </SafeAreaView>
        </View>
      ) : null}
      {covered && !showLock ? <View style={[StyleSheet.absoluteFill, st.lock, { alignItems: "center", justifyContent: "center" }]}><Text style={st.brand}>Kolo</Text></View> : null}
    </View>
  );
}

const st = StyleSheet.create({
  lock: { backgroundColor: "#0b3f3b", zIndex: 100 },
  brand: { color: "#f0a032", fontSize: 36, fontWeight: "800", textAlign: "center", marginBottom: 24, letterSpacing: -0.5 },
  out: { color: "rgba(244,251,249,.7)", textAlign: "center", marginTop: 20, fontWeight: "700" },
});
