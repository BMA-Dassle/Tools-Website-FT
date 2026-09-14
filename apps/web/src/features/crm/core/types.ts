/**
 * The Sales CRM's shared vocabulary — every sub-feature speaks these types.
 *
 * APPEND-ONLY after PR1 (brief §4 "Shared files"): a later PR adds new exported
 * types at the END of this file and never edits an existing one; a change to an
 * existing shape goes to the lead first. Field names follow the prototype
 * (`crm-data.js:33-41`, `crm-shared.js:176-196`) so `assignDecision` and the
 * board port line for line.
 *
 * NO IMPORTS, on purpose. `contracts.ts` (the wire contract) imports only from
 * here and is in turn imported relatively by the Playwright spec, so this file
 * must stay free of aliases, React, Next and Node.
 *
 * IDS ARE STRINGS. Every BMI / Pandora / Square / Graph / 3CX / Vox id is a
 * string (17-digit BMI ids exceed Number.MAX_SAFE_INTEGER — CLAUDE.md hard
 * rule), and so is every Neon BIGSERIAL id on the wire: the neon driver
 * returns bigint columns as text and the client never needs arithmetic on them.
 */

// ---------------------------------------------------------------------------
// Centres
// ---------------------------------------------------------------------------

/** The three selling centres. FT shares HPFM's Office server (clientKey). */
export type CentreCode = "HPFM" | "FT" | "HPN";

/** The booking stack's centre slug (`lib/bmi-office-actions.ts` CLIENT_KEYS keys). */
export type CenterSlug = "fort-myers" | "fasttrax" | "naples";

/** The Office (sms-timing) tenant key. */
export type OfficeClientKey = "headpinzftmyers" | "headpinznaples";

