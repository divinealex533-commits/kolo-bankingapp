// Same shape as React Native's Alert.alert, but it also works in the web version,
// where React Native's Alert does nothing.
import * as Clipboard from "expo-clipboard";
import { Alert as RNAlert, AlertButton, Platform, Share } from "react-native";

function webAlert(title: string, message?: string, buttons?: AlertButton[]) {
  const text = message ? `${title}\n\n${message}` : title;
  const actions = (buttons ?? []).filter((b) => b.style !== "cancel");
  if (!buttons || buttons.length <= 1) {
    globalThis.alert?.(text);
    buttons?.[0]?.onPress?.();
    return;
  }
  // Two-choice dialogs ("Cancel" + an action) become a browser confirm box.
  const action = actions[actions.length - 1];
  if (globalThis.confirm?.(text)) action?.onPress?.();
  else buttons.find((b) => b.style === "cancel" || b.text === "Cancel")?.onPress?.();
}

export const Alert = {
  alert: (title: string, message?: string, buttons?: AlertButton[]) =>
    Platform.OS === "web" ? webAlert(title, message, buttons) : RNAlert.alert(title, message, buttons),
};

// Opens the share sheet; where there isn't one (some browsers), copies the text instead.
export async function shareText(message: string) {
  try { await Share.share({ message }); }
  catch { await Clipboard.setStringAsync(message); Alert.alert("Copied", "The details are copied. Paste them anywhere."); }
}
