/**
 * Office payload → `crm_bmi_projects` row, PURE (brief B1 "projection: raw →
 * row, ids stay strings"). No I/O, no Neon, no clock: the caller hands in the
 * parsed entities and gets back the row plus the account / contact matching
 * keys the leads sub upserts on.
 *
 * IDS ARE STRINGS ALL THE WAY. Every id field arrives already quoted by
 * `parseWithRawIds(text, OFFICE_ID_FIELDS)`; this module only ever `String()`s
 * them (a no-op on a string) and never `Number()`s one. `projection.test.ts`
 * feeds a raw-text fixture with bare 17-digit numbers through the same parse
 * and carries the negative control that shows `JSON.parse` would have rounded
 * them.
 *
 * DATES. Office stamps are LOCAL wall clock without a zone
 * (`"2026-12-12T18:00:00"`); the centres are all Eastern, so a stamp becomes an
 * instant with that calendar day's real ET offset (`etOffsetFor`, DST-safe)
 * and `event_date` is simply the first ten characters (R10: never local-`Date`
 * arithmetic on an event date).
 *
 * ACCOUNTS (brief B1): a BUSINESS when the contact person carries a company
 * name; otherwise a HOUSEHOLD keyed by last name + phone digits (falling back
 * to email, then to the person id, so two unrelated Smiths with no phone never
 * merge). `nameKey` is what `crm_accounts.name_key` is matched on.
 */

import { SMS_TIMING_RESOURCE_MAPPINGS } from "~/features/daily-events/constants";
import { centresForClientKey } from "../../core/centres";
import { etOffsetFor } from "../../core/dates";
import type { CentreCode } from "../../core/types";

// ---------------------------------------------------------------------------
// Office shapes (loose — the portal treated these as `any`; ids are strings)
// ---------------------------------------------------------------------------

