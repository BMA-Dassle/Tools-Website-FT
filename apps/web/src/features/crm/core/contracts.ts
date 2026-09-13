/**
 * THE WIRE CONTRACT between the CRM's route handlers and its client.
 *
 * Field names here are law for the server agent and the UI agent alike; a
 * change to any shape goes through the lead. DEPENDENCY-FREE by design — the
 * only import is types from `./types` — so `e2e/crm-signin.spec.ts` can import
 * `TEST_IDS` and the paths relatively without dragging Next, React or `@/`
 * aliases into Playwright.
 *
 * Ids are strings on the wire, always (17-digit BMI ids; Neon bigints as text).
 */

import type {
  CentreCode,
  CrmRole,
  CrmSettings,
  CrmStatus,
  CrmStatusInput,
  JobKind,
  JobRow,
  JobStatus,
  OfficeClientKey,
  RepRole,
  ScreenId,
  StatusBmiMapRow,
} from "./types";

/** Every CRM route handler lives under here (`/api/crm/**` is NOT used in PR1). */
export const CRM_API = "/api/admin/crm";

/** The tool's page root. In-CRM links are same-origin relative paths under it. */
export const CRM_BASE = "/admin/crm";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type ApiOk<T> = { ok: true } & T;

export interface OfficePrompt {
  message: string;
  operationId?: string;
}

