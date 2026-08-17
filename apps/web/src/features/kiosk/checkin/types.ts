/**
 * Payload shapes shared by the kiosk check-in API routes and the client flow.
 * Route files can only export handlers, so the contracts live here.
 *
 * PII posture: the lookup + itinerary routes are unauthenticated (kiosk-route
 * convention). Browse rows are PII-lean ("First L." + time + activities) until
 * the guest proves possession (a scanned code, or an OTP to the booking
 * contact). Only then does the itinerary route return names/contact.
 */

/** How the guest proved this reservation is theirs. `test-bypass` is the
 *  kiosk-99 OTP skip (server env allowlist) — recorded honestly so a bypassed
 *  check-in is never mistaken for a proven one in the events table.
 *
 *  `racer` is a scanned racing licence / SMS-Timing member QR: the code is the
 *  member's own secret, so possession of it is the identity (owner decision
 *  2026-07-23/24, the same bar the people-step sign-in already applies). It is
 *  its own value rather than reusing `qr` because the proof is INDIRECT — the
 *  code proves who the guest is, and the booking is then found by their
 *  contact details, which is a weaker link than a scanned reservation handle
 *  and should be distinguishable in the events table. */
export type CheckinVerifiedVia = "code" | "qr" | "otp" | "browse-otp" | "test-bypass" | "racer";

/** One "today at this center" browse row — deliberately PII-lean. */
export interface CheckinBrowseRow {
  /** Opaque handle the client passes back to `verify` — never a raw billId. */
  ref: string;
  label: string; // "Eric O."
  timeLabel: string; // "4:12 PM"
  activitiesLabel: string; // "Racing + Bowling"
  kind: "racing" | "bowling" | "attraction" | "mixed";
  /** Express Lane — every racer is a resolved returning racer with a waiver
   *  already on file, so this party needs NOTHING from the kiosk. The row shows
   *  the badge and tapping it only explains where to go: no last-4 gate, no OTP,
   *  no check-in (see `express.ts`). Racing-only; never a combo. */
  express: boolean;
  /** VIP combo booking (combo_special_id stamped on the money group at
   *  booking) — the row wears the gold ★ VIP pill. Per-RECORD truth, never a
   *  category check; decorative only (tap behavior is unchanged). */
  vip: boolean;
}

/** A PROVEN match (scan possession or phone-OTP) — opens directly. */
export interface CheckinLookupMatch {
  /** Flow proof token (bound to one billId) — pass to the itinerary route. */
  proofToken: string;
  label: string;
  timeLabel: string;
  activitiesLabel: string;
}

/** Which physical BUILDING the kiosk is in. `center` can't say this — FastTrax
 *  and HeadPinz FM share "fort-myers" — and bowling check-in is a HeadPinz-
 *  building action (owner 2026-08-16: a guest must never check in / open a
 *  HeadPinz lane from a FastTrax kiosk). Client-declared and therefore
 *  spoofable, which is fine: it gates UX confusion, not possession. */
export type CheckinKioskVenue = "FT" | "HPFM" | "HPN";

/** POST /api/kiosk/checkin/lookup request. */
export interface CheckinLookupRequest {
  center: string;
  /** One of the resolver inputs. */
  scan?: string; // raw wedge/typed payload: /s URL, W#####, r{billId}, native code
  phone?: string; // guest typed their OWN phone (already OTP-verified client-side)
  browse?: boolean; // list today's reservations
  /** Open a browse row directly WITHOUT the last-4/OTP gate — honored ONLY
   *  when `kioskId` is on the server's test-bypass allowlist. */
  ref?: string;
  /** Sender's kiosk id ("center:number") — grants nothing unless the server
   *  env KIOSK_CHECKIN_OTP_BYPASS_KIOSK_IDS lists it (default: unset, off). */
  kioskId?: string;
  /** Sending kiosk's building. "FT" suppresses bowling-only results — those
   *  guests get the "check in at HeadPinz" redirect instead of a confusing
   *  not-found. Absent = no suppression (old clients, direct API use). */
  venue?: CheckinKioskVenue;
}

