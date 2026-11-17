import { useColorScheme } from "react-native";

const light = {
  bg: "#eef2f1", surface: "#ffffff", surface2: "#f5f8f7", ink: "#10201f", muted: "#5b6b68", line: "#dde5e3",
  brand: "#0d4f4a", brand2: "#093a36", onBrand: "#f4fbf9", accent: "#f0a032", accentInk: "#3b2400",
  pos: "#187a50", neg: "#b83b26", link: "#0d4f4a",
};
const dark: typeof light = {
  bg: "#0a1211", surface: "#121e1c", surface2: "#172624", ink: "#e6efed", muted: "#8fa29e", line: "#22332f",
  brand: "#13665f", brand2: "#0b403b", onBrand: "#f4fbf9", accent: "#f4ae4a", accentInk: "#2e1c00",
  pos: "#4cc48d", neg: "#f07a62", link: "#f4ae4a",
};
export type Colors = typeof light;
export const useColors = (): Colors => (useColorScheme() === "dark" ? dark : light);

export const font = {
  display: { fontWeight: "800" as const, letterSpacing: -0.3 },
  body: { fontWeight: "500" as const },
};
