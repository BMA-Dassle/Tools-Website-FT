/**
 * "Build in BMI" — the quote builder's write rail (C5).
 *
 * THE SEQUENCE, from the Office UI's own DevTools trace:
 *
 *   POST /project/autocreate
 *   GET  /search/person  →  GET /person/download  →  PUT /person
 *   POST /project/autosave
 *   POST /projectProduct/price?productId=&date=     ← weekday/weekend lives HERE
 *   POST /projectProduct
 *   GET  /dayPlanner?resourceIds=…                  ← per-heat availability
 *   POST /projectProduct/linkSchedule
 *   GET  /project/balance
 *
 * Removal is `DELETE /projectProduct?id=`; schedule edits are
 * `PUT /projectSchedule/batch`; moving the date is `PUT /project` (through
 * `putProjectFields`, the existing one-writer rail, never re-implemented here).
 *
 * ── THE SIX INVARIANTS ────────────────────────────────────────────────────
 *
 * R1 IDS ARE STRINGS. Every id in and out of this file is text. The transport
 *    (`../office-write.ts`, `../transport.ts`) is the only thing that parses or
 *    serialises one, and it does so with the raw-id helpers.
 *
 * R2 NEON FIRST, OFFICE SECOND. `crm_quote_lines` holds the intent before the
 *    call and the verdict after it. A rep's quote is never lost to an Office
 *    outage, because it was never only in Office.
 *
 * R3 IDEMPOTENT BY `projectProduct.id`. A line carrying one has been written;
 *    re-running its step re-reads and verifies instead of creating a second
 *    Office row. `claimProjectProductId` is a conditional UPDATE, so a lost
 *    race is detected and the duplicate is deleted rather than orphaned.
 *
 * R4 ONE WRITER PER PROJECT. Every mutation takes the Redis lock
 *    `crm:office:project:<id>` — the same key `putProjectFields` uses, so a
 *    builder write and a status write serialise against each other instead of
 *    racing GET → PUT on one record. Edits made in the Office UI surface as a
 *    "changed in Office" banner on the next read, never a silent overwrite.
 *
 * R5 NEVER TRUST A 200. Every write is followed by a re-read of the project,
 *    and the line is only `written` once Office reads the row back.
 *
 * R6 A 403 ON linkSchedule IS A SOFT REFUSAL. `{IsQuestion:false, Kind:4,
 *    Message:"Total persons (N) is higher than the capacity …"}` means the heat
 *    is full. It is surfaced as "this heat is full, pick another", recorded on
 *    the line, and NEVER retried blindly. A director may force it, which
 *    re-sends the identical body with `confirm:true`.
 */

import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import { CRM_PROJECT_LOCK_PREFIX, putProjectFields } from "@/lib/bmi-office-actions";
import { projectLocalBarrier } from "@/lib/bmi-sync-barriers";
import { CENTRES } from "~/features/crm/core/centres";
import {
  bmiWritesAllowedFor,
  crmBmiWritesEnabled,
  crmBmiWritesOffCentres,
} from "~/features/crm/core/flags";
import { CrmHttpError } from "~/features/crm/core/http";
import type { CrmUser } from "~/features/crm/core/types";
import {
  HEAT_FULL_ERROR,
  HEAT_FULL_MESSAGE,
  PROJECT_LOCKED_ERROR,
  VERIFY_FAILED_ERROR,
  WRITES_PAUSED_ERROR,
  WRITES_PAUSED_MESSAGE,
  type BuilderBalance,
  type BuilderProject,
  type BuilderStateResponse,
  type OfficeOnlyLine,
  type QuoteLine,
  type ScheduleBlock,
  type SyncState,
  type WritesState,
} from "../contracts";
import {
  claimLeadProject,
  findLeadForBuilder,
  recordMintFailure,
  updateLeadEventDate,
  type BuilderLeadRow,
} from "../data/builder-lead-db";
import {
  claimProjectProductId,
  getQuoteLine,
  insertQuoteLine,
  listQuoteLines,
  patchQuoteLine,
  type QuoteLineInput,
  type QuoteLinePatch,
} from "../data/quote-lines-db";
import { bumpTemplateUse, getQuoteTemplate } from "../data/quote-templates-db";
import { officeProject } from "../transport";
import {
  autocreateProject,
  autosaveProject,
  centsToDollars,
  createProjectProduct,
  deleteProjectProduct,
  dollarsToCents,
  downloadPerson,
  linkSchedule,
  newWriteSession,
  officeStamp,
  productPrice,
  putPerson,
  refusalLine,
  searchPerson,
  toWirePrompt,
  type OfficeWriteResult,
} from "../office-write";
import { scaleTemplate } from "./templates";

