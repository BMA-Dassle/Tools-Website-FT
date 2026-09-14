/**
 * The wire contract for the builder routes (C5) — "Build in BMI".
 *
 * Beside the sub rather than appended to `core/contracts.ts` so parallel PRs
 * never race on one file's tail (the arrangement C4 made for
 * `availability/contracts.ts`). Dependency-free apart from types; client
 * components import THIS FILE by path, never the `bmi` barrel — the barrel
 * pulls in `@ft/db`, `ioredis` and the Office transport, none of which may
 * reach a browser bundle (§5.7b).
 *
 * IDS ARE STRINGS, every one of them. A `projectProduct.id`, a `projectId`, a
 * `personId` and a `scheduleId` are all 17 digits on a live tenant and exceed
 * `Number.MAX_SAFE_INTEGER`; a `: string` annotation does not prevent the
 * corruption, so nothing on this wire is ever a JSON number. Money is
 * `*_cents` integers for the same reason floats are not money.
 */

import type { ApiOk, OfficePrompt } from "~/features/crm/core/contracts";
import type { CentreCode } from "~/features/crm/core/types";

export type { OfficePrompt };

// ---------------------------------------------------------------------------
// Quote lines — `crm_quote_lines`, the builder's INTENT rows
// ---------------------------------------------------------------------------

/**
 * Where a line stands against Office.
 *
 * `pending` is the state the Neon row is BORN in, before any Office call
 * (R2 / CLAUDE.md "persist guest-provided data at capture"): the quote a rep
 * built survives an Office outage, a lambda timeout and a bad deploy, because
 * our database is the source of truth and Office is a downstream sync.
 *
 *   pending  — recorded here, not yet sent
 *   written  — Office has it; `bmiProjectProductId` is set and was RE-READ
 *   failed   — Office refused; `writeError` says why, `officePrompt` carries a
 *              soft refusal verbatim when there was one
 *   paused   — a kill switch is off, so it was never attempted
 *   removed  — deleted from Office (or never written) and retired here
 */
export type QuoteLineStatus = "pending" | "written" | "failed" | "paused" | "removed";

export const QUOTE_LINE_STATUSES: readonly QuoteLineStatus[] = [
  "pending",
  "written",
  "failed",
  "paused",
  "removed",
];

/** One block of time a line occupies on one Office resource. */
export interface ScheduleBlock {
  resourceId: string;
  /** Centre-local wall clock, `YYYY-MM-DDTHH:MM:SS`, NO offset — never an instant. */
  start: string;
  stop: string;
  persons: number;
}