export interface OfficeDpProject {
  id?: unknown;
  number?: unknown;
  name?: string;
  displayName?: string;
  personId?: unknown;
  persons?: number;
  date?: string;
  stateId?: unknown;
  kindId?: unknown;
  userId?: unknown;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface OfficeDpSchedule {
  projectId?: unknown;
  resourceId?: unknown;
  start?: string;
  stop?: string;
  [key: string]: unknown;
}

export interface OfficeDpPerson {
  id?: unknown;
  personId?: unknown;
  firstName?: string;
  name?: string;
  [key: string]: unknown;
}

export interface OfficeDayPlanner {
  reservations?: {
    projects?: OfficeDpProject[];
    projectSchedules?: OfficeDpSchedule[];
    persons?: OfficeDpPerson[];
  };
  [key: string]: unknown;
}

export interface OfficeProductLine {
  id?: unknown;
  productId?: unknown;
  quantity?: number;
  price?: number;
  totalPrice?: number;
  name?: string;
  productName?: string;
  [key: string]: unknown;
}

export interface OfficeProjectDetail extends OfficeDpProject {
  /**
   * The BUSINESS behind the booking, as a second PERSON record whose `name` is
   * the company (probed live 2026-09-13: Naples project 5725493 `companyId`
   * 5725529 → `person/5725529.name` = "Naples Bears"; 5638044 = "Blossom
   * Academy"; 5843900 = "Home Team Pest Defense"). Null on ~90% of projects —
   * those are households. See `accountKeyFor`.
   */
  companyId?: unknown;
  balance?: number;
  bills?: Array<{ id?: unknown; total?: number; balance?: number }>;
  products?: OfficeProductLine[];
  payments?: Array<{ amount?: number; [key: string]: unknown }>;
  projectPersons?: Array<{ id?: unknown; personId?: unknown; [key: string]: unknown }>;
  contactPersonId?: unknown;
  schedules?: OfficeDpSchedule[];
  logs?: unknown[];
  projectLogs?: unknown[];
}

export interface OfficePersonEntity {
  id?: unknown;
  firstName?: string;
  name?: string;
  company?: string | null;
  companyName?: string | null;
  addresses?: Array<{ email?: string | null; mobile?: string | null; phone?: string | null }>;
  [key: string]: unknown;
}

export interface OfficeLiveReservation {
  id: string;
  personInfo?: string;
  responsible?: string;
  referenceNumber?: string;
  state?: string;
  date?: string;
  persons?: number;
  products?: string | null;
  totalValue?: number;
  payments?: number;
  balance?: number;
  [key: string]: unknown;
}

/** Names for the small reference ids (metadata `stateNames` / `userNames`). */
export interface NameLookups {
  stateNames: Record<string, string>;
  userNames: Record<string, string>;
  productNames?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export type MirrorSource = "backfill" | "delta" | "detail";

export interface MirrorProductLine {
  id: string | null;
  productId: string | null;
  name: string | null;
  quantity: number | null;
  priceCents: number | null;
  totalCents: number | null;
}

/** One `crm_bmi_projects` row, camel-cased. Every id is a string. */
export interface MirrorRow {
  projectId: string;
  clientKey: string;
  locationId: number | null;
  number: string | null;
  name: string | null;
  stateId: string | null;
  stateName: string | null;
  kindId: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  /** YYYY-MM-DD (ET calendar day) */
  eventDate: string | null;
  /** ISO instant (UTC) */
  eventStart: string | null;
  persons: number | null;
  totalValueCents: number | null;
  balanceCents: number | null;
  personId: string | null;
  personName: string | null;
  /** E.164 */
  personPhone: string | null;
  personEmail: string | null;
  products: MirrorProductLine[] | null;
  raw: Record<string, unknown> | null;
  source: MirrorSource;
  bmiCreatedAt: string | null;
  bmiUpdatedAt: string | null;
}

export interface AccountKey {
  kind: "business" | "household";
  name: string;
  nameKey: string;
}

export interface ContactKey {
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  emailKey: string | null;
  bmiPersonId: string | null;
}

export interface Projected {
  row: MirrorRow;
  account: AccountKey | null;
  contact: ContactKey | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function idString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "null" || s === "undefined" ? null : s;
}

const OFFICE_STAMP = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** `"2026-12-12T18:00:00"` (Office local) → `{ymd, iso}` with the day's real ET offset. */
export function officeStampToInstant(stamp: unknown): { ymd: string; iso: string } | null {
  if (typeof stamp !== "string") return null;
  const m = OFFICE_STAMP.exec(stamp.trim());
  if (!m) return null;
  const ymd = m[1] as string;
  const hh = m[2] ?? "00";
  const mm = m[3] ?? "00";
  const ss = m[4] ?? "00";
  const d = new Date(`${ymd}T${hh}:${mm}:${ss}${etOffsetFor(ymd)}`);
  if (Number.isNaN(d.getTime())) return null;
  return { ymd, iso: d.toISOString() };
}

/** Dollars (float) → whole cents; null for anything that is not a finite number. */
export function moneyToCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/**
 * Same rule as `canonicalizePhone` in `lib/participant-contact.ts` (pinned by a
 * test): 10 digits → `+1…`, 11 digits starting with 1 → `+…`, else null.
 */
export function toE164(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function emailKeyOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

const LEGAL_SUFFIX =
  /\b(inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|pllc|pa|p\.a)\b\.?/g;

/** `"Acme Corp., Inc."` → `"acme"`; `"The Rodriguez family"` → `"the rodriguez family"`. */
export function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/** Drop the log arrays (staff memos) before the raw copy is stored. */
/**
 * One Office log entry, trimmed to what a timeline needs.
 *
 * Office keeps the memo in `logs[].memo`, one entry per note, each carrying its
 * own `created` stamp and a `public` flag that separates what the guest sees on
 * the contract page from the private staff log. That is the history — on
 * project 3492 it holds the contract link, "Contract sent to
 * rblanchard@selectmedical.com" dated 18 Aug and a final-headcount reminder
 * dated 11 Sep; on H2892 a card-declined notice.
 */
export interface MirrorLogEntry {
  id: string | null;
  public: boolean;
  kind: string | null;
  action: string | null;
  memo: string;
  created: string | null;
  updated: string | null;
}

export function trimLogs(detail: Record<string, unknown>): MirrorLogEntry[] {
  const raw = detail.logs ?? detail.projectLogs;
  if (!Array.isArray(raw)) return [];
  const out: MirrorLogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const memo = typeof e.memo === "string" ? e.memo : "";
    if (!memo.trim()) continue;
    out.push({
      // Office ids are 17 digits — string, never Number().
      id: e.id === null || e.id === undefined ? null : String(e.id),
      public: e.public === true,
      kind: e.kind === null || e.kind === undefined ? null : String(e.kind),
      action: e.action === null || e.action === undefined ? null : String(e.action),
      memo,
      created: typeof e.created === "string" ? e.created : null,
      updated: typeof e.updated === "string" ? e.updated : null,
    });
  }
  return out;
}

/**
 * THE LOGS ARE KEPT, TRIMMED — they were the history we were throwing away.
 *
 * This used to drop `logs` and `projectLogs` outright, which is why the deal's
 * Timeline said "Nothing logged yet" over a project whose memo recorded a
 * contract being sent, a reminder going out and a card being declined (owner,
 * 2026-09-13: "missing timeline history etc. You should be able to pull it from
 * the notes"). The Notes tab reads the memo live from Office, so the data was
 * always reachable — nothing stored it, so nothing could build a history from
 * it.
 *
 * Only the fields a timeline needs are kept, not the whole entry: an Office log
 * carries device and user ids we have no use for, and the mirror is 5,000 rows
 * wide.
 */
export function trimRaw(detail: Record<string, unknown>): Record<string, unknown> {
  const { logs: _logs, projectLogs: _projectLogs, ...rest } = detail;
  void _logs;
  void _projectLogs;
  const logs = trimLogs(detail);
  return logs.length > 0 ? { ...rest, logs } : rest;
}

// ---------------------------------------------------------------------------
// Location: FT and HPFM share one tenant; the schedule's resource says which
// ---------------------------------------------------------------------------

/**
 * Naples is one centre. For the shared Fort Myers tenant a project is FastTrax
 * when EVERY scheduled resource maps to 467486 only (the karting resources),
 * otherwise HeadPinz Fort Myers; a schedule-less project defaults to HPFM.
 */
export function locationIdFor(
  clientKey: string,
  resourceIds: readonly string[],
  mappings: Record<string, number[]> = SMS_TIMING_RESOURCE_MAPPINGS,
): number | null {
  const centres = centresForClientKey(clientKey);
  if (centres.length === 0) return null;
  if (centres.length === 1) return centres[0]!.locationId;
  const mapped = resourceIds.map((r) => mappings[r]).filter((m): m is number[] => !!m);
  if (mapped.length > 0 && mapped.every((m) => m.length === 1 && m[0] === 467486)) return 467486;
  return 332160;
}

export function centreCodeForLocation(locationId: number | null): CentreCode | null {
  if (locationId === 332160) return "HPFM";
  if (locationId === 467486) return "FT";
  if (locationId === 332145) return "HPN";
  return null;
}

// ---------------------------------------------------------------------------
// Person → contact + account keys
// ---------------------------------------------------------------------------

export function personContact(person: OfficePersonEntity | null): ContactKey | null {
  if (!person) return null;
  const firstName = firstString(person.firstName) ?? "";
  const lastName = firstString(person.name) ?? "";
  const addresses = Array.isArray(person.addresses) ? person.addresses : [];
  let phone: string | null = null;
  let email: string | null = null;
  for (const a of addresses) {
    phone ??= toE164(a?.mobile) ?? toE164(a?.phone);
    email ??= firstString(a?.email);
  }
  const emailKey = emailKeyOf(email);
  if (!firstName && !lastName && !phone && !emailKey) return null;
  return {
    firstName,
    lastName,
    phoneE164: phone,
    email: emailKey ? (email as string) : null,
    emailKey,
    bmiPersonId: idString(person.id),
  };
}

/**
 * A company name from the HOST person record. Kept as a secondary rail only:
 * a real Office person entity has no `company` field at all (probed live
 * 2026-09-13 against five Naples hosts — the keys are `privateMemo, publicMemo,
 * tags, memberships, alias, …, name2, free1, free2, kind, …, addresses`), so
 * in production this always returns null and the company comes from the
 * project's `companyId` person instead (`companyNameOf`).
 */
export function personCompany(person: OfficePersonEntity | null): string | null {
  if (!person) return null;
  return firstString(person.company, person.companyName);
}

/** The business name on a `companyId` person record: its `name` field. */
export function companyNameOf(company: OfficePersonEntity | null): string | null {
  if (!company) return null;
  return firstString(company.name, company.company, company.companyName);
}

/**
 * The account a project belongs to. BUSINESS when the project names a company
 * (`companyId` → that person's `name`, passed in as `companyName`; the host
 * person's own `company` field is a fallback for rails that carry one); else a
 * household keyed on `lastName + phone digits` (brief B1), then email, then the
 * person id — never on the last name alone.
 *
 * Two bookings by different people for the same company (Naples had two
 * "Arthrex" events in one month, each with its own `companyId` record) share a
 * `nameKey`, so they land on ONE account — which is the whole point of the
 * History screen's business rows.
 */
export function accountKeyFor(
  person: OfficePersonEntity | null,
  contact: ContactKey | null,
  companyName?: string | null,
): AccountKey | null {
  const company = firstString(companyName) ?? personCompany(person);
  if (company) {
    const key = normalizeNameKey(company);
    if (key) return { kind: "business", name: company, nameKey: key };
  }
  if (!contact) return null;
  const last = normalizeNameKey(contact.lastName);
  const discriminator = contact.phoneE164
    ? contact.phoneE164.replace(/\D/g, "")
    : contact.emailKey
      ? contact.emailKey
      : contact.bmiPersonId
        ? `person:${contact.bmiPersonId}`
        : null;
  // No phone, email or person id → nothing safe to key on; a surname alone
  // would merge every Smith into one household.
  if (!discriminator) return null;
  // CALL THEM BY THEIR NAME, not by a relationship we invented.
  //
  // This used to read "The Leslie family". Owner: "I don't like your labels of
  // 'family' how do you know its family? Maybe by name or company name". They
  // are right — nothing in BMI says these people are a family. Edward Leslie
  // booking a hundred guests is a group organiser, and calling him a family
  // makes the CRM look like it is guessing, because it was.
  //
  // The person's own name is the honest label and it is what a planner would
  // say out loud. `kind` still records that this is a household rather than a
  // business, so anything that needs the distinction keeps it; only the words
  // on screen change.
  const full = [contact.firstName, contact.lastName]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const name = full || contact.lastName?.trim() || contact.firstName?.trim() || "Unnamed host";
  return { kind: "household", name, nameKey: `household:${last}:${discriminator ?? ""}` };
}

// ---------------------------------------------------------------------------
// Detail → row
// ---------------------------------------------------------------------------

export function projectProducts(
  detail: OfficeProjectDetail,
  lookups: NameLookups | null,
): MirrorProductLine[] | null {
  if (!Array.isArray(detail.products)) return null;
  return detail.products.map((p) => {
    const productId = idString(p.productId);
    const name =
      firstString(p.name, p.productName) ??
      (productId && lookups?.productNames ? (lookups.productNames[productId] ?? null) : null);
    const quantity = typeof p.quantity === "number" ? p.quantity : null;
    const priceCents = moneyToCents(p.price);
    const totalCents =
      moneyToCents(p.totalPrice) ??
      (priceCents !== null && quantity !== null ? priceCents * quantity : null);
    return { id: idString(p.id), productId, name, quantity, priceCents, totalCents };
  });
}

/** Σ products.totalPrice, else Σ bills.total, else null. */
export function projectTotalCents(detail: OfficeProjectDetail): number | null {
  const lines = projectProducts(detail, null);
  if (lines && lines.length > 0 && lines.some((l) => l.totalCents !== null)) {
    return lines.reduce((sum, l) => sum + (l.totalCents ?? 0), 0);
  }
  if (Array.isArray(detail.bills) && detail.bills.length > 0) {
    const totals = detail.bills
      .map((b) => moneyToCents(b.total))
      .filter((c): c is number => c !== null);
    if (totals.length > 0) return totals.reduce((a, b) => a + b, 0);
  }
  return null;
}

/** `balance` when Office states it, else total − Σ payments, else Σ bills.balance. */
export function projectBalanceCents(detail: OfficeProjectDetail): number | null {
  const stated = moneyToCents(detail.balance);
  if (stated !== null) return stated;
  const total = projectTotalCents(detail);
  if (total !== null && Array.isArray(detail.payments)) {
    const paid = detail.payments.reduce((s, p) => s + (moneyToCents(p.amount) ?? 0), 0);
    return total - paid;
  }
  if (Array.isArray(detail.bills) && detail.bills.length > 0) {
    const bals = detail.bills
      .map((b) => moneyToCents(b.balance))
      .filter((c): c is number => c !== null);
    if (bals.length > 0) return bals.reduce((a, b) => a + b, 0);
  }
  return null;
}

export interface ProjectionContext {
  clientKey: string;
  source: MirrorSource;
  lookups: NameLookups | null;
  /** Resource ids from the dayPlanner schedules for this project (location split). */
  scheduleResourceIds?: readonly string[];
  /** The business name read from the project's `companyId` person, when it has one. */
  companyName?: string | null;
}

/**
 * The full projection: a project entity (`GET project/{id}`) plus its contact
 * person (`GET person/{id}`, may be null) → row + matching keys.
 */
export function projectDetail(
  detail: OfficeProjectDetail,
  person: OfficePersonEntity | null,
  ctx: ProjectionContext,
): Projected {
  const projectId = idString(detail.id);
  if (!projectId) throw new Error("projection: project has no id");
  const lookups = ctx.lookups;
  const stateId = idString(detail.stateId);
  const userId = idString(detail.userId);
  const when = officeStampToInstant(detail.date);
  const created = officeStampToInstant(detail.created);
  const updated = officeStampToInstant(detail.updated);
  const scheduleIds = [
    ...(ctx.scheduleResourceIds ?? []),
    ...(Array.isArray(detail.schedules)
      ? detail.schedules.map((s) => idString(s.resourceId)).filter((x): x is string => !!x)
      : []),
  ];
  const contact = personContact(person);
  const account = accountKeyFor(person, contact, ctx.companyName ?? null);
  const personName = contact
    ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null
    : null;
  const row: MirrorRow = {
    projectId,
    clientKey: ctx.clientKey,
    locationId: locationIdFor(ctx.clientKey, scheduleIds),
    number: idString(detail.number),
    name: firstString(detail.name, detail.displayName),
    stateId,
    stateName: stateId && lookups ? (lookups.stateNames[stateId] ?? null) : null,
    kindId: idString(detail.kindId),
    responsibleUserId: userId,
    responsibleName: userId && lookups ? (lookups.userNames[userId] ?? null) : null,
    eventDate: when?.ymd ?? null,
    eventStart: when?.iso ?? null,
    persons: typeof detail.persons === "number" ? detail.persons : null,
    totalValueCents: projectTotalCents(detail),
    balanceCents: projectBalanceCents(detail),
    personId: idString(detail.personId) ?? idString(detail.contactPersonId),
    personName,
    personPhone: contact?.phoneE164 ?? null,
    personEmail: contact?.email ?? null,
    products: projectProducts(detail, lookups),
    raw: trimRaw(detail as Record<string, unknown>),
    source: ctx.source,
    bmiCreatedAt: created?.iso ?? null,
    bmiUpdatedAt: updated?.iso ?? null,
  };
  return { row, account, contact };
}

// ---------------------------------------------------------------------------
// dayPlanner → the window's project list (ids + the schedule resources per id)
// ---------------------------------------------------------------------------

export interface DayPlannerProjectRef {
  projectId: string;
  kindId: string | null;
  scheduleResourceIds: string[];
}

/**
 * The distinct projects in a dayPlanner window, in first-seen order. KEEPS
 * `kindId -10` (online bookings) — flagged by `kind_id`, filtered by the
 * readers — and dedupes by id, which is also how the FM/FT shared tenant is
 * handled: both centres' resources are queried in ONE call, so a project with
 * schedules at both appears once.
 */
export function dayPlannerProjects(dp: OfficeDayPlanner): DayPlannerProjectRef[] {
  const projects = dp.reservations?.projects ?? [];
  const schedules = dp.reservations?.projectSchedules ?? [];
  const resourcesByProject = new Map<string, Set<string>>();
  for (const s of schedules) {
    const pid = idString(s.projectId);
    const rid = idString(s.resourceId);
    if (!pid || !rid) continue;
    if (!resourcesByProject.has(pid)) resourcesByProject.set(pid, new Set());
    resourcesByProject.get(pid)!.add(rid);
  }
  const seen = new Set<string>();
  const out: DayPlannerProjectRef[] = [];
  for (const p of projects) {
    const pid = idString(p.id);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push({
      projectId: pid,
      kindId: idString(p.kindId),
      scheduleResourceIds: [...(resourcesByProject.get(pid) ?? [])],
    });
  }
  return out;
}

/** `"Send Contract"` → `"49130082"` for the tenant; null when no name matches. */
export function idForName(names: Record<string, string>, name: string | null): string | null {
  if (!name) return null;
  const want = name.trim().toLowerCase();
  for (const [id, label] of Object.entries(names)) {
    if (typeof label === "string" && label.trim().toLowerCase() === want) return id;
  }
  return null;
}

/**
 * A `liveReservations` row alone → a PARTIAL mirror row (`source: "delta"`),
 * for a changed project whose detail read failed. The live row carries NAMES
 * where a project detail carries ids, so each name is resolved back to its id
 * through the tenant's metadata before it is stored.
 *
 * A NAME IS NEVER STORED WITHOUT ITS ID. The upsert COALESCEs `state_id` /
 * `responsible_user_id`, so writing a fresh `state_name` next to an id that
 * could not be resolved would leave the row saying two different things — a
 * "Cancellation" name over a stale "Send Contract" id. When the lookup cannot
 * place the name, both halves stay null and the row keeps what the last full
 * read stored (the run's error names the project and a retry is enqueued).
 *
 * `personInfo` is Office's display string for the host; it is stored as the
 * person name verbatim (never parsed into an account key — that needs the
 * person entity).
 */
export function liveReservationRow(
  lr: OfficeLiveReservation,
  clientKey: string,
  lookups: NameLookups,
): MirrorRow | null {
  const projectId = idString(lr.id);
  if (!projectId) return null;
  const when = officeStampToInstant(lr.date);
  const stateName = firstString(lr.state);
  const stateId = idForName(lookups.stateNames, stateName);
  const responsibleName = firstString(lr.responsible);
  const responsibleUserId = idForName(lookups.userNames, responsibleName);
  return {
    projectId,
    clientKey,
    locationId: null,
    number: firstString(lr.referenceNumber),
    name: null,
    stateId,
    stateName: stateId ? stateName : null,
    kindId: null,
    responsibleUserId,
    responsibleName: responsibleUserId ? responsibleName : null,
    eventDate: when?.ymd ?? null,
    eventStart: when?.iso ?? null,
    persons: typeof lr.persons === "number" ? lr.persons : null,
    totalValueCents: moneyToCents(lr.totalValue),
    balanceCents: moneyToCents(lr.balance),
    personId: null,
    personName: firstString(lr.personInfo),
    personPhone: null,
    personEmail: null,
    products: null,
    raw: null,
    source: "delta",
    bmiCreatedAt: null,
    bmiUpdatedAt: null,
  };
}

/**
 * A dayPlanner project entry alone → a STUB mirror row, for the online
 * bookings (`kindId -10`). Measured 2026-09-13: Fort Myers December 2025 had
 * 2,987 online bookings against 220 group events in one window, so reading a
 * detail + person for each would be ~6,000 Office calls per window for rows
 * the CRM only ever counts. The stub carries everything the dayPlanner entry
 * states (ids, number, name, date, persons, state, kind, responsible) plus the
 * host's name from the window's `persons[]`; products / totals / contact stay
 * null and the readers hide the row (`kind_id = '-10'`) anyway.
 */
export function dayPlannerStubRow(
  p: OfficeDpProject,
  personsById: ReadonlyMap<string, OfficeDpPerson>,
  ctx: ProjectionContext,
): MirrorRow | null {
  const projectId = idString(p.id);
  if (!projectId) return null;
  const lookups = ctx.lookups;
  const stateId = idString(p.stateId);
  const userId = idString(p.userId);
  const personId = idString(p.personId);
  const person = personId ? personsById.get(personId) : undefined;
  const personName = person
    ? [person.firstName, person.name]
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .join(" ")
        .trim() || null
    : null;
  const when = officeStampToInstant(p.date);
  const created = officeStampToInstant(p.created);
  const updated = officeStampToInstant(p.updated);
  return {
    projectId,
    clientKey: ctx.clientKey,
    locationId: locationIdFor(ctx.clientKey, ctx.scheduleResourceIds ?? []),
    number: idString(p.number),
    name: firstString(p.name, p.displayName),
    stateId,
    stateName: stateId && lookups ? (lookups.stateNames[stateId] ?? null) : null,
    kindId: idString(p.kindId),
    responsibleUserId: userId,
    responsibleName: userId && lookups ? (lookups.userNames[userId] ?? null) : null,
    eventDate: when?.ymd ?? null,
    eventStart: when?.iso ?? null,
    persons: typeof p.persons === "number" ? p.persons : null,
    totalValueCents: null,
    balanceCents: null,
    personId,
    personName,
    personPhone: null,
    personEmail: null,
    products: null,
    raw: null,
    source: ctx.source,
    bmiCreatedAt: created?.iso ?? null,
    bmiUpdatedAt: updated?.iso ?? null,
  };
}

/** The window's `persons[]` keyed by id. */
export function dayPlannerPersons(dp: OfficeDayPlanner): Map<string, OfficeDpPerson> {
  const out = new Map<string, OfficeDpPerson>();
  for (const person of dp.reservations?.persons ?? []) {
    const id = idString(person.id) ?? idString(person.personId);
    if (id && !out.has(id)) out.set(id, person);
  }
  return out;
}

/** The dayPlanner entries keyed by project id (first occurrence wins). */
export function dayPlannerEntries(dp: OfficeDayPlanner): Map<string, OfficeDpProject> {
  const out = new Map<string, OfficeDpProject>();
  for (const p of dp.reservations?.projects ?? []) {
    const id = idString(p.id);
    if (id && !out.has(id)) out.set(id, p);
  }
  return out;
}

export const ONLINE_KIND_ID = "-10";

/** The ids `liveReservations` says changed, deduped, in order. */
export function liveReservationIds(rows: readonly OfficeLiveReservation[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const id = idString(r.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