/** The read session tag the builder's own project reads ride. */
export const CRM_BUILDER_SESSION_TAG = "crm-builder";

/**
 * How long after a schedule write the builder keeps saying "syncing to centre"
 * before it stops guessing. Cloud → local convergence is minutes; past this we
 * say `unknown` rather than leave a spinner up forever.
 */
export const SYNC_PATIENCE_MS = 15 * 60 * 1000;

const PROJECT_LOCK_TTL_MS = 30_000;
const PROJECT_LOCK_ATTEMPTS = 6;
const PROJECT_LOCK_RETRY_MS = 500;

// ---------------------------------------------------------------------------
// The store seam — Neon in production, an in-memory double in tests
// ---------------------------------------------------------------------------

export interface BuilderStore {
  findLead(publicId: string): Promise<BuilderLeadRow | null>;
  claimLeadProject(leadRowId: string, projectId: string): Promise<string | null>;
  recordMintFailure(leadRowId: string, error: string): Promise<void>;
  updateLeadEventDate(leadRowId: string, date: string): Promise<void>;
  listLines(leadRowId: string): Promise<QuoteLine[]>;
  getLine(id: string): Promise<QuoteLine | null>;
  insertLine(input: QuoteLineInput): Promise<QuoteLine>;
  patchLine(id: string, patch: QuoteLinePatch): Promise<QuoteLine | null>;
  claimProjectProduct(
    id: string,
    projectProductId: string,
    projectId: string,
  ): Promise<QuoteLine | null>;
  getTemplate(id: string): Promise<Awaited<ReturnType<typeof getQuoteTemplate>>>;
  bumpTemplateUse(id: string): Promise<void>;
  /** `crm_settings.bmi_writes`, or undefined when settings could not be read. */
  bmiWritesSetting(): Promise<unknown>;
}

export const neonBuilderStore: BuilderStore = {
  findLead: findLeadForBuilder,
  claimLeadProject,
  recordMintFailure,
  updateLeadEventDate,
  listLines: listQuoteLines,
  getLine: getQuoteLine,
  insertLine: insertQuoteLine,
  patchLine: patchQuoteLine,
  claimProjectProduct: claimProjectProductId,
  getTemplate: getQuoteTemplate,
  bumpTemplateUse,
  async bmiWritesSetting() {
    // Imported lazily: `core/data/settings-db` pulls in the whole core barrel,
    // and the builder is reached from a route that has already loaded it.
    const { getSettingValue } = await import("~/features/crm/core/data/settings-db");
    return getSettingValue("bmi_writes");
  },
};

export interface BuilderContext {
  store: BuilderStore;
  user: CrmUser;
}

// ---------------------------------------------------------------------------
// The kill switches
// ---------------------------------------------------------------------------

/**
 * Are writes allowed for this centre, and if not, what does the screen say?
 *
 * KILL SWITCHES ONLY — every one of them defaults ON (`!== "false"`, and a
 * missing settings row is ON). Nothing here is an opt-in gate: a merged
 * builder is a live builder, and the switches exist so a director can stop it
 * at 9pm without a deploy.
 */
export function writesStateFor(clientKey: string, setting: unknown): WritesState {
  if (!crmBmiWritesEnabled()) {
    return { enabled: false, reason: "env", message: WRITES_PAUSED_MESSAGE };
  }
  if (crmBmiWritesOffCentres().has(clientKey)) {
    return { enabled: false, reason: "env_centre", message: WRITES_PAUSED_MESSAGE };
  }
  if (!bmiWritesAllowedFor(clientKey, setting)) {
    // Past the two env checks, only the director's toggle is left; whether it
    // was the global switch or this centre's entry is the same sentence to a
    // rep, and the distinction is kept for the audit row.
    const s = setting as { enabled?: unknown } | null;
    const reason = s && typeof s === "object" && s.enabled === false ? "setting" : "setting_centre";
    return { enabled: false, reason, message: WRITES_PAUSED_MESSAGE };
  }
  return { enabled: true, reason: null, message: null };
}

/** Throw the paused refusal. Callers never send anything after this. */
function refuseIfPaused(writes: WritesState): void {
  if (!writes.enabled) throw new CrmHttpError(409, WRITES_PAUSED_ERROR);
}

// ---------------------------------------------------------------------------
// The project lock (R4)
// ---------------------------------------------------------------------------

const RELEASE_IF_OWNER = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Serialise every CRM write against one project.
 *
 * The SAME key `putProjectFields` takes, deliberately: a builder line write and
 * a status write are both GET → mutate → PUT against one record, and two of
 * them interleaved is how a field gets written and immediately reverted.
 */
