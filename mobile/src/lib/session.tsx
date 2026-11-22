import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, clearToken, loadToken, saveToken, setSignedOutHandler } from "./api";

export type Me = {
  profile: { id: string; first_name: string; last_name: string; phone: string | null; tag: string | null; tier: number; kyc_status: string; frozen: boolean; daily_limit_kobo: number | null; otp_large: boolean; is_admin: boolean; pidgin: boolean };
  account: { account_number: string; account_name: string; bank_name: string; balance_kobo: number; status: string } | null;
  tier: { tier: number; name: string; single_kobo: number; daily_kobo: number; max_balance_kobo: number | null };
  tiers: { tier: number; name: string; single_kobo: number; daily_kobo: number }[];
  pin_set: boolean; spent_today_kobo: number; unread_count: number; fee_bank_kobo: number; otp_min_kobo: number; sandbox: boolean;
};

type Ctx = {
  signedIn: boolean; me: Me | null; loading: boolean;
  refresh: () => Promise<void>; signIn: (token: string) => Promise<void>; signOut: () => Promise<void>;
};
const SessionContext = createContext<Ctx>({ signedIn: false, me: null, loading: true, refresh: async () => {}, signIn: async () => {}, signOut: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>("me")); }
    catch (e) { if ((e as ApiError).code !== "unauthorized") console.warn("me failed", e); }
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => { setSignedIn(false); setMe(null); });
    loadToken().then(async (t) => {
      if (t) { setSignedIn(true); await refresh(); }
      setLoading(false);
    });
  }, [refresh]);

  const signIn = useCallback(async (token: string) => { await saveToken(token); setSignedIn(true); await refresh(); }, [refresh]);
  const signOut = useCallback(async () => {
    try { await api("auth.logout"); } catch { /* already signed out on the server */ }
    await clearToken(); setSignedIn(false); setMe(null);
  }, []);

  return <SessionContext.Provider value={{ signedIn, me, loading, refresh, signIn, signOut }}>{children}</SessionContext.Provider>;
}
