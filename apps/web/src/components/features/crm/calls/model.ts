import type { CallRow, CallsConnectivity } from "~/features/crm/calls/contracts";

/**
 * Pure helpers behind the Calls screen (`crm-shared.js:422-425`). No hooks, no
 * fetch, no React — every one of them is unit-tested, which is the only way the
 * fiddly bits (a 0-second call, a missing status, a name that is just the
 * number again) stay right.
 */

/** `3:48` — the prototype's `dur` field, from seconds. `0:00` for a missed call. */
export function talkTime(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds ?? 0)) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The number this call was with, whichever end the guest was on. */
export function callNumber(c: Pick<CallRow, "direction" | "fromE164" | "toE164">): string | null {
  return (c.direction === "in" ? c.fromE164 : c.toE164) ?? c.fromE164 ?? c.toE164 ?? null;
}

/** `+12395551234` → `(239) 555-1234`; anything else is shown as it came. */
export function prettyNumber(e164: string | null | undefined): string {
  const v = String(e164 ?? "").trim();
  if (!v) return "Unknown";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : v;
}

/** The bold line: the caller's name when we have one, else the number. */
export function callTitle(c: CallRow): string {
  return c.guestName || c.contactLabel || prettyNumber(callNumber(c));
}

export type CallGlyph = "in" | "out" | "missed";

/** Which phone icon the row's avatar shows (`phone-in` / `phone-out` / `phone-x`). */
export function callGlyph(c: Pick<CallRow, "direction" | "status">): CallGlyph {
  if (isMissed(c)) return "missed";
  return c.direction === "in" ? "in" : "out";
}

/** Did nobody pick up? A `Dialing` click-intent is NOT a missed call yet. */
export function isMissed(c: Pick<CallRow, "status">): boolean {
  const s = String(c.status ?? "");
  return s !== "Answered" && s !== "Dialing";
}

/** The prototype's `Answered` / `Missed` / `Voicemail` word for the meta row. */
export function statusLabel(c: Pick<CallRow, "status" | "disposition">): string {
  if (c.status === "Answered") return "Answered";
  if (c.status === "Dialing") return "Dialing";
  if (c.disposition === "Voicemail") return "Voicemail";
  return "Missed";
}

/**
 * `needs disposition` — the warn timer the prototype shows on an answered call
 * with no outcome yet. A call with no lead is in the tray instead, and asking
 * for an outcome on a call that belongs to nobody would be busywork.
 */
export function needsDisposition(c: CallRow): boolean {
  return c.status === "Answered" && !c.disposition && Boolean(c.leadId);
}

/** The pill beside the title when the call is matched to nothing. */
export function callPill(c: CallRow): "Unknown" | null {
  return c.leadId ? null : "Unknown";
}

export interface ConnectivityNotice {
  tone: "warn" | "crit";
  text: string;
}

/**
 * What the screen says about 3CX, in priority order — the worst thing first,
 * and nothing at all when everything is wired.
 *
 * This is the honest-degradation the brief asks for: the journal secret is not
 * set today, so the banner is what a rep sees on day one, and it explains what
 * still works (reconcile) rather than just announcing a failure.
 */
export function connectivityNotices(c: CallsConnectivity): ConnectivityNotice[] {
  const out: ConnectivityNotice[] = [];
  if (!c.apiConfigured) {
    out.push({
      tone: "crit",
      text: "3CX is not configured — no calls will be recorded until THREECX_CLIENT_ID and THREECX_CLIENT_SECRET are set.",
    });
    return out;
  }
  if (!c.journalConfigured) {
    out.push({
      tone: "warn",
      text: "3CX journaling is not connected yet — calls appear when the reconcile job next reads the PBX, not the moment they end.",
    });
  }
  if (!c.clickToCallEnabled) {
    out.push({ tone: "warn", text: "Click-to-call is switched off — Dial hands you a tel: link." });
  } else if (!c.myExtension) {
    out.push({
      tone: "warn",
      text: "No 3CX extension on your rep record — Dial hands you a tel: link. Ask a director to set it.",
    });
  }
  return out;
}

/** Newest first; a call with no `started_at` falls back to when we recorded it. */
export function callInstant(c: Pick<CallRow, "startedAt" | "createdAt">): string {
  return c.startedAt ?? c.createdAt;
}
