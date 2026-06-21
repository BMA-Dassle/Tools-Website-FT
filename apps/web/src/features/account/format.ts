export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Render a Square date (YYYY-MM-DD) in Eastern time, or pass through if unparseable. */
export function longDate(value: string): string {
  const dt = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export interface StatusMeta {
  label: string;
  /** Tailwind classes — always pairs a color with the text label (never color alone). */
  className: string;
}

export function statusMeta(status: string): StatusMeta {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return {
        label: "Active",
        className: "border-emerald-500/40 bg-emerald-500/20 text-emerald-300",
      };
    case "PENDING":
      return { label: "Starting soon", className: "border-sky-500/40 bg-sky-500/20 text-sky-300" };
    case "PAUSED":
      return { label: "Paused", className: "border-amber-500/40 bg-amber-500/20 text-amber-300" };
    case "CANCELED":
      return { label: "Canceled", className: "border-white/20 bg-white/10 text-white/50" };
    case "DEACTIVATED":
      return { label: "Payment issue", className: "border-red-500/40 bg-red-500/20 text-red-300" };
    default:
      return { label: status, className: "border-white/20 bg-white/10 text-white/50" };
  }
}
