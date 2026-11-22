import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { Platform } from "react-native";

// Every server call goes through here: api("transfer.bank", { ... })
// The sign-in token lives in the phone's secure keychain/keystore.

const BASE = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
if (!BASE) throw new Error("Set EXPO_PUBLIC_API_URL in mobile/.env to your Vercel address, e.g. https://kolo-bankingapp.vercel.app");

export class ApiError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, any> = {}) { super(message); }
}

// Secure storage on phones; plain browser storage only for the web preview.
const store = {
  get: (k: string) => (Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.getItem(k) ?? null) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) => (Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.setItem(k, v)) : SecureStore.setItemAsync(k, v)),
  del: (k: string) => (Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.removeItem(k)) : SecureStore.deleteItemAsync(k)),
};

let token: string | null = null;
let onSignedOut: (() => void) | null = null;
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

export async function loadToken() { token = await store.get("kolo.token"); return token; }
export async function saveToken(t: string) { token = t; await store.set("kolo.token", t); }
export async function clearToken() { token = null; await store.del("kolo.token"); }

let device: { device_id: string; device_name: string } | null = null;
export async function deviceInfo() {
  if (device) return device;
  let id = await store.get("kolo.device_id");
  if (!id) { id = Crypto.randomUUID(); await store.set("kolo.device_id", id); }
  const name = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ") || (Platform.OS === "web" ? "Web browser" : Platform.OS);
  device = { device_id: id, device_name: name.slice(0, 60) };
  return device;
}

export async function api<T = any>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const d = await deviceInfo();
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": d.device_id,
        "x-device-name": d.device_name,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, ...params }),
    });
  } catch {
    throw new ApiError("network", "We couldn't reach Kolo. Check your internet connection and try again.");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error ?? {};
    if (res.status === 401 && e.code === "unauthorized" && token) { await clearToken(); onSignedOut?.(); }
    throw new ApiError(e.code ?? "error", e.message ?? "Something went wrong. Try again.", e);
  }
  return body as T;
}

export const newIdempotencyKey = () => Crypto.randomUUID();
