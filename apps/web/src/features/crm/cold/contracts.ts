/**
 * The cold sub's WIRE SHAPES — what `/api/admin/crm/cold/**` answers, and what
 * the Cold lists screen, the list screen, the Import sheet and the Disposition
 * and Convert sheets render (`crm-shared.js:439-443`).
 *
 * CLIENT-SAFE: type-only imports plus one pure value import, no Node, no Neon,
 * no sub barrel (§5.7b — a barrel drags ioredis into the browser bundle and the
 * Vercel build dies). `CALL_DISPOSITIONS` is taken from the calls sub's own
 * pure `contracts.ts` BY PATH for exactly that reason; importing
 * `~/features/crm/calls` here would reach `service/threecx.ts`.
 *
 * Ids are strings on the wire, always.
 */

import { CALL_DISPOSITIONS, type CallDisposition } from "../calls/contracts";
import type { ApiOk, PublicRep } from "../core/contracts";
import type { CentreCode, EventType } from "../core/types";

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

/**
 * The one outcome a cold row has that a call row does not: the prospect showed
 * real interest, which is the moment a BMI project may be minted (and not
 * before — a cold row is a PROSPECT, brief §4 C8 / memory "cold + historical =
 * prospects, no BMI until converted").
 */
export const COLD_INTERESTED = "Interested";

/**
 * The dialling list's vocabulary: the SAME six outcomes the Calls screen uses,
 * with "Interested" in front of them. Reusing `CALL_DISPOSITIONS` verbatim is
 * deliberate — the Accountability and KPI screens (C7) count `crm_activities`
 * rows by `outcome`, and a seventh spelling of "Voicemail" would need a
 * special case there.
 */
export const COLD_DISPOSITIONS = [COLD_INTERESTED, ...CALL_DISPOSITIONS] as const;

export type ColdDisposition = typeof COLD_INTERESTED | CallDisposition;

export function isColdDisposition(v: unknown): v is ColdDisposition {
  return typeof v === "string" && (COLD_DISPOSITIONS as readonly string[]).includes(v);
}

/** The outcome that needs a date: "Callback scheduled" (the prototype's "call in Jan"). */
export const COLD_CALLBACK: ColdDisposition = "Callback scheduled";

/** Outcomes that mean this row is finished with. */
export const COLD_CLOSED_DISPOSITIONS: readonly ColdDisposition[] = [
  "Wrong number",
  "Not interested",
];

// ---------------------------------------------------------------------------
// Column mapping (decision D9 is OPEN — nothing here is a hard-coded schema)
// ---------------------------------------------------------------------------

/**
 * The fields a cold row can carry. The operator maps THEIR file's columns onto
 * these on the Import sheet; nothing assumes a column order, a header spelling
 * or even that the file has a header row.
 *
 * `contactName` and the `firstName`/`lastName` pair are alternatives — a file
 * that splits the name gets both halves mapped and the projection joins them.
 */
export const COLD_FIELDS = [
  "company",
  "contactName",
  "firstName",
  "lastName",
  "phone",
  "email",
  "city",
  "notes",
  "bmiPersonId",
] as const;

export type ColdField = (typeof COLD_FIELDS)[number];

/** field → the header it reads, or null for "(skip)". Every field is optional. */
export type ColdColumnMap = Partial<Record<ColdField, string | null>>;

/** What the operator sees beside each field on the mapping screen. */
export const COLD_FIELD_LABEL: Record<ColdField, string> = {
  company: "Company",
  contactName: "Contact",
  firstName: "First name",
  lastName: "Last name",
  phone: "Phone",
  email: "Email",
  city: "City",
  notes: "Notes",
  bmiPersonId: "BMI person id",
};

/** How the file was read — kept on the list so a re-map can explain itself. */
export interface ColdParseMeta {
  /** "," | ";" | "\t" | "|" */
  delimiter: string;
  hadBom: boolean;
  /** False when the operator said "the first row is data". */
  hasHeaderRow: boolean;
  /** Rows the parser dropped because every cell was empty. */
  blankRows: number;
  /** Rows whose cell count did not match the header count. */
  raggedRows: number;
  /** Bytes of the original file, for the list's footnote. */
  bytes: number;
}

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------

/**
 * Which key matched, in the order the rest of the CRM matches people:
 * `bmi_person_id` (the Office identity), then `phone_e164`
 * (`upsertContact`'s first key), then `email_key` (its second), then the
 * account's `name_key` (`accountNameKey`). `in_file` is not a CRM match at
 * all — it means the SAME phone or email appears twice in the uploaded file.
 */
export const COLD_MATCH_KEYS = [
  "bmi_person_id",
  "phone",
  "email",
  "account_name",
  "in_file",
] as const;

