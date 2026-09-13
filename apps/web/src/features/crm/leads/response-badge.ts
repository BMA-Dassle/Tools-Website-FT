/**
 * The PURE half of response-time tracking — client-safe (no Neon), so the
 * deal header and the queue can draw the prototype's `responseBadge`
 * (crm-shared.js:199) with the same thresholds the server uses.
 * `service/response-time.ts` re-exports these beside the Neon hook.
 */

export const RESPONSE_WARN_MINUTES = 30;
export const RESPONSE_CRIT_MINUTES = 60;

/** Kinds that count as a touch when `direction === "out"`. */
export const TOUCH_KINDS = ["call", "sms", "email"] as const;

export function isOutboundTouch(a: {
  kind: string;
  direction: string | null | undefined;
}): boolean {
  return (TOUCH_KINDS as readonly string[]).includes(a.kind) && a.direction === "out";
}

/** Whole minutes from assignment to first touch; null when either is missing. */
export function firstTouchMinutes(
  assignedAt: string | Date | null | undefined,
  firstTouchAt: string | Date | null | undefined,
): number | null {
  if (!assignedAt || !firstTouchAt) return null;
  const a = new Date(assignedAt).getTime();
  const f = new Date(firstTouchAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(f)) return null;
  return Math.max(0, Math.round((f - a) / 60_000));
}

export type ResponseBadge =
  | { kind: "none" }
  | { kind: "waiting"; minutes: number; tone: "" | "warn" | "crit" }
  | { kind: "touched"; minutes: number; tone: "" | "warn" };

/** "no touch · 45 min" (waiting; >30 warn, >60 crit) or "first touch 24 min" (done; >60 warn). */
export function responseBadge(
  lead: { assignedAt: string | null; firstTouchAt: string | null },
  now: Date,
): ResponseBadge {
  if (!lead.assignedAt) return { kind: "none" };
  if (!lead.firstTouchAt) {
    const minutes = Math.max(
      0,
      Math.round((now.getTime() - new Date(lead.assignedAt).getTime()) / 60_000),
    );
    const tone =
      minutes > RESPONSE_CRIT_MINUTES ? "crit" : minutes > RESPONSE_WARN_MINUTES ? "warn" : "";
    return { kind: "waiting", minutes, tone };
  }
  const minutes = firstTouchMinutes(lead.assignedAt, lead.firstTouchAt) ?? 0;
  return { kind: "touched", minutes, tone: minutes > RESPONSE_CRIT_MINUTES ? "warn" : "" };
}
