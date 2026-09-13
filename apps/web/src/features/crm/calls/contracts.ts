/**
 * The calls sub's WIRE SHAPES — what `/api/admin/crm/calls/**` answers and the
 * Calls screen, the Dial sheet, the Disposition sheet and the deal's Call sheet
 * render.
 *
 * Kept here rather than appended to `core/contracts.ts` for the same reason the
 * leads sub keeps its own: parallel PRs must not all append to one file.
 * `core/types.ts` is untouched.
 *
 * CLIENT-SAFE: type-only imports from core, no Node, no Neon. Ids are strings.
 */

import type { ApiOk, PublicRep } from "../core/contracts";
import type { Direction } from "../core/types";

/** Where a `crm_calls` row came from. */
export type CallSource = "journal" | "reconcile" | "manual" | "click";

/**
 * The six outcomes, VERBATIM from the prototype (`crm-shared.js:256`):
 * "Reached", "Voicemail", "No answer", "Callback scheduled", "Wrong number",
 * "Not interested". Stored as the literal string, so the Accountability screen
 * (C7) can count them without a lookup table.
 */
export const CALL_DISPOSITIONS = [
  "Reached",
  "Voicemail",
  "No answer",
  "Callback scheduled",
  "Wrong number",
  "Not interested",
] as const;

export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export function isCallDisposition(v: unknown): v is CallDisposition {
  return typeof v === "string" && (CALL_DISPOSITIONS as readonly string[]).includes(v);
}

/** One row of the Calls list, joined to its lead, contact and rep. */
export interface CallRow {
  id: string;
  /** 3CX `CallHistoryId` — one per CALL, shared by every leg. Null on a click intent. */
  threecxCallId: string | null;
  direction: Direction;
  fromE164: string | null;
  toE164: string | null;
  /** The DN that handled it. */
  extension: string | null;
  repId: string | null;
  repSlug: string | null;
  repInitials: string | null;
  repName: string | null;
  leadId: string | null;
  /** `L-1042` — what the row links to. */
  leadPublicId: string | null;
  contactId: string | null;
  /** The account name, else the contact's name. */
  contactLabel: string | null;
  /** What the PBX called them, when it is not just the number again. */
  guestName: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** 3CX `Status`: `Answered` · `Unanswered` · `Waiting`, or `Dialing` on a click intent. */
  status: string | null;
  /** 3CX `CallType`: `Extension` · `Queue` · `External` · … */
  callType: string | null;
  disposition: CallDisposition | null;
  dispositionNote: string | null;
  disposedAt: string | null;
  disposedBy: string | null;
  /** A 3CX path, not a URL — never rendered as a link until D7 is decided. */
  recordingUrl: string | null;
  source: CallSource;
  actorEmail: string | null;
  createdAt: string;
}

/** The three tiles at the foot of the Calls screen, plus what the banner needs. */
export interface CallStatsView {
  today: number;
  reached: number;
  avgTalkSeconds: number;
  missedUnlinked: number;
  needsDisposition: number;
}

/**
 * Whether 3CX is wired up, and how much of it. The screen is honest about each
 * half: reads (the reconcile job) need only the client credential, which
 * exists; the JOURNAL needs `CRM_3CX_SECRET`, which does not yet.
 */
export interface CallsConnectivity {
  /** `THREECX_CLIENT_ID` + `THREECX_CLIENT_SECRET` are set. */
  apiConfigured: boolean;
  /** `CRM_3CX_SECRET` is set, so the PBX's CRM template can post to us. */
  journalConfigured: boolean;
  /** `CRM_CALLS !== "false"`. */
  clickToCallEnabled: boolean;
  /** The signed-in rep has a `threecx_extension`. */
  myExtension: string | null;
}

/** GET /calls?… */
export type CallsListResponse = ApiOk<{
  calls: CallRow[];
  nextCursor: string | null;
  tray: CallRow[];
  stats: CallStatsView;
  connectivity: CallsConnectivity;
  reps: PublicRep[];
}>;

/** GET /calls/badges — the sidebar badge (missed calls nobody has claimed). */
export type CallBadgesResponse = ApiOk<{ missedCalls: number }>;

/** How a dial attempt ended. */
export type DialOutcome = "ringing" | "fallback" | "disabled";

/** POST /calls/dial */
export type CallDialResponse = ApiOk<{
  call: CallRow;
  outcome: DialOutcome;
  /** Always present, so the sheet can hand the rep their phone when 3CX cannot. */
  telHref: string;
  /** Why we fell back, when we did. */
  error: string | null;
}>;

/** POST /calls/[id]/disposition */
export type CallDispositionResponse = ApiOk<{
  call: CallRow;
  /** True when this disposition became the lead's first touch. */
  firstTouchRecorded: boolean;
  /** The lead's status after the call, when the disposition moved it. */
  leadStatus: string | null;
}>;

/** POST /calls/[id]/link */
export type CallLinkResponse = ApiOk<{ call: CallRow }>;

/** The 3CX CRM-Integration template's lookup answer (PUBLIC route). */
export interface ThreecxLookupContact {
  id: string;
  firstname: string;
  lastname: string;
  phone: string;
  email: string;
  company: string;
  /** Absolute — the PBX shows it to the agent, so it must not be relative. */
  crmurl: string;
}

export interface ThreecxLookupResponse {
  contact: ThreecxLookupContact | null;
}

/** DOM test ids for the Calls surfaces. */
export const CALL_TEST_IDS = {
  screen: "crm-calls",
  list: "crm-calls-list",
  tray: "crm-calls-tray",
  stats: "crm-calls-stats",
  notConnected: "crm-calls-not-connected",
  dialSheet: "crm-dial-sheet",
  dispositionSheet: "crm-disposition-sheet",
  callRow: (id: string) => "crm-call-" + id,
} as const;

/** The banner the screen shows while `CRM_3CX_SECRET` is unset — copy is load-bearing. */
export const JOURNAL_NOT_CONNECTED = "3CX journaling is not connected yet";
