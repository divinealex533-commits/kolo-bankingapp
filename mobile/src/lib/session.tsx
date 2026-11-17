import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api } from "./api";

export type Me = {
  profile: { id: string; first_name: string; last_name: string; phone: string | null; tag: string | null; tier: number; kyc_status: string; frozen: boolean; daily_limit_kobo: number | null; otp_large: boolean; is_admin: boolean; pidgin: boolean };
  account: { account_number: string; account_name: string; bank_name: string; balance_kobo: number; status: string } | null;
  tier: { tier: number; name: string; single_kobo: number; daily_kobo: number; max_balance_kobo: number | null };
  tiers: { tier: number; name: string; single_kobo: number; daily_kobo: number }[];
  pin_set: boolean; spent_today_kobo: number; fee_bank_kobo: number; otp_min_kobo: number; sandbox: boolean;
};

type Ctx = { session: Session | null; me: Me | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> };
const SessionContext = createContext<Ctx>({ session: null, me: null, loading: true, refresh: async () => {}, signOut: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>("me")); } catch (e) { console.warn("me failed", e); }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await refresh();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN") refresh();
      if (event === "SIGNED_OUT") setMe(null);
    });
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  const signOut = useCallback(async () => { await supabase.auth.signOut(); setMe(null); }, []);
  return <SessionContext.Provider value={{ session, me, loading, refresh, signOut }}>{children}</SessionContext.Provider>;
}