export type ColdMatchKey = (typeof COLD_MATCH_KEYS)[number];

export const COLD_MATCH_LABEL: Record<ColdMatchKey, string> = {
  bmi_person_id: "BMI person id",
  phone: "Phone",
  email: "Email",
  account_name: "Company name",
  in_file: "Duplicate in this file",
};

/** What the operator chose for a row that matched something. */
export const COLD_DECISIONS = ["link", "skip", "new"] as const;
export type ColdDecision = (typeof COLD_DECISIONS)[number];

export const COLD_DECISION_LABEL: Record<ColdDecision, string> = {
  link: "Link to the existing record",
  skip: "Skip this row",
  new: "Import anyway as a new prospect",
};

// ---------------------------------------------------------------------------
// Rows and lists
// ---------------------------------------------------------------------------

/** A `crm_cold_rows` row as the dialling list draws it. */
export interface ColdRowView {
  id: string;
  listId: string;
  /** 1-based line in the uploaded file (excluding the header). */
  rowIndex: number;
  company: string | null;
  contactName: string | null;
  /** Canonical, dialable. Null when the file's number could not be read. */
  phoneE164: string | null;
  /** Exactly what the file said, kept whatever happened to it. */
  phoneRaw: string | null;
  email: string | null;
  city: string | null;
  notes: string | null;
  bmiPersonId: string | null;
  accountId: string | null;
  accountName: string | null;
  contactId: string | null;
  leadId: string | null;
  leadPublicId: string | null;
  matchedBy: ColdMatchKey | null;
  decision: ColdDecision;
  /** "staged" until the mapping is committed; "skipped" when the operator said so. */
  status: ColdRowStatus;
  disposition: ColdDisposition | null;
  dispositionNote: string | null;
  dispositionAt: string | null;
  dispositionBy: string | null;
  callbackAt: string | null;
  /** How many dispositions this row has had; the activity's dedupe key. */
  touchCount: number;
  createdAt: string;
}

export const COLD_ROW_STATUSES = ["staged", "ready", "skipped"] as const;
export type ColdRowStatus = (typeof COLD_ROW_STATUSES)[number];

/** The dialling list's segmented filter; lives here so the screen can read it. */
export const COLD_ROW_FILTERS = [
  "all",
  "todo",
  "interested",
  "callbacks",
  "matched",
  "skipped",
] as const;

export type ColdRowFilter = (typeof COLD_ROW_FILTERS)[number];

export const COLD_FILTER_LABEL: Record<ColdRowFilter, string> = {
  all: "All",
  todo: "Not called",
  interested: "Interested",
  callbacks: "Callbacks",
  matched: "Matched",
  skipped: "Skipped",
};

export function isColdRowFilter(v: unknown): v is ColdRowFilter {
  return typeof v === "string" && (COLD_ROW_FILTERS as readonly string[]).includes(v);
}

export const COLD_LIST_STATUSES = ["staged", "ready"] as const;
export type ColdListStatus = (typeof COLD_LIST_STATUSES)[number];

/** The per-list counters the lists screen and the detail tiles read. */
export interface ColdListStats {
  /** Rows that count: everything but `skipped`. */
  rows: number;
  skipped: number;
  /** Rows with any disposition. */
  called: number;
  interested: number;
  /** Rows that became a `crm_leads` row. */
  converted: number;
  /** Converted rows whose lead reached a `won` status. */
  booked: number;
  /** Rows matched to an account or contact we already had. */
  linked: number;
  /** Rows with a dialable number. */
  dialable: number;
  /** Callbacks whose time has come. */
  callbacksDue: number;
}

export interface ColdListView {
  id: string;
  name: string;
  status: ColdListStatus;
  centre: CentreCode | null;
  ownerRepId: string | null;
  ownerRepSlug: string | null;
  ownerRepName: string | null;
  ownerRepInitials: string | null;
  sourceFilename: string | null;
  columnMap: ColdColumnMap | null;
  parseMeta: ColdParseMeta | null;
  headers: string[];
  rowCount: number;
  importedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  stats: ColdListStats;
}

