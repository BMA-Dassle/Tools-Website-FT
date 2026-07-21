/**
 * Payload shapes shared by the kiosk check-in API routes and the client flow.
 * Route files can only export handlers, so the contracts live here.
 *
 * PII posture: the lookup + itinerary routes are unauthenticated (kiosk-route
 * convention). Browse rows are PII-lean ("First L." + time + activities) until
 * the guest proves possession (a scanned code, or an OTP to the booking
 * contact). Only then does the itinerary route return names/contact.
 */

/** How the guest proved this reservation is theirs. */
export type CheckinVerifiedVia = "code" | "qr" | "otp" | "browse-otp";

/** One "today at this center" browse row — deliberately PII-lean. */
export interface CheckinBrowseRow {
  /** Opaque handle the client passes back to `verify` — never a raw billId. */
  ref: string;
  label: string; // "Eric O."
  timeLabel: string; // "4:12 PM"
  activitiesLabel: string; // "Racing + Bowling"
  kind: "racing" | "bowling" | "attraction" | "mixed";
}

/** A PROVEN match (scan possession or phone-OTP) — opens directly. */
export interface CheckinLookupMatch {
  /** Flow proof token (bound to one billId) — pass to the itinerary route. */
  proofToken: string;
  label: string;
  timeLabel: string;
  activitiesLabel: string;
}

/** POST /api/kiosk/checkin/lookup request. */
export interface CheckinLookupRequest {
  center: string;
  /** One of the resolver inputs. */
  scan?: string; // raw wedge/typed payload: /s URL, W#####, r{billId}, native code
  phone?: string; // guest typed their OWN phone (already OTP-verified client-side)
  browse?: boolean; // list today's reservations
}

export interface CheckinLookupResponse {
  ok: boolean;
  /** Proven hits (code/QR/W# possession, or a verified own-phone match). */
  matches?: CheckinLookupMatch[];
  /** Browse rows (browse:true) — unproven; open via send-otp → confirm-otp. */
  rows?: CheckinBrowseRow[];
  error?: string;
  reason?: "not-found" | "cancelled" | "needs-otp" | "invalid" | "rate-limited";
}

/** POST /api/kiosk/checkin/lookup?action=send-otp — text the booking contact. */
export interface CheckinSendOtpRequest {
  center: string;
  ref: string;
}
export interface CheckinSendOtpResponse {
  ok: boolean;
  /** Masked destination shown to the guest: "(239) •••-••12". */
  mask?: string;
  error?: string;
  reason?: "not-found" | "no-contact" | "rate-limited";
}

/** POST /api/kiosk/checkin/lookup?action=confirm-otp — verify the texted code. */
export interface CheckinConfirmOtpRequest {
  center: string;
  ref: string;
  code: string;
}
export interface CheckinConfirmOtpResponse {
  ok: boolean;
  proofToken?: string;
  error?: string;
  attemptsLeft?: number;
}

// ── Itinerary envelope (GET /api/kiosk/checkin/itinerary, proof-gated) ──────

export type CheckinActivityKind = "racing" | "bowling" | "attraction";

export interface CheckinRacer {
  /** Local-stable display id (never a session party id from another context). */
  name: string;
  bmiPersonId: string | null;
  ready: boolean; // identified + waiver valid + scheduled
}

export interface CheckinActivity {
  kind: CheckinActivityKind;
  /** Sort/display key — naive-ET wall-clock ISO (format as UTC, never ET tz). */
  startIso: string | null;
  timeLabel: string;
  title: string; // "Race 1 · Blue Track"
  building: string; // "Gel Blaster Arena"
  slug: string | null; // attraction/experience slug for photo/color
  /** Readiness summary for the status chip. */
  readyCount: number;
  totalCount: number;
  /** Bowling lane phase, when applicable (from the checkin GET derivation). */
  lanePhase?: "not_ready" | "ready" | "running" | "completed" | "cancelled";
  laneLabel?: string;
  neonReservationId?: number;
}

export interface CheckinRosterPerson {
  personId: string | null;
  pandoraPersonId: string | null;
  displayName: string;
  waiverValid: boolean;
  /** What they're already bound to, for the party panel. */
  boundTo: string[];
}

export interface CheckinItinerary {
  ok: boolean;
  // NOTE: the raw billId / officeProjectId are deliberately NOT returned to the
  // client — they are enumerable BMI bigints and PR1 is read-only, so the
  // client never needs them. A later mutation PR resolves billId server-side
  // from the proof token instead of round-tripping it through the browser.
  reservationNumber: string | null;
  center: string;
  firstName: string;
  activities: CheckinActivity[];
  /** activities[0] — the "Start here · First stop" card. */
  firstStop: {
    building: string;
    arriveByLabel: string | null;
  } | null;
  roster: CheckinRosterPerson[];
  /** Display-only balance banner (no money is collected at the kiosk). */
  dueAtCenterCents: number;
  error?: string;
  reason?: "not-found" | "cancelled" | "expired-proof";
}
