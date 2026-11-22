import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "@/lib/session";
import { AuthorizeProvider } from "@/components/Authorize";
import { AppLock } from "@/components/AppLock";
import { useColors } from "@/lib/theme";

// Sends people to the right place: sign in → verify identity → set PIN → app.
function Gate() {
  const { signedIn, me, loading } = useSession();
  const seg = useSegments();
  const c = useColors();

  useEffect(() => {
    if (loading) return;
    const area = seg[0];
    if (!signedIn) { if (area !== "(auth)") router.replace("/welcome"); return; }
    if (!me) return;
    if (me.profile.kyc_status !== "verified") { if (seg[1] !== "kyc") router.replace("/onboarding/kyc"); return; }
    if (!me.pin_set) { if (seg[1] !== "pin") router.replace("/onboarding/pin"); return; }
    if (area === "(auth)" || area === "onboarding" || !area) router.replace("/home");
  }, [signedIn, me, loading, seg]);

  if (loading || (signedIn && !me)) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}><ActivityIndicator color={c.brand} /></View>;
  }
  return (
    <AppLock>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }} />
    </AppLock>
  );
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AuthorizeProvider>
          <StatusBar style="auto" />
          <Gate />
        </AuthorizeProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