export interface QuoteLine {
  id: string;
  leadId: string;
  bmiProjectId: string | null;
  productId: string;
  productName: string;
  /** What the rep typed over the catalogue name, or null to keep Office's. */
  nameOverride: string | null;
  quantity: number;
  pricePerUnitCents: number;
  /** The date the price was quoted FOR — weekday and weekend differ. */
  priceDate: string | null;
  resourceId: string | null;
  scheduleBlocks: ScheduleBlock[];
  bmiProjectProductId: string | null;
  bmiScheduleIds: string[];
  status: QuoteLineStatus;
  writeError: string | null;
  officePrompt: OfficePrompt | null;
  actorEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `quantity × pricePerUnitCents` — the only arithmetic the client does. */
export function lineTotalCents(line: Pick<QuoteLine, "quantity" | "pricePerUnitCents">): number {
  return line.quantity * line.pricePerUnitCents;
}

// ---------------------------------------------------------------------------
// The project the quote is being built onto
// ---------------------------------------------------------------------------

export interface BuilderProject {
  projectId: string;
  clientKey: string;
  /** Office reference ("H3248"), once Office has assigned one. */
  number: string | null;
  name: string | null;
  /** YYYY-MM-DD, centre-local. */
  date: string | null;
  /** HH:MM, centre-local, or null when the project carries no time. */
  time: string | null;
  persons: number | null;
  personId: string | null;
  stateId: string | null;
  stateName: string | null;
}

/**
 * `GET /project/balance` — the last step of the write rail, and the number the
 * rep reads back. Cents, never floats.
 */
export interface BuilderBalance {
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  /** ISO instant the balance was read. */
  readAt: string;
}

/**
 * A product line Office holds that WE did not put there.
 *
 * One writer per BMI entity (R5): when someone edits the project in the Office
 * UI, the builder says so and stops — it never silently overwrites a line it
 * does not recognise, and it never deletes one.
 */
export interface OfficeOnlyLine {
  bmiProjectProductId: string;
  productId: string | null;
  name: string | null;
  quantity: number | null;
  totalCents: number | null;
}

/** Why the builder is refusing to write, when it is. */
export type WritesPausedReason = "env" | "env_centre" | "setting" | "setting_centre";

export interface WritesState {
  enabled: boolean;
  reason: WritesPausedReason | null;
  /** What the screen says out loud. Null when writes are on. */
  message: string | null;
}

/** The copy a paused builder shows. One sentence, no mechanism. */
export const WRITES_PAUSED_MESSAGE = "BMI writes are paused by admin";

/**
 * Office's cloud reaches a centre's own Pandora copy in minutes, not
 * milliseconds. Until the local side reads the schedule back, the builder says
 * "syncing to center" rather than pretending the desk can already see it.
 */
export type SyncState = "clean" | "syncing" | "unknown";

export const SYNCING_MESSAGE = "Syncing to the center — the front desk sees this in a few minutes";

// ---------------------------------------------------------------------------
// Templates — `crm_quote_templates`
// ---------------------------------------------------------------------------

/**
 * One line of a template. THE CANONICAL SHAPE, fixed by PR1's DDL comment:
 *
 *   qty = per ? max(min ?? 1, ceil(guests / per)) : (min ?? 1)
 *
 * `per` is "one of these covers this many guests" (one pizza per 4), `min` is
 * the floor (never fewer than 2 lanes). A line with neither is a flat one.
 *
 * NOTE A PRICE IS NEVER STORED HERE. Weekday and weekend are different
 * numbers, and a price frozen into a template is the "published price must
 * match the catalogue" incident waiting to happen: the builder always asks
 * `projectProduct/price` for the EVENT'S OWN DATE.
 */
export interface TemplateLine {
  productId: string;
  /** Display only — the live name comes from the catalogue at apply time. */
  productName?: string;
  per?: number;
  min?: number;
}

export interface QuoteTemplate {
  id: string;
  name: string;
  /** A centre code, or null for "every center". */
  centre: CentreCode | null;
  baselineGuests: number;
  description: string | null;
  lines: TemplateLine[];
  /** How many quotes were started from it — a stale package has a low count. */
  uses: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A template's lines scaled to one party, before prices are fetched. */
export interface ScaledTemplateLine {
  productId: string;
  productName: string | null;
  quantity: number;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface CatalogProduct {
  productId: string;
  name: string;
  /**
   * The price Office quotes for THIS DATE, in cents.
   *
   * Null on a LIST read, always: pricing is one Office round trip per product
   * and a tenant's catalogue runs to hundreds, so the list is names only and
   * the picker asks for the one price it needs (`?productId=`) when a rep
   * actually picks something. Also null when Office refused the price call —
   * which the screen shows as "price unavailable", never as $0.00.
   */
  priceCents: number | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /builder?lead=<publicId> */
export type BuilderStateResponse = ApiOk<{
  lead: BuilderLead | null;
  leadMissing: boolean;
  project: BuilderProject | null;
  lines: QuoteLine[];
  officeOnly: OfficeOnlyLine[];
  changedInOffice: boolean;
  balance: BuilderBalance | null;
  writes: WritesState;
  sync: SyncState;
  /** True when the signed-in person may force through a soft refusal. */
  canForce: boolean;
}>;

/** What the builder needs to know about the lead it is quoting. */
export interface BuilderLead {
  publicId: string;
  title: string;
  centre: CentreCode;
  clientKey: string;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  statusId: string;
  bmiProjectId: string | null;
}

/** GET /builder/catalog?centre=&date=&q= */
export type BuilderCatalogResponse = ApiOk<{
  centre: CentreCode;
  date: string;
  products: CatalogProduct[];
  /** "unavailable" = Office could not be reached; `products` is then empty. */
  source: "office" | "unavailable";
  error?: string;
}>;

/** GET /builder/templates?centre= */
export type BuilderTemplatesResponse = ApiOk<{ templates: QuoteTemplate[] }>;

/** POST /builder/templates */
export type BuilderTemplatesPostBody =
  | {
      action: "save";
      name: string;
      centre?: CentreCode | null;
      description?: string | null;
      baselineGuests: number;
      lines: TemplateLine[];
    }
  | { action: "archive"; id: string };

/** POST /builder — every mutation the screen makes, one discriminated body. */
export type BuilderPostBody =
  | { action: "create-project"; lead: string }
  | {
      action: "add-line";
      lead: string;
      productId: string;
      productName: string;
      quantity: number;
      nameOverride?: string | null;
    }
  | { action: "apply-template"; lead: string; templateId: string }
  | { action: "remove-line"; lead: string; lineId: string }
  | { action: "retry-line"; lead: string; lineId: string }
  | {
      action: "link-schedule";
      lead: string;
      lineId: string;
      blocks: ScheduleBlock[];
      /** Director only — re-sends through Office's soft refusal. */
      force?: boolean;
    }
  | { action: "move-date"; lead: string; date: string }
  | { action: "sync"; lead: string };

export type BuilderPostResponse = BuilderStateResponse;

// ---------------------------------------------------------------------------
// Errors the client is MEANT to read
// ---------------------------------------------------------------------------

/**
 * Office answered `linkSchedule` with its 403 soft-refusal envelope: the heat
 * (or lane block) has not got the seats. NOT an error page, and NEVER retried
 * blindly — the rep picks a different heat, or a director forces it.
 */
export const HEAT_FULL_ERROR = "heat_full";

/** The sentence the screen shows for `heat_full`. */
export const HEAT_FULL_MESSAGE = "This heat is full — pick another.";

/** Writes are paused; nothing was sent. */
export const WRITES_PAUSED_ERROR = "bmi_writes_paused";

/** Another writer holds this project. Try again in a moment. */
export const PROJECT_LOCKED_ERROR = "project_locked";

/** Office took the write but the re-read disagreed. Never reported as success. */
export const VERIFY_FAILED_ERROR = "office_verify_failed";

// ---------------------------------------------------------------------------
// DOM test ids
// ---------------------------------------------------------------------------

export const BUILDER_TEST_IDS = {
  screen: "crm-builder",
  lines: "crm-builder-lines",
  addLine: "crm-builder-add",
  catalog: "crm-builder-catalog",
  templates: "crm-builder-templates",
  heats: "crm-builder-heats",
  balance: "crm-builder-balance",
  writesPaused: "crm-builder-writes-paused",
  changedInOffice: "crm-builder-changed",
  officePrompt: "crm-builder-office-prompt",
} as const;