export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `${CRM_PROJECT_LOCK_PREFIX}${projectId}`;
  const token = randomUUID();
  let held = false;
  for (let attempt = 0; attempt < PROJECT_LOCK_ATTEMPTS; attempt += 1) {
    const ok = await redis.set(lockKey, token, "PX", PROJECT_LOCK_TTL_MS, "NX");
    if (ok === "OK") {
      held = true;
      break;
    }
    await new Promise((r) => setTimeout(r, PROJECT_LOCK_RETRY_MS));
  }
  if (!held) throw new CrmHttpError(409, PROJECT_LOCKED_ERROR);

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_IF_OWNER, 1, lockKey, token);
    } catch (err) {
      // It expires on its own in 30 s; a failed release is a log line, not a stall.
      console.warn(
        `[crm-builder] could not release ${lockKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the project back (R5)
// ---------------------------------------------------------------------------

interface RawOfficeProject {
  id?: unknown;
  number?: unknown;
  name?: unknown;
  date?: unknown;
  persons?: unknown;
  personId?: unknown;
  stateId?: unknown;
  reservationId?: unknown;
  products?: Array<Record<string, unknown>>;
  bills?: Array<Record<string, unknown>>;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `"2026-10-17T18:00:00"` → `{date:"2026-10-17", time:"18:00"}`, no `Date`. */
export function splitOfficeStamp(stamp: unknown): { date: string | null; time: string | null } {
  const s = typeof stamp === "string" ? stamp : "";
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(s);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] ?? null };
}

export function toBuilderProject(clientKey: string, raw: RawOfficeProject): BuilderProject | null {
  const projectId = str(raw.id);
  if (!projectId) return null;
  const when = splitOfficeStamp(raw.date);
  return {
    projectId,
    clientKey,
    number: str(raw.number),
    name: str(raw.name),
    date: when.date,
    time: when.time,
    persons: num(raw.persons),
    personId: str(raw.personId),
    stateId: str(raw.stateId),
    stateName: null,
  };
}

/**
 * The balance, from the project's own bills.
 *
 * `GET /project/balance` is the sequence's last call, but the detail read we
 * already made carries the same numbers, and one fewer Office round trip per
 * screen paint is worth having. `readBalance` is the explicit call, used after
 * a write when the rep is watching the total change.
 */
export function balanceFromProject(raw: RawOfficeProject): BuilderBalance | null {
  const bill = raw.bills?.[0];
  if (!bill) return null;
  const total = num(bill.total) ?? 0;
  const balance = num(bill.balance) ?? 0;
  return {
    totalCents: dollarsToCents(total),
    paidCents: dollarsToCents(total - balance),
    balanceCents: dollarsToCents(balance),
    readAt: new Date().toISOString(),
  };
}

/**
 * Office product rows WE did not put there (R4's visible half).
 *
 * Anything whose `projectProduct.id` matches none of our written lines was
 * added in the Office UI. The builder names it and stops; it never deletes a
 * row it does not recognise and never rewrites one.
 */
export function officeOnlyLines(
  raw: RawOfficeProject,
  lines: readonly QuoteLine[],
): OfficeOnlyLine[] {
  const known = new Set(
    lines.map((l) => l.bmiProjectProductId).filter((id): id is string => Boolean(id)),
  );
  return (raw.products ?? []).flatMap((p) => {
    const id = str(p.id);
    if (!id || known.has(id)) return [];
    const total = num(p.totalPrice) ?? num(p.price);
    return [
      {
        bmiProjectProductId: id,
        productId: str(p.productId),
        name: str(p.name) ?? str(p.productName),
        quantity: num(p.quantity),
        totalCents: total === null ? null : dollarsToCents(total),
      },
    ];
  });
}

/** A line we believe we wrote that Office no longer holds — someone deleted it. */
export function missingFromOffice(raw: RawOfficeProject, lines: readonly QuoteLine[]): QuoteLine[] {
  const office = new Set((raw.products ?? []).map((p) => str(p.id)).filter(Boolean));
  return lines.filter(
    (l) => l.status === "written" && l.bmiProjectProductId && !office.has(l.bmiProjectProductId),
  );
}

// ---------------------------------------------------------------------------
// "Syncing to centre"
// ---------------------------------------------------------------------------

/**
 * Has the project reached the centre's OWN server yet?
 *
 * Office's cloud is not the desk's copy. `projectLocalBarrier` is the existing,
 * proven probe (`GET /bmi/reservation/{locationId}/{projectId}`; the Office
 * project id IS the reservation id on that endpoint). Until it answers `open`,
 * the builder says "syncing to centre" rather than letting a rep tell a guest
 * the front desk can already see their party.
 *
 * `unknown` after `SYNC_PATIENCE_MS`, or when Pandora cannot be reached: an
 * honest shrug beats a spinner that never stops.
 */
export async function syncStateFor(
  centreCode: keyof typeof CENTRES,
  projectId: string,
  lastWriteAt: number | null,
): Promise<SyncState> {
  if (lastWriteAt !== null && Date.now() - lastWriteAt > SYNC_PATIENCE_MS) return "unknown";
  const locationId = CENTRES[centreCode].pandoraLocationId;
  try {
    const barrier = await projectLocalBarrier(locationId, projectId);
    if (barrier.verdict === "open") return "clean";
    if (barrier.verdict === "closed") return "syncing";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The newest `updatedAt` across lines Office has taken — the sync clock's start. */
export function lastWriteInstant(lines: readonly QuoteLine[]): number | null {
  let newest: number | null = null;
  for (const line of lines) {
    if (line.status !== "written") continue;
    const t = Date.parse(line.updatedAt);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Load: GET /builder
// ---------------------------------------------------------------------------

type StatePayload = Omit<BuilderStateResponse, "ok">;

export async function loadBuilderState(
  ctx: BuilderContext,
  leadPublicId: string,
): Promise<StatePayload> {
  const lead = await ctx.store.findLead(leadPublicId);
  const canForce = ctx.user.role === "director";

  if (!lead) {
    return {
      lead: null,
      leadMissing: true,
      project: null,
      lines: [],
      officeOnly: [],
      gone: [],
      changedInOffice: false,
      balance: null,
      writes: writesStateFor("", await ctx.store.bmiWritesSetting()),
      sync: "unknown",
      canForce,
    };
  }

  const [lines, setting] = await Promise.all([
    ctx.store.listLines(lead.rowId),
    ctx.store.bmiWritesSetting(),
  ]);
  const writes = writesStateFor(lead.clientKey, setting);

  if (!lead.bmiProjectId) {
    return {
      lead: publicLead(lead),
      leadMissing: false,
      project: null,
      lines,
      officeOnly: [],
      gone: [],
      changedInOffice: false,
      balance: null,
      writes,
      sync: "unknown",
      canForce,
    };
  }

  let raw: RawOfficeProject | null = null;
  try {
    raw = await officeProject<RawOfficeProject>(
      lead.clientKey,
      lead.bmiProjectId,
      CRM_BUILDER_SESSION_TAG,
    );
  } catch (err) {
    // Office being unreadable does not make the quote disappear: Neon is the
    // source of truth, so the lines still render and the screen says the
    // Office half could not be read.
    console.error("[crm-builder] project read failed", {
      project_id: lead.bmiProjectId,
      actor_email: ctx.user.email,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const officeOnly = raw ? officeOnlyLines(raw, lines) : [];
  const gone = raw ? missingFromOffice(raw, lines) : [];
  const sync = await syncStateFor(lead.centre, lead.bmiProjectId, lastWriteInstant(lines));

  return {
    lead: publicLead(lead),
    leadMissing: false,
    project: raw ? toBuilderProject(lead.clientKey, raw) : null,
    lines,
    officeOnly,
    gone,
    changedInOffice: officeOnly.length > 0 || gone.length > 0,
    balance: raw ? balanceFromProject(raw) : null,
    writes,
    sync,
    canForce,
  };
}

function publicLead(lead: BuilderLeadRow) {
  return {
    publicId: lead.publicId,
    title: lead.title,
    centre: lead.centre,
    clientKey: lead.clientKey,
    eventDate: lead.eventDate,
    eventTime: lead.eventTime,
    guests: lead.guests,
    statusId: lead.statusId,
    bmiProjectId: lead.bmiProjectId,
  };
}

// ---------------------------------------------------------------------------
// Create the project
// ---------------------------------------------------------------------------

/**
 * `POST /project/autocreate` → host → `POST /project/autosave`.
 *
 * Idempotent by the lead's own `bmi_project_id`: a lead that already has one
 * is returned unchanged, and `claimLeadProject`'s conditional UPDATE settles a
 * race with B3's mint rail without either side overwriting the other.
 */
export async function ensureOfficeProject(
  ctx: BuilderContext,
  leadPublicId: string,
): Promise<StatePayload> {
  const lead = await ctx.store.findLead(leadPublicId);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  if (lead.bmiProjectId) return loadBuilderState(ctx, leadPublicId);

  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());
  refuseIfPaused(writes);

  const centre = CENTRES[lead.centre];
  const session = newWriteSession();

  try {
    const created = await autocreateProject(lead.clientKey, session, {
      locationId: centre.locationId,
      date: lead.eventDate,
      time: lead.eventTime,
      persons: lead.guests,
      name: lead.title,
    });
    const projectId = writeResultId(created, "project/autocreate");

    // The host, before the project names one: search by email then phone —
    // never by name, which this endpoint 500s on.
    const personId = await findHostPerson(lead, session);

    const saved = await autosaveProject(lead.clientKey, session, {
      projectId,
      name: lead.title,
      date: lead.eventDate,
      time: lead.eventTime,
      persons: lead.guests,
      personId,
    });
    assertWriteOk(saved, "project/autosave");

    // R5: prove it exists before telling anyone it does.
    const raw = await officeProject<RawOfficeProject>(
      lead.clientKey,
      projectId,
      CRM_BUILDER_SESSION_TAG,
    );
    if (!str(raw.id)) throw new CrmHttpError(502, VERIFY_FAILED_ERROR);

    const claimed = await ctx.store.claimLeadProject(lead.rowId, projectId);
    if (!claimed) {
      // Someone else attached a project between our read and our claim. Theirs
      // wins (one writer per entity); ours is logged so it can be tidied by
      // hand rather than silently abandoned.
      console.warn("[crm-builder] lost the project claim race", {
        lead: lead.publicId,
        orphaned_project_id: projectId,
        actor_email: ctx.user.email,
      });
    }
    return loadBuilderState(ctx, leadPublicId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.store.recordMintFailure(lead.rowId, message);
    throw err;
  }
}

/**
 * The host's Office person id, or null.
 *
 * Email first, then phone — both are single-word tokens, which is exactly what
 * `search/person` wants and exactly why it goes over raw https. A miss is
 * NULL, not a newly minted person: creating a duplicate guest record is worse
 * than a project whose host is attached by hand, and `createOfficePerson` is
 * the booking stack's rail with its own DOB rules.
 */
async function findHostPerson(lead: BuilderLeadRow, session: string): Promise<string | null> {
  const tokens = [lead.email, lead.phoneE164?.replace(/\D/g, "")].filter((t): t is string =>
    Boolean(t && t.trim()),
  );
  for (const token of tokens) {
    const hit = await searchPerson(lead.clientKey, session, token, 20);
    if (!hit.ok) continue;
    const first = hit.data[0];
    if (first?.localId) return String(first.localId);
  }
  return null;
}

/**
 * Refresh the host record with what the CRM knows — the capture's
 * `GET /person/download` → `PUT /person` pair.
 *
 * Read then write, both on the SAME session, and the body is the record Office
 * just gave us with the patch on top: never a hand-built person, which would
 * blank every field the CRM does not happen to hold.
 */
export async function refreshHostPerson(
  clientKey: string,
  session: string,
  personId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const current = await downloadPerson(clientKey, session, personId);
  if (!current.ok) return false;
  const merged = { ...current.data, ...patch };
  const put = await putPerson(clientKey, session, merged);
  return put.ok;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * What Office charges for this product ON THIS DATE.
 *
 * Called per date, never cached across dates and never stored in a template:
 * weekday and weekend are different numbers, and this endpoint is where that
 * difference actually lives. A price the screen shows and a price the quote
 * charges must be the same read.
 */
export async function priceForDate(
  clientKey: string,
  productId: string,
  date: string,
  opts: { quantity?: number; projectId?: string; session?: string } = {},
): Promise<number | null> {
  const session = opts.session ?? newWriteSession();
  const res = await productPrice(clientKey, session, {
    productId,
    date,
    quantity: opts.quantity,
    projectId: opts.projectId,
  });
  if (!res.ok) return null;
  const dollars = num(res.data.pricePerUnit) ?? num(res.data.price) ?? num(res.data.totalPrice);
  return dollars === null ? null : dollarsToCents(dollars);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface AddLineInput {
  leadPublicId: string;
  productId: string;
  productName: string;
  quantity: number;
  nameOverride?: string | null;
}

/**
 * Add one product to the quote.
 *
 * NEON FIRST (R2): the intent row is written before Office is called at all, so
 * a rep who loses the lambda mid-call still has the line, marked `pending`,
 * with a Retry beside it.
 */
export async function addQuoteLine(
  ctx: BuilderContext,
  input: AddLineInput,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, input.leadPublicId);
  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());

  const session = newWriteSession();
  const priceCents = writes.enabled
    ? await priceForDate(lead.clientKey, input.productId, lead.eventDate, {
        quantity: input.quantity,
        projectId: lead.bmiProjectId ?? undefined,
        session,
      })
    : null;

  const line = await ctx.store.insertLine({
    leadId: lead.rowId,
    bmiProjectId: lead.bmiProjectId,
    productId: input.productId,
    productName: input.productName,
    nameOverride: input.nameOverride ?? null,
    quantity: input.quantity,
    pricePerUnitCents: priceCents ?? 0,
    priceDate: lead.eventDate,
    actorEmail: ctx.user.email,
  });

  if (!writes.enabled) {
    await ctx.store.patchLine(line.id, { status: "paused", writeError: WRITES_PAUSED_MESSAGE });
    return loadBuilderState(ctx, input.leadPublicId);
  }

  await pushLineToOffice(ctx, lead, line, session);
  return loadBuilderState(ctx, input.leadPublicId);
}

/**
 * Send one recorded line to Office and record what Office said.
 *
 * Never throws for an Office refusal — the line carries the verdict and the
 * screen renders a Retry. It throws only for a lock we could not take, which
 * is the one failure a rep should simply try again.
 */
async function pushLineToOffice(
  ctx: BuilderContext,
  lead: BuilderLeadRow,
  line: QuoteLine,
  session: string,
): Promise<void> {
  const projectId = lead.bmiProjectId;
  if (!projectId) return;

  // R3: already written. Re-read rather than create a second Office row.
  if (line.bmiProjectProductId) {
    await verifyLineAgainstOffice(ctx, lead, line);
    return;
  }

  await withProjectLock(projectId, async () => {
    const res = await createProjectProduct(lead.clientKey, session, {
      projectId,
      productId: line.productId,
      quantity: line.quantity,
      pricePerUnit: centsToDollars(line.pricePerUnitCents),
      name: line.nameOverride,
    });

    if (!res.ok) {
      await recordRefusal(ctx, line.id, res, "projectProduct");
      return;
    }

    const projectProductId = str(res.data.id);
    if (!projectProductId) {
      await ctx.store.patchLine(line.id, {
        status: "failed",
        writeError: "Office accepted the line but returned no id",
      });
      return;
    }

    const claimed = await ctx.store.claimProjectProduct(line.id, projectProductId, projectId);
    if (!claimed) {
      // We lost a race: another request already recorded an id for this line.
      // Delete the duplicate we just made rather than leave it on the project.
      console.warn("[crm-builder] duplicate projectProduct, removing", {
        line_id: line.id,
        project_product_id: projectProductId,
      });
      await deleteProjectProduct(lead.clientKey, session, projectProductId);
      return;
    }

    // R5: a 200 is not a result.
    await verifyLineAgainstOffice(ctx, lead, claimed);
  });
}

/** Re-read the project and prove the line is really on it. */
async function verifyLineAgainstOffice(
  ctx: BuilderContext,
  lead: BuilderLeadRow,
  line: QuoteLine,
): Promise<void> {
  if (!lead.bmiProjectId || !line.bmiProjectProductId) return;
  try {
    const raw = await officeProject<RawOfficeProject>(
      lead.clientKey,
      lead.bmiProjectId,
      CRM_BUILDER_SESSION_TAG,
    );
    const found = (raw.products ?? []).some((p) => str(p.id) === line.bmiProjectProductId);
    if (found) {
      await ctx.store.patchLine(line.id, {
        status: "written",
        writeError: null,
        officePrompt: null,
      });
      return;
    }
    await ctx.store.patchLine(line.id, {
      status: "failed",
      writeError: "Office took the write but the line is not on the project",
    });
  } catch (err) {
    console.error("[crm-builder] verify read failed", {
      line_id: line.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Retry one line that is pending, paused or failed. */
export async function retryQuoteLine(
  ctx: BuilderContext,
  leadPublicId: string,
  lineId: string,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, leadPublicId);
  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());
  refuseIfPaused(writes);

  const line = await ctx.store.getLine(lineId);
  if (!line || line.leadId !== lead.rowId) throw new CrmHttpError(404, "line_not_found");
  if (line.status === "removed") throw new CrmHttpError(409, "line_removed");

  const session = newWriteSession();

  // Re-price on the way back in: the date may have moved since the first try,
  // and a stale weekday price on a weekend event is money.
  const priceCents = await priceForDate(lead.clientKey, line.productId, lead.eventDate, {
    quantity: line.quantity,
    projectId: lead.bmiProjectId ?? undefined,
    session,
  });
  const repriced =
    priceCents !== null && priceCents !== line.pricePerUnitCents
      ? ((await ctx.store.patchLine(line.id, {
          pricePerUnitCents: priceCents,
          priceDate: lead.eventDate,
        })) ?? line)
      : line;

  await pushLineToOffice(ctx, lead, repriced, session);
  return loadBuilderState(ctx, leadPublicId);
}

/**
 * `DELETE /projectProduct?id=`.
 *
 * A line Office never took is retired in Neon alone — there is nothing to
 * delete, and calling Office with a null id would 400. A line Office DID take
 * is deleted there first and only marked `removed` here once the re-read no
 * longer finds it.
 */
export async function removeQuoteLine(
  ctx: BuilderContext,
  leadPublicId: string,
  lineId: string,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, leadPublicId);
  const line = await ctx.store.getLine(lineId);
  if (!line || line.leadId !== lead.rowId) throw new CrmHttpError(404, "line_not_found");

  if (!line.bmiProjectProductId || !lead.bmiProjectId) {
    await ctx.store.patchLine(line.id, { status: "removed" });
    return loadBuilderState(ctx, leadPublicId);
  }

  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());
  refuseIfPaused(writes);

  const session = newWriteSession();
  await withProjectLock(lead.bmiProjectId, async () => {
    const res = await deleteProjectProduct(lead.clientKey, session, line.bmiProjectProductId!);
    if (!res.ok) {
      await recordRefusal(ctx, line.id, res, "projectProduct DELETE");
      return;
    }
    // R5 again: a 200 on a delete is famously not a delete.
    const raw = await officeProject<RawOfficeProject>(
      lead.clientKey,
      lead.bmiProjectId!,
      CRM_BUILDER_SESSION_TAG,
    );
    const stillThere = (raw.products ?? []).some((p) => str(p.id) === line.bmiProjectProductId);
    await ctx.store.patchLine(line.id, {
      status: stillThere ? "failed" : "removed",
      writeError: stillThere ? "Office answered 200 but the line is still on the project" : null,
      bmiProjectProductId: stillThere ? line.bmiProjectProductId : null,
    });
  });

  return loadBuilderState(ctx, leadPublicId);
}

// ---------------------------------------------------------------------------
// Schedules — the call that refuses (R6)
// ---------------------------------------------------------------------------

export interface LinkScheduleArgs {
  leadPublicId: string;
  lineId: string;
  blocks: ScheduleBlock[];
  /** Director only. Re-sends the identical body with `confirm: true`. */
  force?: boolean;
}

/**
 * Put a line onto its heats (or lane block).
 *
 * **THE 403 IS NOT AN ERROR PAGE.** Office answers an over-capacity link with
 * `{IsQuestion:false, Kind:4, Message:"Total persons (N) is higher than the
 * capacity …"}`. That is a SOFT REFUSAL: the heat is full. It is recorded on
 * the line, surfaced as "this heat is full — pick another", and never retried
 * blindly. A director may force it, which re-sends the identical body with
 * `confirm: true` — the whole protocol, exactly as `putProject` does it.
 *
 * Forcing is an overbook, so it is logged with the actor and the refusal text.
 */
export async function linkLineSchedule(
  ctx: BuilderContext,
  args: LinkScheduleArgs,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, args.leadPublicId);
  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());
  refuseIfPaused(writes);

  if (args.force && ctx.user.role !== "director") throw new CrmHttpError(403, "director_only");

  const line = await ctx.store.getLine(args.lineId);
  if (!line || line.leadId !== lead.rowId) throw new CrmHttpError(404, "line_not_found");
  if (!line.bmiProjectProductId) throw new CrmHttpError(409, "line_not_written");

  const projectId = lead.bmiProjectId!;
  const session = newWriteSession();

  await withProjectLock(projectId, async () => {
    const res = await linkSchedule(lead.clientKey, session, {
      projectId,
      projectProductId: line.bmiProjectProductId!,
      blocks: args.blocks,
      confirm: args.force === true,
    });

    if (!res.ok && res.kind === "prompt") {
      console.warn("[crm-builder] linkSchedule refused", {
        line_id: line.id,
        project_id: projectId,
        actor_email: ctx.user.email,
        forced: args.force === true,
        refusal: refusalLine(res.prompt),
      });
      await ctx.store.patchLine(line.id, {
        status: "failed",
        writeError: HEAT_FULL_MESSAGE,
        officePrompt: toWirePrompt(res.prompt),
        scheduleBlocks: args.blocks,
        resourceId: args.blocks[0]?.resourceId ?? null,
      });
      // A refusal the rep must act on: it travels as an error with the prompt
      // attached, not as a silent line state the screen might not notice.
      throw new CrmHttpError(409, HEAT_FULL_ERROR, toWirePrompt(res.prompt));
    }

    if (!res.ok) {
      await recordRefusal(ctx, line.id, res, "linkSchedule");
      return;
    }

    if (args.force) {
      console.log("[crm-builder] schedule FORCED through a refusal", {
        line_id: line.id,
        project_id: projectId,
        actor_email: ctx.user.email,
      });
    }

    const scheduleIds = (res.data.schedules ?? [])
      .map((s) => str(s.id))
      .filter((id): id is string => Boolean(id));

    await ctx.store.patchLine(line.id, {
      status: "written",
      writeError: null,
      officePrompt: null,
      scheduleBlocks: args.blocks,
      resourceId: args.blocks[0]?.resourceId ?? null,
      bmiScheduleIds: scheduleIds,
    });
  });

  return loadBuilderState(ctx, args.leadPublicId);
}

// ---------------------------------------------------------------------------
// Moving the date — `PUT /project` through the existing one-writer rail
// ---------------------------------------------------------------------------

/**
 * Move the whole event.
 *
 * Goes through `putProjectFields`, NOT a hand-rolled `PUT /project`: that
 * function is the codebase's one project-field writer, it takes the same Redis
 * lock, it builds the minimal payload the Office UI's own Save sends, it
 * answers the confirm prompt once, and it re-reads to verify. Re-implementing
 * any of that here would be a second writer for one entity.
 *
 * Every line is then RE-PRICED for the new date, because that is the whole
 * point: a Saturday event moved to a Tuesday is a different quote, and a stale
 * price left on the line is money.
 */
export async function moveProjectDate(
  ctx: BuilderContext,
  leadPublicId: string,
  date: string,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, leadPublicId);
  const writes = writesStateFor(lead.clientKey, await ctx.store.bmiWritesSetting());
  refuseIfPaused(writes);

  const projectId = lead.bmiProjectId!;
  await putProjectFields({
    clientKey: lead.clientKey,
    projectId,
    patch: { date: officeStamp(date, lead.eventTime) },
  });

  await ctx.store.updateLeadEventDate(lead.rowId, date);

  const session = newWriteSession();
  const lines = await ctx.store.listLines(lead.rowId);
  for (const line of lines) {
    if (line.status === "removed") continue;
    const priceCents = await priceForDate(lead.clientKey, line.productId, date, {
      quantity: line.quantity,
      projectId,
      session,
    });
    if (priceCents === null || priceCents === line.pricePerUnitCents) continue;
    await ctx.store.patchLine(line.id, { pricePerUnitCents: priceCents, priceDate: date });
  }

  return loadBuilderState(ctx, leadPublicId);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * "Start from a template" — scale its lines to THIS lead's guest count and
 * price every one of them for THIS event's date.
 *
 * Prices always come from `projectProduct/price`; the template contributes what
 * and how many, never how much.
 */
export async function applyTemplate(
  ctx: BuilderContext,
  leadPublicId: string,
  templateId: string,
): Promise<StatePayload> {
  const lead = await requireLeadWithProject(ctx, leadPublicId);
  const template = await ctx.store.getTemplate(templateId);
  if (!template) throw new CrmHttpError(404, "template_not_found");

  const scaled = scaleTemplate(template, lead.guests);
  for (const line of scaled) {
    await addQuoteLine(ctx, {
      leadPublicId,
      productId: line.productId,
      productName: line.productName ?? line.productId,
      quantity: line.quantity,
    });
  }
  await ctx.store.bumpTemplateUse(templateId);
  return loadBuilderState(ctx, leadPublicId);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function requireLeadWithProject(
  ctx: BuilderContext,
  leadPublicId: string,
): Promise<BuilderLeadRow> {
  const lead = await ctx.store.findLead(leadPublicId);
  if (!lead) throw new CrmHttpError(404, "lead_not_found");
  if (!lead.bmiProjectId) throw new CrmHttpError(409, "no_project");
  return lead;
}

/** The id Office assigned, or a 502 naming the call that did not return one. */
function writeResultId(res: OfficeWriteResult<{ id?: unknown }>, what: string): string {
  assertWriteOk(res, what);
  const id = res.ok ? str(res.data.id) : null;
  if (!id) throw new CrmHttpError(502, `${what}: no id returned`);
  return id;
}

function assertWriteOk(res: OfficeWriteResult<unknown>, what: string): void {
  if (res.ok) return;
  if (res.kind === "prompt") {
    throw new CrmHttpError(409, HEAT_FULL_ERROR, toWirePrompt(res.prompt));
  }
  throw new CrmHttpError(502, `${what}: Office answered ${res.status}`);
}

/** Write a failure onto the line, with Office's own words when it gave any. */
async function recordRefusal(
  ctx: BuilderContext,
  lineId: string,
  res: Exclude<OfficeWriteResult<unknown>, { ok: true }>,
  what: string,
): Promise<void> {
  const patch: QuoteLinePatch =
    res.kind === "prompt"
      ? { status: "failed", writeError: HEAT_FULL_MESSAGE, officePrompt: toWirePrompt(res.prompt) }
      : { status: "failed", writeError: `${what}: Office answered ${res.status}` };
  await ctx.store.patchLine(lineId, patch);
}
