import { FunctionsHttpError } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { supabase } from "./supabase";

export class ApiError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, any> = {}) { super(message); }
}

let deviceId: string | null = null;
async function deviceHeaders() {
  if (!deviceId) {
    deviceId = Platform.OS === "web" ? null : await SecureStore.getItemAsync("kolo.device_id");
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      if (Platform.OS !== "web") await SecureStore.setItemAsync("kolo.device_id", deviceId);
    }
  }
  const name = [Device.manufacturer, Device.modelName].filter(Boolean).join(" ") || Platform.OS;
  return { "x-device-id": deviceId, "x-device-name": name };
}

// Every server call goes through here: api("transfer.bank", { ... })
export async function api<T = any>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("api", { body: { action, ...params }, headers: await deviceHeaders() });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      let j: any = {};
      try { j = await error.context.json(); } catch { /* not JSON */ }
      const e = j.error ?? {};
      throw new ApiError(e.code ?? "error", e.message ?? "Something went wrong. Try again.", e);
    }
    throw new ApiError("network", "We couldn't reach Kolo. Check your internet connection and try again.");
  }
  return data as T;
}

export const newIdempotencyKey = () => Crypto.randomUUID();