export interface Centre {
  code: CentreCode;
  /** "HeadPinz Fort Myers" */
  name: string;
  /** "HP Fort Myers" — chips and tabs */
  short: string;
  /** Portal / 7shifts / daily-events location id (332160 | 467486 | 332145). */
  locationId: 332160 | 467486 | 332145;
  clientKey: OfficeClientKey;
  centerCode: CenterSlug;
  /** Pandora alphanumeric location id (= the Square location id). */
  pandoraLocationId: string;
  /** QubicaAMF centre id for lane availability. */
  qamfCenterId: 9172 | 11542 | 3148;
  /** Same number as `locationId` — named separately because the 7shifts client reads it. */
  sevenShiftsLocationId: 332160 | 467486 | 332145;
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type RepRole = "rep" | "bucket" | "hold" | "director";
export const REP_ROLES = [
  "rep",
  "bucket",
  "hold",
  "director",
] as const satisfies readonly RepRole[];

export type LeadSource = "web" | "phone" | "walkin" | "cold" | "historical" | "referral";
export const LEAD_SOURCES = [
  "web",
  "phone",
  "walkin",
  "cold",
  "historical",
  "referral",
] as const satisfies readonly LeadSource[];

export type EventType = "corporate" | "birthday" | "team" | "school" | "fundraiser" | "holiday";
export const EVENT_TYPES = [
  "corporate",
  "birthday",
  "team",
  "school",
  "fundraiser",
  "holiday",
] as const satisfies readonly EventType[];

export type StatusKind = "open" | "won" | "lost";
export const STATUS_KINDS = ["open", "won", "lost"] as const satisfies readonly StatusKind[];

export type ActivityKind =
  | "call"
  | "sms"
  | "email"
  | "note"
  | "reachout"
  | "status"
  | "assign"
  | "bmi"
  | "payment"
  | "system";
export const ACTIVITY_KINDS = [
  "call",
  "sms",
  "email",
  "note",
  "reachout",
  "status",
  "assign",
  "bmi",
  "payment",
  "system",
] as const satisfies readonly ActivityKind[];

export type Direction = "in" | "out";

/** `"none"` = a prospect (cold / historical row) with no BMI project yet. */
export type MintStatus = "none" | "pending" | "minted" | "failed";

/** The CRM's two in-app roles; derived from the SSO roles, never stored. */
export type CrmRole = "rep" | "director";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** A `crm_reps` row. Buckets (Guest Services) and holds (Marketing) are reps too. */
export interface CrmRep {
  id: string;
  /** 'kelsea' | 'lori' | 'stephanie' | 'gs' | 'mkt' | 'jacob' | 'eric' */
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
  role: RepRole;
  /** Primary mailbox (Graph sender). NULL for a hold/bucket without one. */
  email: string | null;
  /** Auth.js `session.sub` (= Entra oid) captured on first sign-in. */
  ssoSub: string | null;
  /** Office user id as text ('28267036'); the KPI attribution key. */
  bmiUserId: string | null;
  /**
   * Office user id PER TENANT — `{clientKey: id}`.
   *
   * The same person has a different id on each Office server (Kelsea is
   * 28267036 at Fort Myers and 6338800 at Naples), so a write addressed with
   * the wrong one is refused with a foreign-key violation. `bmiUserId` remains
   * the fallback and the KPI attribution key; this is what a WRITE resolves
   * through. See `bmiUserIdFor`.
   */
  bmiUserIds: Record<string, string> | null;
  /** Office responsible display name — the substring Pandora's `agent` matches. */
  bmiUsername: string | null;
  sevenShiftsUserId: number | null;
  voxDid: string | null;
  threecxExtension: string | null;
  teamsChatId: string | null;
  phoneE164: string | null;
  centres: CentreCode[];
  active: boolean;
  sortOrder: number;
}

/** The signed-in person, as every page and route handler sees them (§3.3). */
export interface CrmUser {
  /** Lowercased; the join key to crm_reps / crm_rep_logins. */
  email: string;
  name: string;
  /** Auth.js token.sub surfaced by the session callback (= Entra oid); null when absent. */
  sub: string | null;
  /** Raw cookie roles, e.g. ["access","sales"]. */
  roles: string[];
  role: CrmRole;
  /** crm_reps row via crm_rep_logins.email; null for a director with no rep row. */
  rep: CrmRep | null;
}

// ---------------------------------------------------------------------------
// Statuses (our pipeline) and the BMI state map
// ---------------------------------------------------------------------------

export interface CrmStatus {
  /** 'new' | 'assigned' | 'contacted' | 'waiting' | 'quote' | 'contract' | 'deposit' | 'confirmed' | 'lost' | 'noresp' */
  id: string;
  label: string;
  kind: StatusKind;
  position: number;
  /** "1 h to first touch" — the SLA copy the board shows. */
  slaLabel: string | null;
  slaHours: number | null;
  /** False for the statuses the board folds into synthetic Booked/Closed columns. */
  onBoard: boolean;
  archivedAt: string | null;
}

/** What the director's Statuses screen sends on upsert. */
export interface CrmStatusInput {
  id: string;
  label: string;
  kind: StatusKind;
  position?: number;
  slaLabel?: string | null;
  slaHours?: number | null;
  onBoard?: boolean;
}

/** One row of `crm_status_bmi_map`: our status → one Office state per tenant. */
export interface StatusBmiMapRow {
  statusId: string;
  clientKey: OfficeClientKey;
  bmiStateId: string;
  bmiStateName: string;
}

// ---------------------------------------------------------------------------
// Leads, contacts, accounts, activities
// ---------------------------------------------------------------------------

export interface CrmContact {
  id: string;
  accountId: string | null;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  bmiPersonId: string | null;
  prefers: "text" | "call" | "email" | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmAccount {
  id: string;
  kind: "business" | "household";
  name: string;
  nameKey: string;
  centre: CentreCode | null;
  lifetimeCents: number;
  meta: Record<string, unknown> | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NextAction {
  kind: string;
  /** ISO instant (UTC) */
  due: string;
  label: string | null;
}

export interface LeadBmiRef {
  projectId: string | null;
  projectNumber: string | null;
  stateId: string | null;
  stateName: string | null;
  personId: string | null;
  syncedAt: string | null;
}

export interface CrmLead {
  id: string;
  /** 'L-1042' style — the URL id. */
  publicId: string;
  contactId: string | null;
  accountId: string | null;
  centre: CentreCode;
  /** YYYY-MM-DD */
  eventDate: string;
  /** HH:MM or null */
  eventTime: string | null;
  guests: number;
  type: EventType;
  source: LeadSource;
  isProspect: boolean;
  status: string;
  rep: string | null;
  assignedAt: string | null;
  heldForRep: string | null;
  firstTouchAt: string | null;
  /**
   * When the guest was told who is running their event. A lead nobody owns yet
   * HOLDS that welcome text and email until a planner picks it up, so this is
   * null on a held lead and the stamp that stops it being sent twice.
   */
  guestIntroAt: string | null;
  nextAction: NextAction | null;
  valueCents: number;
  lostReason: string | null;
  notes: string | null;
  bmi: LeadBmiRef;
  mintStatus: MintStatus;
  mintError: string | null;
  mintAttempts: number;
  gfShortId: string | null;
  lastYearBmiProjectId: string | null;
  coldRowId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CrmActivity {
  id: string;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  actorEmail: string | null;
  kind: ActivityKind;
  direction: Direction | null;
  occurredAt: string;
  durationSeconds: number | null;
  outcome: string | null;
  subject: string | null;
  body: string | null;
  externalKind: string | null;
  externalRef: string | null;
  meta: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Assignment rules (crm-data.js:33-41, crm-shared.js:176-196)
// ---------------------------------------------------------------------------

export type RuleKind = "hold" | "route" | "avail" | "standard" | "fallback";

export interface RuleWhen {
  guestsMin?: number;
  guestsMax?: number;
  type?: EventType;
  kids?: boolean;
  centre?: CentreCode;
  source?: LeadSource;
  /** "2026-10" */
  partyMonth?: string;
}

export interface RuleThen {
  /** rep id to hold the lead for */
  hold?: string;
  /** rep id to route the lead to */
  route?: string;
  skipOff?: boolean;
  onShift?: boolean;
  standard?: boolean;
  queue?: boolean;
}

export interface AssignmentRule {
  id: string;
  position: number;
  enabled: boolean;
  kind: RuleKind;
  label: string;
  why: string | null;
  when: RuleWhen;
  then: RuleThen;
}

export interface RuleTraceStep {
  ruleId: string;
  hit: boolean;
  note?: string;
}

export interface AssignDecision {
  rep: CrmRep | null;
  reason: string;
  trace: RuleTraceStep[];
  finalRuleId?: string;
}

// ---------------------------------------------------------------------------
// Contracts (group_function_quotes.status — crm-events.js:9-21)
// ---------------------------------------------------------------------------

export type GfStatus =
  | "pending"
  | "pending_approval"
  | "contract_sent"
  | "deposit_paid"
  | "resign_required"
  | "balance_charged"
  | "balance_link_sent"
  | "completed"
  | "cancelled"
  | "denied"
  | "expired";

export type ChipKind = "open" | "won" | "lost" | "warn";

export interface GfStatusMeta {
  label: string;
  kind: ChipKind;
  help: string;
}

/** Verbatim from the prototype. `balance_charged` is "Balance funded", never "Fully Paid". */
export const GF_STATUS_META: Record<GfStatus, GfStatusMeta> = {
  pending: {
    label: "Pending",
    kind: "warn",
    help: "Quote created from BMI; contract not yet sent",
  },
  pending_approval: {
    label: "Needs approval",
    kind: "warn",
    help: "Post-paid account — Jacob or Eric must approve before it sends",
  },
  contract_sent: {
    label: "Contract sent",
    kind: "open",
    help: "Guest has the 5-step signing page; nothing signed yet",
  },
  deposit_paid: {
    label: "Deposit paid",
    kind: "won",
    help: "Signed and 50% deposit collected; balance auto-charges at T-72h",
  },
  resign_required: {
    label: "Re-sign required",
    kind: "lost",
    help: "Price or products changed after signing; guest must sign again",
  },
  balance_charged: {
    label: "Balance funded",
    kind: "won",
    help: "Balance charged and loaded to the day-of gift card (not yet settled at the POS)",
  },
  balance_link_sent: {
    label: "Balance link sent",
    kind: "warn",
    help: "Card failed or none on file; guest has a Square payment link",
  },
  completed: {
    label: "Completed",
    kind: "won",
    help: "Event happened and the day-of order closed",
  },
  cancelled: {
    label: "Cancelled",
    kind: "lost",
    help: "BMI state Cancellation; deposits refunded",
  },
  denied: {
    label: "Denied",
    kind: "lost",
    help: "Post-paid approval denied; planner notified",
  },
  expired: { label: "Expired", kind: "lost", help: "Contract link expired unsigned" },
};

export const GF_STATUSES = Object.keys(GF_STATUS_META) as GfStatus[];

// ---------------------------------------------------------------------------
// Settings (crm_settings)
// ---------------------------------------------------------------------------

export interface BmiWritesSetting {
  enabled: boolean;
  /** Office clientKeys paused individually. */
  offCentres: string[];
}

/**
 * The assign sweep's one knob. It is a SAFETY NET, not a delay (owner,
 * 2026-09-13 14:50): the rules assign at capture, and `delayMinutes` says only
 * how long a lead that arrived unassigned waits before the net retries it.
 *
 * `afterHours` ("hold until 9 AM") is GONE — it described a rail that no
 * longer exists, and R5 already answers "nobody is on shift now" by picking
 * whoever works next. A stored value is stripped from the row by
 * `ensureSettingsSchema` and ignored by `sweepFromSetting`.
 */
export interface SweepSetting {
  delayMinutes: number;
}

export interface CrmSettings {
  bmiWrites: BmiWritesSetting;
  sweep: SweepSetting;
  responseTargetMinutes: number;
}

export type CrmSettingKey = "bmi_writes" | "sweep" | "response_target_minutes";

// ---------------------------------------------------------------------------
// Jobs (crm_jobs) — §3.5 registry list plus "seed"
// ---------------------------------------------------------------------------

export const JOB_KINDS = [
  "noop",
  "seed",
  "mint-bmi-project",
  "assign-sweep",
  "sevenshifts-mirror",
  "bmi-mirror-delta",
  "bmi-mirror-backfill",
  "graph-renew",
  "graph-fetch-message",
  "threecx-reconcile",
  "share-link-expire",
  "email-send-retry",
  "sms-send-retry",
  "pandora-goals-sync",
  // B5 (append-only, brief §4 "Shared files"): the contract rail's two kinds.
  // `contract-cancel-verify` proves a `-4` that Pandora answered 200 to but
  // Office had not yet shown; `seed-test-quote` makes the director-only
  // pending_approval fixture the approve smoke needs.
  "contract-cancel-verify",
  "seed-test-quote",
  // A held welcome that nobody has picked up. Holding the guest's text and
  // email until a planner owns the lead is right; holding them for ever is
  // silence, so this is the deadline that ends the wait.
  "guest-intro-backstop",
  // Our status and the contract are written by different rails (a rep drags
  // the board; the contract moves when the guest signs or pays), so a deal
  // that progressed through the guest's own actions drifts. Forward only.
  "lead-status-reconcile",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export type JobStatus = "pending" | "running" | "done" | "failed" | "parked";
export const JOB_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "parked",
] as const satisfies readonly JobStatus[];

export interface JobRow {
  id: string;
  kind: JobKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leasedUntil: string | null;
  lastError: string | null;
  result: unknown;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Screens — the in-app router's vocabulary (§3.1 URL scheme)
// ---------------------------------------------------------------------------

export const SCREEN_IDS = [
  "today",
  "pipeline",
  "queue",
  "deal",
  "contracts",
  "events",
  "conversations",
  "calls",
  "history",
  "account",
  "cold",
  "collateral",
  "accountability",
  "kpi",
  "goals",
  "rules",
  "statuses",
  "availability",
  "builder",
  "more",
] as const;

export type ScreenId = (typeof SCREEN_IDS)[number];
