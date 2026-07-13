import { WAIVER_RESOURCE_KEYWORDS } from "./constants";
import type { Reservation, StateFilter, ViewType, WaiverThresholds } from "./types";

/**
 * Pure display/filter logic ported verbatim from the portal's
 * DailyEventsPage.tsx helper functions. The only translation is visual:
 * the portal returned Tailwind class strings for badges; this repo's admin
 * boards style inline, so palettes return {bg, fg} color pairs (same hues —
 * Tailwind *-500/20 backgrounds with *-400 text).
 */

// ── Waiver status (portal lines 45-78) ───────────────────────────────

export function isWaiverEvent(r: Reservation): boolean {
  if ((r.state || "").toLowerCase().includes("waiver")) return true;
  const names: string[] = Array.isArray(r.allResourceNames) ? [...r.allResourceNames] : [];
  if (!names.length && r.resourceName) names.push(r.resourceName);
  return names.some((rn) => WAIVER_RESOURCE_KEYWORDS.some((kw) => rn.toLowerCase().includes(kw)));
}

export interface WaiverStatus {
  color: "red" | "yellow" | "green";
  pct: number;
  registered: number;
}

export function getWaiverStatus(r: Reservation, thresholds: WaiverThresholds): WaiverStatus | null {
  if (!isWaiverEvent(r) || r.registeredPersons === undefined || !r.persons) return null;
  const pct = (r.registeredPersons / r.persons) * 100;
  let color: "red" | "yellow" | "green";
  if (pct < thresholds.red) color = "red";
  else if (pct <= thresholds.yellow) color = "yellow";
  else color = "green";
  return { color, pct, registered: r.registeredPersons };
}

export const WAIVER_COLORS: Record<"red" | "yellow" | "green", string> = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
};

/** Left border bar color for waiver events (portal getWaiverBarColor). */
export function getWaiverBarColor(r: Reservation, thresholds: WaiverThresholds): string | null {
  const status = getWaiverStatus(r, thresholds);
  if (!status) return null;
  return WAIVER_COLORS[status.color];
}

// ── State badge palette (portal getStateBadgeVariant, lines 80-99) ───

export interface BadgePalette {
  bg: string;
  fg: string;
}

const PALETTES = {
  green: { bg: "rgba(34,197,94,0.2)", fg: "#4ade80" },
  orange: { bg: "rgba(249,115,22,0.2)", fg: "#fb923c" },
  purple: { bg: "rgba(168,85,247,0.2)", fg: "#c084fc" },
  indigo: { bg: "rgba(99,102,241,0.2)", fg: "#818cf8" },
  red: { bg: "rgba(239,68,68,0.2)", fg: "#f87171" },
  yellow: { bg: "rgba(234,179,8,0.2)", fg: "#facc15" },
  blue: { bg: "rgba(59,130,246,0.2)", fg: "#60a5fa" },
  amber: { bg: "rgba(245,158,11,0.2)", fg: "#fbbf24" },
  sky: { bg: "rgba(14,165,233,0.2)", fg: "#38bdf8" },
  emerald: { bg: "rgba(16,185,129,0.2)", fg: "#34d399" },
  muted: { bg: "var(--ba-muted2)", fg: "var(--ba-muted)" },
} as const;

export const BADGE_PALETTES = PALETTES;

/** Substring-ordered state → color rules (portal order preserved). */
export function getStateBadgePalette(state: string): BadgePalette {
  const s = (state || "").toLowerCase();
  if (s.includes("confirm")) return PALETTES.green;
  if (s.includes("deposit") && s.includes("request")) return PALETTES.orange;
  if (s.includes("pending signed contract")) return PALETTES.purple;
  if (s.includes("send contract")) return PALETTES.indigo;
  if (s.includes("cancel")) return PALETTES.red;
  if (s.includes("full")) return PALETTES.yellow;
  if (s.includes("book")) return PALETTES.blue;
  if (s.includes("new lead")) return PALETTES.amber;
  if (s.includes("contacted")) return PALETTES.sky;
  return PALETTES.muted;
}

// ── State predicates (portal lines 101-121) ──────────────────────────

export function isDepositRequested(state: string): boolean {
  const s = (state || "").toLowerCase();
  return s.includes("deposit") && s.includes("request");
}

export function isSendContract(state: string): boolean {
  const s = (state || "").toLowerCase();
  return s.includes("send contract") && !s.includes("pending");
}

export function isPendingSignedContract(state: string): boolean {
  return (state || "").toLowerCase().includes("pending signed contract");
}

export function isContractStage(state: string): boolean {
  return isSendContract(state) || isPendingSignedContract(state);
}

export function isOnlineReservation(r: Reservation): boolean {
  return (r.kind || "").toLowerCase().includes("online");
}

// ── Filters + stats (portal lines 377-419) ───────────────────────────

export function applyViewTypeFilter(
  reservations: Reservation[],
  viewType: ViewType,
): Reservation[] {
  return reservations.filter((r) =>
    viewType === "group" ? !isOnlineReservation(r) : isOnlineReservation(r),
  );
}

export function applyStateFilter(
  reservations: Reservation[],
  stateFilter: StateFilter,
): Reservation[] {
  if (stateFilter === "all") return reservations;
  return reservations.filter((r) => {
    const s = (r.state || "").toLowerCase();
    if (stateFilter === "confirmed") return s.includes("confirm");
    if (stateFilter === "cancelled") return s.includes("cancel");
    if (stateFilter === "deposit_requested") return isDepositRequested(r.state);
    if (stateFilter === "send_contract") return isSendContract(r.state);
    if (stateFilter === "pending_signed") return isPendingSignedContract(r.state);
    return true;
  });
}

export interface DayStats {
  total: number;
  totalPersons: number;
  confirmed: number;
}

export function dayStats(filtered: Reservation[]): DayStats {
  const total = filtered.length;
  const totalPersons = filtered.reduce((sum, r) => sum + (r.persons || 0), 0);
  const confirmed = filtered.filter((r) =>
    (r.state || "").toLowerCase().includes("confirm"),
  ).length;
  return { total, totalPersons, confirmed };
}

/** Weekly section row filter: group functions in confirmed / deposit-requested
 *  / contract stages only (portal filteredWeek). */
export function weekRowFilter(r: Reservation): boolean {
  if (isOnlineReservation(r)) return false;
  const s = (r.state || "").toLowerCase();
  return s.includes("confirm") || isDepositRequested(r.state) || isContractStage(r.state);
}

// ── Detail-view helpers (portal ReservationDetailPage) ───────────────

/** Products split: "Service Charges & Gratuity" vs regular. */
export function isServiceChargeProduct(name: string): boolean {
  const n = (name || "").toLowerCase();
  return n.includes("service charge") || n.includes("gratuity");
}

/** BMI-internal payment methods hidden from the payments list. */
export function isInternalPayMethod(name: string): boolean {
  const n = (name || "").toLowerCase();
  return n.includes("method -") || n.includes("method-") || n === "group function";
}