export interface ApiErr {
  ok: false;
  error: string;
  /** Present when Office answered a write with its 403 confirm prompt. */
  officePrompt?: OfficePrompt;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

// ---------------------------------------------------------------------------
// People, as the client sees them
// ---------------------------------------------------------------------------

export interface PublicRep {
  id: string;
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
  role: RepRole;
  centres: CentreCode[];
}

export interface PublicCrmUser {
  email: string;
  name: string;
  role: CrmRole;
  roles: string[];
  rep: PublicRep | null;
}

export interface CentreSummary {
  code: CentreCode;
  name: string;
  short: string;
  clientKey: OfficeClientKey;
}

// ---------------------------------------------------------------------------
// Routes (PR1). Path → method → body / response.
// ---------------------------------------------------------------------------

/** GET /me */
export type MeResponse = ApiOk<{ user: PublicCrmUser }>;

/** GET /settings */
export type SettingsResponse = ApiOk<{ settings: CrmSettings }>;

/** POST /settings — director only. */
export type SettingsPostBody =
  | { key: "bmi_writes"; value: unknown }
  | { key: "sweep"; value: unknown }
  | { key: "response_target_minutes"; value: unknown };

/** GET /statuses */
export type StatusesResponse = ApiOk<{
  statuses: CrmStatus[];
  map: StatusBmiMapRow[];
  centres: CentreSummary[];
}>;

/** POST /statuses — director only. */
export type StatusesPostBody =
  | { action: "upsert"; status: CrmStatusInput }
  | { action: "reorder"; ids: string[] }
  | { action: "archive"; id: string };

export type StatusesPostResponse = ApiOk<{ statuses: CrmStatus[]; map: StatusBmiMapRow[] }>;

/** POST /statuses/map — director only. */
export interface StatusesMapPostBody {
  statusId: string;
  clientKey: string;
  bmiStateId: string;
  bmiStateName: string;
}

export type StatusesMapPostResponse = ApiOk<{ map: StatusBmiMapRow[] }>;

/** GET /statuses/office-states?centre=<CentreCode> */
export interface OfficeStateName {
  id: string;
  name: string;
}

export interface OfficeStateProposal {
  statusId: string;
  bmiStateId: string;
  bmiStateName: string;
}

export type OfficeStatesResponse = ApiOk<{
  centre: CentreCode;
  clientKey: string;
  /** "unavailable" = Office could not be reached; `states` is then empty and `error` says why. */
  source: "office" | "unavailable";
  error?: string;
  states: OfficeStateName[];
  proposals: OfficeStateProposal[];
}>;

/** GET /jobs?status=pending|running|done|failed|parked */
export type JobsQueryStatus = JobStatus;
export type JobsResponse = ApiOk<{ jobs: JobRow[] }>;

/** POST /jobs/run — director only. */
export interface JobsRunBody {
  kind: JobKind;
  payload?: Record<string, unknown>;
}

export type JobsRunResponse = ApiOk<{ job: JobRow; result: unknown }>;

/** What `kind: "noop"` returns in `result`. */
export interface NoopJobResult {
  ok: true;
  actor_email: string;
  ranAt: string;
}

// ---------------------------------------------------------------------------
// DOM test ids — shared by the shell and the Playwright proof
// ---------------------------------------------------------------------------

export const TEST_IDS = {
  app: "crm-app",
  sidebar: "crm-sidebar",
  bottomTabs: "crm-bottom-tabs",
  themeToggle: "crm-theme-toggle",
  toast: "crm-toast",
  navGroup: (id: string) => "crm-nav-group-" + id,
  navItem: (id: string) => "crm-nav-" + id,
  screen: (id: string) => "crm-screen-" + id,
  notForRole: "crm-not-for-role",
  notBuilt: "crm-not-built",
  statusesTable: "crm-statuses-table",
  bmiWritesToggle: "crm-bmi-writes-toggle",
  officeStates: "crm-office-states",
  runJob: "crm-run-job",
  runJobResult: "crm-run-job-result",
} as const;

/** The nav group that only a director sees (`TEST_IDS.navGroup(ADMIN_NAV_GROUP_ID)`). */
export const ADMIN_NAV_GROUP_ID = "admin";

/** Screens a rep may not open; the shell shows `TEST_IDS.notForRole` instead. */
export const DIRECTOR_ONLY_SCREENS: readonly ScreenId[] = ["queue", "rules", "statuses", "goals"];

// ---------------------------------------------------------------------------
// B1 — the BMI mirror: History & Accounts, "This time last year"
// ---------------------------------------------------------------------------

/** The rep chip on a mirrored event, joined from `responsible_user_id`. */
export interface MirrorRep {
  slug: string;
  firstName: string;
  initials: string;
}

/** One mirrored Office project as the History / Account screens see it. Ids are strings. */
export interface MirrorEvent {
  projectId: string;
  clientKey: string;
  /** Null when the Fort Myers split could not be decided (no schedule). */
  centre: CentreCode | null;
  /** Office reference ("H2311"). */
  number: string | null;
  name: string | null;
  /** YYYY-MM-DD */
  eventDate: string | null;
  eventStart: string | null;
  persons: number | null;
  stateId: string | null;
  stateName: string | null;
  /** `"-10"` = an online booking (kept in the mirror, hidden by the screens). */
  kindId: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  rep: MirrorRep | null;
  totalValueCents: number | null;
  balanceCents: number | null;
  personName: string | null;
  personPhone: string | null;
  personEmail: string | null;
  accountId: string | null;
  contactId: string | null;
  syncedAt: string;
}

export interface HistoryAccount {
  id: string;
  kind: "business" | "household";
  name: string;
  centre: CentreCode | null;
  lifetimeCents: number;
  eventCount: number;
  lastEventDate: string | null;
  contactNames: string[];
}

export interface HistoryContact {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  bmiPersonId: string | null;
}

export interface SyncRunSummary {
  id: string;
  clientKey: string;
  kind: string;
  windowFrom: string | null;
  windowUntil: string | null;
  rowsSeen: number | null;
  rowsUpserted: number | null;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MirrorStatus {
  /** Every row, online bookings included. */
  projects: number;
  /** Rows that are group events (`kind_id <> '-10'`). */
  groupEvents: number;
  /** Most recent sync runs, newest first. */
  runs: SyncRunSummary[];
}

/** GET /history?q=&limit=&accountsCursor=&eventsCursor= */
export type HistoryResponse = ApiOk<{
  q: string;
  accounts: HistoryAccount[];
  accountsNextCursor: string | null;
  /** Empty unless `q` was given. */
  events: MirrorEvent[];
  eventsNextCursor: string | null;
  mirror: MirrorStatus;
}>;

/** GET /accounts/[id]?limit=&cursor= */
export type AccountResponse = ApiOk<{
  account: HistoryAccount;
  contacts: HistoryContact[];
  events: MirrorEvent[];
  eventsNextCursor: string | null;
}>;

/** GET /last-year?clientKey=&limit=&cursor= */
export type LastYearResponse = ApiOk<{
  /** Inclusive ET calendar days, one year back. */
  window: { from: string; till: string };
  items: MirrorEvent[];
  nextCursor: string | null;
}>;

/** The `payload` for `POST /jobs/run {kind:"bmi-mirror-backfill"}`. */
export interface BackfillJobPayload {
  clientKey: OfficeClientKey;
  from: string;
  until: string;
}
