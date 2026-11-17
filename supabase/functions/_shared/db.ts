import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AppError, clientIp } from "./http.ts";

export const env = (k: string, fallback?: string): string => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${k}`);
  return v;
};
export const isSandbox = () => (Deno.env.get("KOLO_ENV") ?? "sandbox") === "sandbox";

// Service-role client: bypasses RLS. Only ever used inside edge functions.
export const admin: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Profile = {
  id: string; first_name: string; last_name: string; phone: string | null; tag: string | null;
  tier: number; kyc_status: string; frozen: boolean; daily_limit_kobo: number | null; otp_large: boolean; is_admin: boolean;
};

export async function requireUser(req: Request): Promise<{ user: { id: string; phone?: string }; profile: Profile }> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new AppError("unauthorized", "Please sign in again.", 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new AppError("unauthorized", "Your session has expired. Please sign in again.", 401);
  const { data: profile, error: pe } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (pe || !profile) throw new AppError("no_profile", "We couldn't find your profile.", 404);
  await touchDevice(data.user.id, req);
  return { user: { id: data.user.id, phone: data.user.phone ?? undefined }, profile: profile as Profile };
}

export async function requireAdmin(req: Request) {
  const ctx = await requireUser(req);
  if (!ctx.profile.is_admin) throw new AppError("forbidden", "Admins only.", 403);
  return ctx;
}

async function touchDevice(userId: string, req: Request) {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId) return;
  const name = (req.headers.get("x-device-name") ?? "Unknown device").slice(0, 60);
  const { data } = await admin.from("devices").select("id").eq("user_id", userId).eq("device_id", deviceId).maybeSingle();
  if (data) { await admin.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", data.id); return; }
  await admin.from("devices").insert({ user_id: userId, device_id: deviceId, name });
  await notify(userId, "New device signed in", `${name} just signed in to your Kolo account. If this wasn't you, freeze your account now.`, "security");
  await audit(userId, "device.new", { deviceId, name }, req);
}

export async function audit(userId: string | null, action: string, meta: Record<string, unknown> = {}, req?: Request, actor = "user") {
  await admin.from("audit_log").insert({ user_id: userId, action, meta, actor, ip: req ? clientIp(req) : null });
}

export async function notify(userId: string, title: string, body: string, kind: "credit" | "debit" | "security" | "info" = "info") {
  await admin.from("notifications").insert({ user_id: userId, title, body, kind });
  // TODO(phase 2): send an Expo push notification to the user's registered devices.
}

export async function rateLimit(userId: string, action: string, max: number, windowSeconds: number) {
  const { data, error } = await admin.rpc("rate_hit", { p_user: userId, p_action: action, p_max: max, p_window: `${windowSeconds} seconds` });
  if (error) throw error;
  if (!data) throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.", 429);
}

export const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const newReference = (prefix = "KL") =>
  prefix + Date.now().toString(36).toUpperCase() + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();

// Per-transaction and daily limits from the user's tier and their own chosen cap.
export async function checkLimits(profile: Profile, totalKobo: number) {
  if (profile.frozen) throw new AppError("account_frozen", "Your account is frozen. Unfreeze it in Security to send money.", 403);
  if (profile.kyc_status !== "verified" || profile.tier < 1) throw new AppError("kyc_required", "Verify your identity before sending money.", 403);
  const { data: tier } = await admin.from("tiers").select("*").eq("tier", profile.tier).single();
  if (!tier) throw new Error("tier missing");
  if (totalKobo > tier.single_kobo) {
    throw new AppError("over_single_limit", `${tier.name} lets you send up to ${naira(tier.single_kobo)} at once. Upgrade your account to send more.`);
  }
  const daily = Math.min(tier.daily_kobo, profile.daily_limit_kobo ?? Number.MAX_SAFE_INTEGER);
  const { data: spent, error } = await admin.rpc("spent_today", { p_user: profile.id });
  if (error) throw error;
  if (Number(spent) + totalKobo > daily) {
    throw new AppError("over_daily_limit", `This would pass your daily limit of ${naira(daily)}. You've used ${naira(Number(spent))} today.`);
  }
}
