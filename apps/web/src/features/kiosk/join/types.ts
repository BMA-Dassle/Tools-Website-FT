/**
 * Kiosk Mobile Join — shared types + constants.
 *
 * A short-lived, Redis-backed pairing session between a kiosk sitting on its
 * add-players step and any number of guest phones that scanned its QR code.
 * The kiosk owns the session lifecycle (create / poll / close); phones only
 * read meta, heartbeat, and submit one completed guest at a time. The session
 * is ephemeral by design — its output is merged into the kiosk's client-side
 * booking session, and durable records (person, waiver) are created by the
 * existing Pandora/BMI flows the phone page reuses.
 *
 * This module is imported by BOTH server and client code — types and plain
 * constants only, no crypto/redis/react.
 */

export type JoinCenter = "fort-myers" | "naples";
export type JoinBrand = "fasttrax" | "headpinz";
export type JoinStepKind = "race" | "attraction";

/** Why a session stopped accepting joins. The first four are kiosk-sent;
 *  `superseded` and `expired` are set server-side. */
export type CloseReason =
  | "continued" // kiosk user tapped Continue while phones were mid-sign-in
  | "start-over" // kiosk session reset (start over / expired reservation)
  | "idle" // kiosk idle watchdog reset
  | "done" // kiosk left the step normally (no phones active)
  | "superseded" // same kiosk opened a newer session
  | "expired"; // TTL lapse or absolute cap

/** Where a phone is in its flow — drives the kiosk's "in progress" warning.
 *  Anything other than "done" counts as in-progress while the heartbeat is
 *  fresh. */
export type ClientStage = "landing" | "signing-in" | "waiver" | "done";

export interface JoinSession {
  code: string;
  kioskId: string; // "<center>:<kioskNumber>"
  center: JoinCenter;
  brand: JoinBrand;
  stepKind: JoinStepKind;
  status: "open" | "closed";
  closeReason?: CloseReason;
  createdAt: number; // epoch ms — absolute-cap enforcement
  closedAt?: number;
}

/**
 * What a phone submits when a guest completes sign-in. PartyMember-compatible:
 * the kiosk builds a real PartyMember from this via merge.ts. All person ids
 * are digit STRINGS end-to-end (BMI ids are 17-digit and exceed
 * Number.MAX_SAFE_INTEGER — never Number() them). JSON round-trips here are
 * safe because the ids are already strings when they reach us.
 */
export interface JoinGuestPayload {
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;
  pandoraPersonId?: string;
  isNewRacer: boolean;
  category: "adult"; // phones are adults-only; minors are added at the kiosk
  memberships?: string[];
  waiverValid?: boolean;
  creditBalances?: Array<{ kind: string; balance: number }>;
  phone?: string;
  email?: string;
  /** Phone proven by the join flow's SMS OTP (returning sign-in only). */
  phoneVerified?: boolean;
  dobIso: string; // "YYYY-MM-DD" — required, drives the server-side 18+ gate
}

export interface JoinedGuest {
  joinId: string; // server-assigned; kiosk uses it for delivery dedupe
  clientId: string;
  joinedAt: number;
  guest: JoinGuestPayload;
}

export interface JoinClientPresence {
  lastSeen: number;
  stage: ClientStage;
}

export type KioskPollResult =
  | {
      status: "open";
      guests: JoinedGuest[];
      clients: { active: number; inProgress: number };
    }
  | { status: "closed"; closeReason?: CloseReason }
  | { status: "gone" };

export type GuestMetaResult =
  | {
      status: "open";
      center: JoinCenter;
      brand: JoinBrand;
      stepKind: JoinStepKind;
      splitPaymentAvailable: false; // one group, one payment — warned on both surfaces
    }
  | { status: "closed"; closeReason?: CloseReason; center: JoinCenter; brand: JoinBrand }
  | { status: "gone" };

export type SubmitGuestResult =
  | { ok: true; joinId?: string; alreadyJoined?: boolean }
  | { ok: false; error: "gone" }
  | { ok: false; error: "closed"; reason?: CloseReason }
  | { ok: false; error: "landed-late" }
  | { ok: false; error: "must-be-adult" }
  | { ok: false; error: "full" };

/** Guest-facing page the QR encodes: `${origin}${JOIN_PAGE_PATH}/${code}`.
 *  Registered as a shared top-level route in middleware.ts (hard rule). */
export const JOIN_PAGE_PATH = "/join";

/** Sliding session TTL — refreshed ONLY by the kiosk's poll, so a crashed
 *  kiosk's session dies within 5 minutes no matter how many phones poll. */
export const SESSION_TTL_SEC = 300;
/** After close, the record lingers so phones can read the close reason. */
export const CLOSED_GRACE_SEC = 120;
/** Absolute cap regardless of polling — nobody camps a code for hours. */
export const ABSOLUTE_CAP_MS = 2 * 60 * 60 * 1000;
/** A phone counts as connected while its heartbeat is younger than this
 *  (phones poll every ~5s; 30s tolerates OTP-screen tab throttling). */
export const ACTIVE_WINDOW_MS = 30_000;
/** Per-session join cap — a bigger party than this is not a kiosk party. */
export const MAX_JOINS_PER_SESSION = 25;

export const KIOSK_POLL_MS = 3_000;
export const PHONE_POLL_MS = 5_000;