export const EMPTY_COLD_STATS: ColdListStats = Object.freeze({
  rows: 0,
  skipped: 0,
  called: 0,
  interested: 0,
  converted: 0,
  booked: 0,
  linked: 0,
  dialable: 0,
  callbacksDue: 0,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** GET /cold */
export type ColdListsResponse = ApiOk<{
  lists: ColdListView[];
  reps: PublicRep[];
}>;

/** GET /cold/[id]?cursor=&limit=&filter= */
export type ColdListResponse = ApiOk<{
  list: ColdListView;
  rows: ColdRowView[];
  nextCursor: string | null;
  /** The next row worth ringing, for "Dial next". Null when there is none. */
  next: ColdRowView | null;
  reps: PublicRep[];
}>;

/** POST /cold — `{action:"create"}`. The list exists before a single row lands. */
export type ColdCreateResponse = ApiOk<{ list: ColdListView }>;

/** POST /cold/[id]/rows — one chunk of the upload. */
export type ColdRowsAppendResponse = ApiOk<{
  inserted: number;
  /** Running total on the list. */
  rowCount: number;
}>;

/**
 * What a mapping pass found. Returned by `{action:"map"}` and again by
 * `{action:"commit"}` so the sheet can show the same table after committing.
 */
export interface ColdImportReport {
  rows: number;
  /** Rows whose phone cell was filled but unreadable as a number. */
  undialable: number;
  withPhone: number;
  withEmail: number;
  /** Rows that matched something we already had. */
  matched: number;
  /** Rows that duplicate another row in the SAME file. */
  duplicatesInFile: number;
  /** Rows with nothing to dial and nothing to write to. */
  unreachable: number;
  /** The review table: only the rows that matched something. */
  matches: ColdRowView[];
}

export type ColdMapResponse = ApiOk<{ list: ColdListView; report: ColdImportReport }>;

export type ColdCommitResponse = ApiOk<{
  list: ColdListView;
  report: ColdImportReport;
  linked: number;
  skipped: number;
  imported: number;
}>;

/** POST /cold/[id]/rows/[rowId] — disposition. */
export type ColdDispositionResponse = ApiOk<{
  row: ColdRowView;
  list: ColdListView;
  /** True when the disposition also created the prospect's lead. */
  converted: boolean;
}>;

/** POST /cold/[id]/rows/[rowId] — convert. */
export type ColdConvertResponse = ApiOk<{
  row: ColdRowView;
  list: ColdListView;
  leadId: string;
  leadPublicId: string;
  /** `none` when the lead stayed a prospect; otherwise the mint's own word. */
  mintStatus: string;
  mintError: string | null;
  /** Who the rules picked, when they picked anybody. */
  assignedRepName: string | null;
}>;

/** What the convert sheet sends: the event the prospect just expressed interest in. */
export interface ColdConvertDraft {
  centre: CentreCode;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  type: EventType;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Copy that is load-bearing (asserted by tests, read by a human every day)
// ---------------------------------------------------------------------------

/**
 * The dialling list offers Call and Email only (R8): a cold row never gave us
 * its number for this enquiry, so there is no consent basis for a text.
 */
export const COLD_NO_TEXT_REASON =
  "No texting from a cold list — they have not given us this number for an enquiry. Call or email instead.";

/** The prototype's own warning, with the real numbers substituted. */
export function coldMatchWarning(matched: number, example: string | null): string {
  if (matched === 0) return "Nothing in this file matches an account we already have.";
  const rows = matched === 1 ? "1 row matches" : `${matched} rows match`;
  const eg = example ? ` (e.g. ${example})` : "";
  return `${rows} an account or contact we already have${eg}. They will be linked, not duplicated.`;
}

/** The list screen's sub-line (`crm-shared.js:439`). */
export function coldListSubtitle(s: ColdListStats): string {
  return `${s.rows} rows · ${s.called} called · ${s.interested} interested · ${s.booked} booked`;
}

/** DOM test ids for the cold surfaces. */
export const COLD_TEST_IDS = {
  screen: "crm-cold",
  lists: "crm-cold-lists",
  list: "crm-cold-list",
  rows: "crm-cold-rows",
  stats: "crm-cold-stats",
  importSheet: "crm-cold-import",
  mapStep: "crm-cold-map",
  reviewStep: "crm-cold-review",
  dispositionSheet: "crm-cold-disposition",
  convertSheet: "crm-cold-convert",
  noText: "crm-cold-no-text",
  listRow: (id: string) => "crm-cold-list-" + id,
  rowRow: (id: string) => "crm-cold-row-" + id,
} as const;

/**
 * Upload limits.
 *
 * The file is parsed in the BROWSER and posted as chunks of records, so the
 * 5 MB file cap never becomes a 5 MB request — Vercel refuses a body over
 * 4.5 MB, and a single multipart POST of the brief's "≤ 5 MB CSV" would have
 * failed on the real deployment. `COLD_MAX_ROWS` is what one mapping pass can
 * project and de-duplicate inside a 60-second function.
 */
export const COLD_MAX_BYTES = 5 * 1024 * 1024;
export const COLD_MAX_ROWS = 10_000;
export const COLD_ROWS_PER_CHUNK = 400;
/** Rows per page of the mapping / de-duplication pass. */
export const COLD_MAP_PAGE = 500;
export const COLD_ROWS_PAGE = 100;
export const COLD_ROWS_PAGE_MAX = 200;