export interface CheckinLookupResponse {
  ok: boolean;
  /** Proven hits (code/QR/W# possession, or a verified own-phone match). */
  matches?: CheckinLookupMatch[];
  /** Browse rows (browse:true) — unproven; open via send-otp → confirm-otp. */
  rows?: CheckinBrowseRow[];
  error?: string;
  reason?:
    | "not-found"
    | "cancelled"
    | "needs-otp"
    | "invalid"
    | "rate-limited"
    /** A racer scan resolved to a real person who has NO booking here today.
     *  Distinct from `not-found` because it is not a failure: the caller sends
     *  them to sign-in instead of showing "we couldn't find that". */
    | "no-reservation"
    /** A REAL HeadPinz bowling reservation was found, but this kiosk is in the
     *  FastTrax building — bowling check-in happens at HeadPinz (owner
     *  2026-08-16). Distinct from `not-found` so the guest is redirected
     *  instead of being told their booking doesn't exist. */
    | "bowling-elsewhere";
}

/** POST /api/kiosk/checkin/lookup?action=send-otp — text the booking contact.
 *  `last4` gates the send: the tapper must know the last 4 digits of the number
 *  on file, so a browse tap can't blind-text an arbitrary guest. */
export interface CheckinSendOtpRequest {
  center: string;
  ref: string;
  last4: string;
}
export interface CheckinSendOtpResponse {
  ok: boolean;
  /** Masked destination shown to the guest: "(239) •••-••12". */
  mask?: string;
  error?: string;
  reason?: "not-found" | "no-contact" | "rate-limited" | "mismatch";
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

// ── Party bind (POST /api/kiosk/checkin/join, proof-gated) ──────────────────
// PR2: attach the added/identified party to the reservation as BMI
// projectPersons (+ persist to Neon). Heat/lane assignment, Pandora session
// scheduling, and the -5 Arrived stamp are PR3.

/** A ready party member the client sends to be attached. */
/** One bind-ready person from a proven reservation's roster (voucher-QR party
 *  prefill). Ids flow ONLY through the proofToken-gated party action — the
 *  itinerary roster itself deliberately nulls them. */
export interface CheckinPartyMember {
  firstName: string;
  lastName?: string;
  /** 17-digit BMI Office id as a STRING; absent for bowling-only guests. */
  bmiPersonId?: string;
  waiverValid: boolean;
  /** Which source this row was resolved from — `bmi-project` means BMI holds
   *  them on the reservation, `booking-label` means the name was typed at
   *  booking and nobody was ever registered. Lets the UI say so, and makes a
   *  bad roster diagnosable without a DB probe. */
  source?: "bmi-project" | "waiver-join" | "booking-label" | "contact";
}

export type CheckinPartyResponse =
  | {
      ok: true;
      members: CheckinPartyMember[];
      /** True when BMI never answered for this project, so the roster is
       *  booking-labels-only and may be missing registered people. Previously
       *  indistinguishable from "nobody is registered" — and silent. */
      degraded?: boolean;
    }
  | { ok: false; reason: "expired-proof" | "rate-limited" | "invalid" | "disabled" };

export interface CheckinBindMember {
  /** 17-digit Office id (returning) or short Pandora id (new) — digit string. */
  bmiPersonId: string;
  /** Short Pandora id when known (for PR3 scheduling; not used by attach). */
  pandoraPersonId?: string | null;
  firstName: string;
  lastName?: string;
  waiverValid: boolean;
}

export interface CheckinBindRequest {
  center: string;
  proofToken: string;
  /** Kiosk device id ("center:kioskNumber…") for provenance. */
  kioskId?: string;
  members: CheckinBindMember[];
}

export interface CheckinBindResult {
  displayName: string;
  /** attached = on the BMI reservation; skipped = attach flag off (Neon only);
   *  failed = attach errored (recorded, guest unaffected, staff reconcile). */
  attach: "attached" | "skipped" | "failed";
}

export interface CheckinBindResponse {
  ok: boolean;
  results?: CheckinBindResult[];
  error?: string;
  reason?: "expired-proof" | "no-members" | "cancelled";
}

// ── Complete ("check in everyone") — POST /api/kiosk/checkin/complete ────────
export interface CheckinCompleteResponse {
  ok: boolean;
  alreadyComplete?: boolean;
  /** True when this call finalized people added AFTER an earlier finalize — the
   *  late half of a party checking in separately. The done screen says so, so
   *  "2 added" can't be misread as "the whole party is on the grid". */
  resumed?: boolean;
  /** Racers added to their Pandora session this call. */
  scheduled?: number;
  /** Racers that couldn't be scheduled (sync lag) — escalated to a staff memo. */
  scheduleUnlinked?: string[];
  /** True when the BMI project was stamped -5 "Arrived". */
  stateStamped?: boolean;
  /** Whether the done screen may interactively open bowling lanes (mirrors the
   *  check-in attach gate — dark until enabled, so staff testing fires no KDS). */
  laneOpenEnabled?: boolean;
  error?: string;
  reason?: "expired-proof" | "cancelled" | "busy";
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
  /** Bowling only: this leg takes the kiosk bowler-details check-in (names /
   *  shoe sizes / bumpers). True only for HeadPinz FM + Naples lanes — never
   *  FastTrax duckpin (owner rule 2026-08-16). The done-screen lane-open panel
   *  is NOT gated on this; it keeps its existing behavior. */
  bowlingCheckinEligible?: boolean;
}

export interface CheckinRosterPerson {
  personId: string | null;
  pandoraPersonId: string | null;
  displayName: string;
  waiverValid: boolean;
  /** What they're already bound to, for the party panel. */
  boundTo: string[];
}

/** One purchased race slot on the reservation — the unit the guest assigns a
 *  person to at check-in ("who is who"). `slotKey` is a stable UNIQUE id per
 *  seat (two racers in the same heat share a `heatId` but never a `slotKey`);
 *  `heatId` is the naive-ET block start, used only for scheduling. */
export interface CheckinRaceSlot {
  slotKey: string;
  heatId: string;
  productId: string | null;
  /** Human label for the picker: "Starter Junior · Blue". */
  classLabel: string;
  tier: string;
  /** The class this slot is FOR — a junior slot only accepts a junior. */
  category: "adult" | "junior";
  track: string | null;
  timeLabel: string;
  /** Name already bound to this slot (booker / web-identified racer), else null. */
  occupantName: string | null;
  /** True when no bmiPersonId is bound yet — assignable at the kiosk. */
  open: boolean;
}

/** A guest's person→slot choice sent to /complete. */
export interface CheckinSlotAssignment {
  /** Unique seat id (matches CheckinRaceSlot.slotKey), NOT the shared heatId. */
  slotKey: string;
  /** SHORT Pandora id preferred, else the 17-digit Office id — matched to the
   *  bound person row server-side. */
  personId: string;
  /** The racer's resolved class — the server rejects the assignment if it
   *  doesn't match the slot's class (defense in depth; null = unknown, allowed). */
  category?: "adult" | "junior" | null;
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
  /** Purchased race slots (racing reservations only) — the "who is who"
   *  assignment surface. Empty for non-racing. */
  raceSlots: CheckinRaceSlot[];
  /** Express Lane, judged on LIVE waiver truth (every racer identified + a
   *  currently-valid Pandora waiver, racing-only). True = this party skips
   *  check-in: the flow shows them where to go instead of continuing. Stricter
   *  than the browse row's booking-time flag — it catches a lapsed waiver. */
  express: boolean;
  /** Display-only balance banner (no money is collected at the kiosk). */
  dueAtCenterCents: number;
  error?: string;
  reason?: "not-found" | "cancelled" | "expired-proof";
}
