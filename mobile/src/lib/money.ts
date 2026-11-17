// Money is always handled as integer kobo. Never do arithmetic on naira floats.

function group(n: string) { return n.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

export function naira(kobo: number, opts: { decimals?: boolean } = {}) {
  const neg = kobo < 0; const k = Math.abs(Math.round(kobo));
  const whole = group(String(Math.floor(k / 100)));
  const dec = opts.decimals === false ? "" : "." + String(k % 100).padStart(2, "0");
  return (neg ? "−" : "") + "₦" + whole + dec;
}

// "1,500.5" → 150050. Returns null for anything that isn't a clean amount.
export function toKobo(input: string): number | null {
  const s = input.replace(/[,\s₦]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const k = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return Number.isSafeInteger(k) && k > 0 ? k : null;
}

export const fmtAcct = (a?: string | null) => (a ?? "").replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3");

export function when(iso: string) {
  const d = new Date(iso), now = new Date(), y = new Date(now.getTime() - 86400000);
  const t = d.toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today, ${t}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${t}`;
  return d.toLocaleDateString("en-NG", { day: "numeric", month: "short" }) + `, ${t}`;
}
