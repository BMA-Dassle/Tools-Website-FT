/**
 * The contracts sub's WIRE SHAPES — what `/api/admin/crm/contracts/**` answers
 * and the Contracts screen and the deal's Contract / Payments / History tabs
 * render.
 *
 * Kept beside the sub (like `leads/contracts.ts`) rather than appended to
 * `core/contracts.ts`, so parallel Wave-B PRs do not all append to one file.
 * `core/types.ts` is untouched apart from the append-only JOB_KINDS entries.
 *
 * CLIENT-SAFE: type-only imports, no Node, no Neon. Ids are strings — the BMI
 * project id is 17 digits and `group_function_quotes.id` is a bigint.
 */

import type { ApiOk } from "../core/contracts";
import type { CentreCode, GfStatus } from "../core/types";
import type { ContractHistoryEntry, SquareTimelineNode } from "~/features/daily-events/types";

// ---------------------------------------------------------------------------
// Windows and filters (crm-events.js:206-207, verbatim)
// ---------------------------------------------------------------------------

export const CONTRACT_WINDOWS = [
  ["attention", "Needs attention"],
  ["7", "Next 7 days"],
  ["30", "Next 30 days"],
  ["90", "Next 90 days"],
  ["past", "Past"],
  ["all", "All dates"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

export type ContractWindow = (typeof CONTRACT_WINDOWS)[number][0];

export const CONTRACT_WINDOW_IDS = CONTRACT_WINDOWS.map((w) => w[0]) as readonly ContractWindow[];

/** The status folder row; "all" is "Any status". */
export const CONTRACT_STATUS_FILTERS = [
  "all",
  "pending_approval",
  "contract_sent",
  "deposit_paid",
  "resign_required",
  "balance_link_sent",
  "balance_charged",
  "completed",
  "cancelled",
] as const;

export type ContractStatusFilter = (typeof CONTRACT_STATUS_FILTERS)[number];

/** Statuses that make a contract "closed" — hidden unless the archive toggle is on. */
export const CLOSED_GF_STATUSES: readonly GfStatus[] = [
  "completed",
  "cancelled",
  "denied",
  "expired",
];

/** 25 rows a page (prototype `PER`), and the ceiling every list API obeys (R10). */
export const CONTRACTS_PAGE_SIZE = 25;
export const CONTRACTS_PAGE_MAX = 200;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type AttentionKind = "warn" | "crit";

/** One "why it is here" pill. `t` is the prototype's copy, built at read time. */
export interface AttentionReason {
  t: string;
  k: AttentionKind;
}

export interface ContractRepRef {
  slug: string;
  displayName: string;
  firstName: string;
  initials: string;
}

export interface ContractRow {
  /** `group_function_quotes.id` as text. */
  quoteId: string;
  /** `contract_short_id` — the URL key for every action. Null before a contract exists. */
  shortId: string | null;
  /** BMI project id (17-digit, always a string). */
  projectId: string;
  /** Event name, else the guest's name — the prototype's row title. */
  title: string;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  /** Null when `center_code` is not one of ours (legacy rows). */
  centre: CentreCode | null;
  centerCode: string;
  centerName: string;
  /** YYYY-MM-DD */
  eventDate: string;
  eventNumber: string | null;
  guests: number | null;
  status: GfStatus;
  /** `approval_required` — the GF Post Paid Account product. */
  postPaid: boolean;
  taxExempt: boolean;
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  balanceCents: number;
  collectedCents: number;
  sentAt: string | null;
  signedAt: string | null;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  balanceLinkSentAt: string | null;
  dayofOrderId: string | null;
  settledOrderId: string | null;
  giftCardGan: string | null;
  savedCardBrand: string | null;
  savedCardLast4: string | null;
  signedPdfUrl: string | null;
  plannerEmail: string | null;
  plannerName: string | null;
  /** Joined from `crm_reps` by planner email; null when the planner has no rep row. */
  rep: ContractRepRef | null;
  /** The CRM lead this contract belongs to, when one exists (`/admin/crm/deal/<id>`). */
  leadPublicId: string | null;
  /** ET calendar days from today; negative = past. */
  daysOut: number;
  /**
   * Whole days since the contract went out, or null if it never did.
   *
   * Computed HERE, from the same clock as `daysOut`, rather than in the
   * component: a `Date.now()` in a render body is an impure call React may
   * evaluate at any moment (`react-hooks/purity`), and the banner it feeds
   * would then disagree with the pills beside it, which were dated server-side.
   */
  sentAgoDays: number | null;
  /** Why the row is in "Needs attention" — empty means it is not. */
  reasons: AttentionReason[];
  createdAt: string;
  updatedAt: string;
}

export interface ContractCounts {
  /** The "Needs attention" tile and the window badge. */
  attention: number;
  pendingApproval: number;
  outUnsigned: number;
  outUnsignedCents: number;
  depositsHeldCents: number;
  balanceOutstandingCents: number;
}

/** GET /contracts?win=&status=&centre=&rep=&q=&closed=1&cursor=&limit= */
export type ContractsListResponse = ApiOk<{
  rows: ContractRow[];
  nextCursor: string | null;
  /** Rows matching the filters, before paging — the prototype's "N contracts". */
  total: number;
  counts: ContractCounts;
}>;

/** GET /contracts?counts=1 — the badge poll; no rows, no COUNT over the page. */
export type ContractsCountsResponse = ApiOk<{
  rows: [];
  nextCursor: null;
  total: 0;
  counts: ContractCounts;
}>;

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface ContractLineItem {
  name: string;
  qty: number;
  unitCents: number;
  totalCents: number;
}

export interface ContractFieldDiff {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface ContractVersionView {
  /** `version_number` — the prototype's "v1". */
  n: number;
  at: string;
  trigger: string;
  changes: string[];
  /** This version against the next one (or against the live row for the newest). */
  diffs: ContractFieldDiff[];
}

export interface ContractAuditView {
  id: string;
  event: string;
  /** Humanised — "Guest opened the contract page". */
  label: string;
  detail: string | null;
  actor: string | null;
  at: string;
}

export interface ContractNotificationView {
  id: string;
  ruleKey: string;
  label: string;
  channel: string;
  status: string;
  error: string | null;
  at: string;
}

export interface ReminderRuleOption {
  key: string;
  label: string;
}

export interface ContractDetail {
  row: ContractRow;
  /** The public notes the guest reads on the contract page. */
  notes: string | null;
  lineItems: ContractLineItem[];
  versions: ContractVersionView[];
  audit: ContractAuditView[];
  notifications: ContractNotificationView[];
  /** Rules a director may fire by hand (`group-event-rules`). */
  reminderRules: ReminderRuleOption[];
  /** The guest's own contract page. */
  guestUrl: string | null;
  /** Set while a `-4` write has been made but not yet proven by a re-read. */
  cancelPending: boolean;
}

/** GET /contracts/[shortId] */
export type ContractDetailResponse = ApiOk<{ contract: ContractDetail }>;

/** GET /contracts/[shortId]?payments=1 — live Square, so its own read. */
export type ContractPaymentsResponse = ApiOk<{
  timeline: SquareTimelineNode[];
  /** Square could not be reached; the tab says so instead of showing nothing. */
  error: string | null;
}>;

/** GET /contracts/[shortId]?history=1 */
export type ContractHistoryResponse = ApiOk<{ entries: ContractHistoryEntry[] }>;

/**
 * GET /contracts/[shortId]?notes=1 — the LIVE BMI public notes behind "what
 * the guest sees". Its own read, like the Square timeline: one Office round
 * trip must not decide whether the Contract tab opens.
 */
export type ContractPublicNotesResponse = ApiOk<{
  /** What BMI holds right now; null when Office could not be reached. */
  live: string | null;
  /** What the guest's contract page renders today (`group_function_quotes.notes`). */
  stored: string | null;
  /** The two disagree — the guest is still seeing `stored`. */
  drifted: boolean;
  error: string | null;
}>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ContractActionName =
  | "approve"
  | "deny"
  | "resend"
  | "remind"
  | "charge-balance"
  | "send-balance-link"
  | "backfill-dayof"
  | "cancel";

/** Every action answers the same envelope; `message` is the toast. */
export type ContractActionResponse = ApiOk<{
  action: ContractActionName;
  shortId: string;
  message: string;
  /** The refreshed row, so a screen can repaint without a second read. */
  row: ContractRow | null;
}>;

/** `cancel` says whether the `-4` write was PROVEN by our own re-read. */
export type ContractCancelResponse = ApiOk<{
  action: "cancel";
  shortId: string;
  message: string;
  row: ContractRow | null;
  /** true only when `fetchProjectRawIds(...).stateId === "-4"` was observed. */
  verified: boolean;
  /** The state Office actually reported on the last poll. */
  observedStateId: string | null;
  /** A `contract-cancel-verify` job is waiting to prove it. */
  jobEnqueued: boolean;
}>;

// ---------------------------------------------------------------------------
// DOM test ids
// ---------------------------------------------------------------------------

export const CONTRACT_TEST_IDS = {
  screen: "crm-contracts",
  tiles: "crm-contracts-tiles",
  windows: "crm-contracts-windows",
  statusFolders: "crm-contracts-status",
  search: "crm-contracts-search",
  closedToggle: "crm-contracts-closed",
  table: "crm-contracts-table",
  row: (shortId: string) => "crm-contract-row-" + shortId,
  /** The row's jump to the Events board on the day the event happens. */
  eventJump: (shortId: string) => "crm-contract-event-" + shortId,
  pager: "crm-contracts-pager",
  contractTab: "crm-deal-contract",
  paymentsTab: "crm-deal-payments",
  historyTab: "crm-deal-history",
  guestView: "crm-guest-view",
  approveSheet: "crm-approve-sheet",
  denySheet: "crm-deny-sheet",
  resendSheet: "crm-resend-sheet",
  chargeSheet: "crm-charge-sheet",
  cancelSheet: "crm-cancel-sheet",
} as const;
