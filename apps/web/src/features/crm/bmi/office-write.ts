/**
 * The CRM's ONE door to BMI Office **writes** (C5) — the sibling of
 * `transport.ts`, which is the one door to reads.
 *
 * Everything that mutates an Office project for the builder goes through here.
 * Nothing else in the CRM opens a write socket to Office, so there is exactly
 * one place that knows how a body is serialised, how a response is parsed, and
 * how Office's 403 soft refusal is recognised.
 *
 * ── THE FIVE RULES THIS FILE EXISTS TO KEEP ───────────────────────────────
 *
 * 1. **Never `JSON.parse` an Office response.** Every reply is read with
 *    `parseWithRawIds(text, OFFICE_ID_FIELDS)`. A `projectProduct.id` and a
 *    `personId` are 17 digits on a live tenant; standard parsing rounds them
 *    and the failure is SILENT — you get an id-shaped number back. A
 *    `: string` annotation does not prevent it.
 *
 * 2. **Never `JSON.stringify` a body carrying an id as a JS number.** Ids
 *    reach this module as strings and leave as QUOTED strings, which is
 *    byte-compatible with the one projectProduct write this codebase has
 *    proven in production (`lib/bmi-office-actions.ts` `updateProjectProduct`
 *    sends `"projectId":"58454076"`) and is lossless at 17 digits in a way a
 *    JSON number is not. The `PUT /project` rail is the exception and is NOT
 *    re-implemented here: it goes through `putProjectFields`, whose
 *    `projectPutJson` reproduces the proven byte shape exactly.
 *
 * 3. **A 403 is not automatically an error.** Office answers an over-capacity
 *    write with a soft-refusal envelope (`{IsQuestion, Kind, Message,
 *    OperationId}`) that `confirm: true` overrides. `officeWrite` RETURNS it
 *    instead of throwing, because the builder must show the rep "this heat is
 *    full, pick another" — never a stack trace, and never a blind retry.
 *
 * 4. **A write session is per operation.** `x-session-id` is minted once per
 *    logical operation and reused across its GET → mutate → PUT, exactly as
 *    the Office UI does. It is NEVER the shared `events` read session (a
 *    mutation on a session guests are reading is how state leaks between
 *    callers) and never a clock (tasks/lessons.md 2026-08-25).
 *
 * 5. **A 200 is not a result.** Nothing here reports success from a status
 *    code. The caller re-reads the project and proves the row is there —
 *    `service/builder.ts` does that for every line it writes.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────
 *
 * The verb + path of each call below is the sequence captured from the Office
 * UI's own DevTools trace by the owner. Each REQUEST BODY is built by its own
 * named, exported, unit-tested function so that a correction from a live smoke
 * lands in exactly one place and nowhere else. See `office-write.test.ts`.
 */

import https from "https";
import { randomUUID } from "crypto";
import { parseWithRawIds, serializeWithRawIds } from "@ft/db";
import { officePromptFrom, officePromptLine } from "@/lib/bmi-office-actions";
import { SMS_HEADERS, SMS_TIMING_BASE_URL } from "~/features/daily-events/constants";
import { OFFICE_ID_FIELDS, getOfficeToken } from "~/features/daily-events/data/bmi-office";
import type { OfficePrompt } from "~/features/crm/core/contracts";
import type { ScheduleBlock } from "./contracts";

/** Same version string every proven Office caller in this codebase sends. */
const SMS_VERSION = "6251006 202511051229";

/** `SMS_TIMING_BASE_URL` without the scheme — `https.get` wants a hostname. */
const OFFICE_HOST = SMS_TIMING_BASE_URL.replace(/^https?:\/\//, "");

const WRITE_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// The result of one write
// ---------------------------------------------------------------------------

export interface OfficeWriteOk<T> {
  ok: true;
  status: number;
  data: T;
  /** The response text, unparsed — kept so a caller can log it verbatim. */
  raw: string;
}

/**
 * Office's 403 soft refusal. `IsQuestion` is NOT the test (our API2 service
 * account is never offered the dialog and gets `IsQuestion:false` with
 * "overbooking is not allowed", which reads final and is not); the presence of
 * the envelope is. A genuine 403 — bad token, no permission — is not JSON in
 * this shape and comes back as `kind: "http"`.
 */
export interface OfficeWriteRefused {
  ok: false;
  kind: "prompt";
  status: number;
  /** Verbatim, as Office sent it. */
  prompt: { IsQuestion?: boolean; Kind?: number; Message?: string; OperationId?: string };
  raw: string;
}

export interface OfficeWriteFailed {
  ok: false;
  kind: "http";
  status: number;
  raw: string;
}

export type OfficeWriteResult<T> = OfficeWriteOk<T> | OfficeWriteRefused | OfficeWriteFailed;

/** Narrow the sub-feature's raw prompt to the `{message, operationId}` wire shape. */
export function toWirePrompt(prompt: OfficeWriteRefused["prompt"]): OfficePrompt {
  return {
    message: (prompt.Message ?? "").replace(/\s+/g, " ").trim(),
    ...(prompt.OperationId ? { operationId: prompt.OperationId } : {}),
  };
}

/** One line for a log: kind, question-ness, and the message with its literal \n flattened. */
export function refusalLine(prompt: OfficeWriteRefused["prompt"]): string {
  return officePromptLine(prompt);
}

// ---------------------------------------------------------------------------
// Sessions and headers
// ---------------------------------------------------------------------------

/**
 * A fresh write session. Mint ONE per logical operation and pass it to every
 * call in that operation — `officeWrite` does not mint its own, precisely so a
 * GET → mutate → PUT pair cannot accidentally straddle two sessions.
 */
export function newWriteSession(): string {
  return randomUUID();
}

function writeHeaders(token: string, clientKey: string, sessionId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    clientkey: clientKey,
    "x-fast-version": SMS_VERSION,
    "x-session-id": sessionId,
    ...SMS_HEADERS,
  };
}

export interface OfficeWriteInit {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Pre-serialised. Never pass an object — see rule 2 at the top of the file. */
  body?: string;
  sessionId: string;
}

/**
 * One request against Office's write surface.
 *
 * Throws only on a transport failure (DNS, TLS, timeout, abort). Every HTTP
 * answer — 200, 403-with-envelope, 500 — comes back as a value, because the
 * builder has a different thing to say for each and none of them is a 500 page.
 */
export async function officeWrite<T>(
  clientKey: string,
  endpoint: string,
  init: OfficeWriteInit,
): Promise<OfficeWriteResult<T>> {
  const token = await getOfficeToken(clientKey);
  const res = await fetch(`${SMS_TIMING_BASE_URL}/api/${clientKey}/${endpoint}`, {
    method: init.method,
    headers: writeHeaders(token, clientKey, init.sessionId),
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  const raw = await res.text();

  const prompt = officePromptFrom(res.status, raw);
  if (prompt) return { ok: false, kind: "prompt", status: res.status, prompt, raw };

  if (!res.ok) return { ok: false, kind: "http", status: res.status, raw };

  // An empty 200/204 is a legitimate answer to a DELETE.
  const data = raw.trim() ? parseWithRawIds<T>(raw, OFFICE_ID_FIELDS) : ({} as T);
  return { ok: true, status: res.status, data, raw };
}

// ---------------------------------------------------------------------------
// Request bodies — ONE named builder per call, so a smoke correction is local
// ---------------------------------------------------------------------------

/**
 * `POST /project/autocreate` — the empty project shell.
 *
 * The UI's "new project" button. Office assigns the id, the reference number
 * and the default state; everything the rep chose lands on the follow-up
 * `autosave`, which is why this body is deliberately minimal.
 */
export interface AutocreateInput {
  locationId: number;
  /** YYYY-MM-DD, centre-local. */
  date: string;
  /** HH:MM, centre-local, or null. */
  time: string | null;
  persons: number;
  name: string;
}

export function autocreateBody(input: AutocreateInput): string {
  return JSON.stringify({
    locationId: input.locationId,
    date: officeStamp(input.date, input.time),
    persons: input.persons,
    name: input.name,
    confirm: false,
  });
}

/**
 * `POST /project/autosave` — the rep's details onto the shell.
 *
 * Takes the project id as a STRING (rule 2). `personId` is the host, attached
 * once `search/person` has found or `PUT /person` has updated them.
 */
export interface AutosaveInput {
  projectId: string;
  name: string;
  date: string;
  time: string | null;
  persons: number;
  personId: string | null;
  companyId?: string | null;
}

export function autosaveBody(input: AutosaveInput): string {
  const body: Record<string, unknown> = {
    id: input.projectId,
    name: input.name,
    displayName: input.name,
    date: officeStamp(input.date, input.time),
    persons: input.persons,
    confirm: false,
  };
  if (input.personId) body.personId = input.personId;
  if (input.companyId) body.companyId = input.companyId;
  return JSON.stringify(body);
}

/**
 * `POST /projectProduct` — add a line to the project.
 *
 * Field for field the body `lib/bmi-office-actions.ts` `updateProjectProduct`
 * has been PUTting in production since the group-function service charge
 * shipped — same keys, same order, same string ids — with `id` omitted,
 * because this is the create. That is the only projectProduct body this
 * codebase has ever proven, so it is the one we send.
 */
export interface ProjectProductInput {
  projectId: string;
  productId: string;
  quantity: number;
  /** Dollars, as Office speaks money on this endpoint. */
  pricePerUnit: number;
  /** Overrides the catalogue name on the quote; null keeps Office's own. */
  name?: string | null;
}

export function projectProductBody(input: ProjectProductInput): string {
  return JSON.stringify({
    projectId: input.projectId,
    productId: input.productId,
    quantity: input.quantity,
    pricePerUnit: input.pricePerUnit,
    totalPrice: round2(input.pricePerUnit * input.quantity),
    isVisible: true,
    discountMetaId: null,
    name: input.name ?? null,
    dynamicGroups: null,
  });
}

/**
 * `POST /projectProduct/linkSchedule` — put a line onto its heats or lanes.
 *
 * THE CALL THAT REFUSES. Every block is centre-local wall clock with no
 * offset, exactly as `dayPlanner` reports it, so an evening can never be
 * re-interpreted in UTC and land on the next day.
 *
 * `confirm` is `false` on the first attempt, always. A director's "force"
 * re-sends the IDENTICAL body with `confirm: true` — that is the whole
 * protocol, measured on `PUT /project` and applied here unchanged.
 */
export interface LinkScheduleInput {
  projectId: string;
  projectProductId: string;
  blocks: ScheduleBlock[];
  confirm?: boolean;
}

export function linkScheduleBody(input: LinkScheduleInput): string {
  return JSON.stringify({
    projectId: input.projectId,
    projectProductId: input.projectProductId,
    schedules: input.blocks.map((b) => ({
      resourceId: b.resourceId,
      start: b.start,
      stop: b.stop,
      persons: b.persons,
    })),
    confirm: input.confirm === true,
  });
}

/** `PUT /projectSchedule/batch` — move or resize blocks already linked. */
export interface ScheduleBatchInput {
  projectId: string;
  schedules: Array<ScheduleBlock & { id: string }>;
  confirm?: boolean;
}

export function scheduleBatchBody(input: ScheduleBatchInput): string {
  return JSON.stringify({
    projectId: input.projectId,
    schedules: input.schedules.map((s) => ({
      id: s.id,
      resourceId: s.resourceId,
      start: s.start,
      stop: s.stop,
      persons: s.persons,
    })),
    confirm: input.confirm === true,
  });
}

// ---------------------------------------------------------------------------
// Time and money helpers — pure, and the only place either is formatted
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` + `HH:MM` → the stamp Office speaks: centre-local wall clock
 * with NO offset and NO `Z` (`"2026-10-17T18:00:00"`).
 *
 * Deliberately string surgery rather than a `Date`: a `Date` on a UTC Vercel
 * lambda and a `Date` on a rep's laptop disagree about what "6 pm" is, and an
 * evening event that crosses midnight in UTC is the `bookedAt` bug all over
 * again. No instant is constructed, so none can be re-interpreted.
 */
export function officeStamp(date: string, time: string | null): string {
  const day = date.slice(0, 10);
  const hhmm = /^\d{2}:\d{2}/.test(time ?? "") ? (time as string).slice(0, 5) : "00:00";
  return `${day}T${hhmm}:00`;
}

/** Cents → the dollars Office wants on a product line, without float drift. */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** Office dollars → our cents. `Math.round` because 19.99 × 100 is 1998.9999…. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export interface OfficeProjectShell {
  id?: unknown;
  number?: unknown;
  name?: unknown;
  date?: unknown;
  persons?: unknown;
  personId?: unknown;
  stateId?: unknown;
}

/** `POST /project/autocreate`. */
export function autocreateProject(
  clientKey: string,
  sessionId: string,
  input: AutocreateInput,
): Promise<OfficeWriteResult<OfficeProjectShell>> {
  return officeWrite<OfficeProjectShell>(clientKey, "project/autocreate", {
    method: "POST",
    body: autocreateBody(input),
    sessionId,
  });
}

/** `POST /project/autosave`. */
export function autosaveProject(
  clientKey: string,
  sessionId: string,
  input: AutosaveInput,
): Promise<OfficeWriteResult<OfficeProjectShell>> {
  return officeWrite<OfficeProjectShell>(clientKey, "project/autosave", {
    method: "POST",
    body: autosaveBody(input),
    sessionId,
  });
}

/** One row of `search/person`. The id field is `localId`, not `id`. */
export interface OfficePersonHit {
  localId: string;
  description: string;
}

/**
 * `GET /search/person?token=&maxResults=` — find the host before minting a
 * duplicate.
 *
 * FOUR HARD-WON FACTS, none of them optional (kiosk `license/lookup.server.ts`,
 * `scripts/racer-tag-semantics-probe.mts`, docs/pandora-api.md):
 *
 *  - **The parameter is `token`, not `q`.**
 *  - **It MUST go over raw `https.get`.** This endpoint 500s under Node
 *    fetch/undici for single-word and slash-bearing tokens — which an email
 *    address and a phone number both are. `person/{id}` is fine on fetch;
 *    this one is not, and no amount of header fiddling changes it.
 *  - **The id field is `localId`**, and it is 17 digits on a modern record, so
 *    the body is parsed with `parseWithRawIds(body, ["localId"])`. Never
 *    `res.json()`.
 *  - **It is CENTRE-SCOPED, and so is every id it returns.** A person id from
 *    one BMI local server means nothing on another (Naples ran a 15.9% waiver
 *    failure rate against Fort Myers' 0.4% from exactly this mistake). The
 *    caller passes the lead's own `clientKey` and never a default.
 *
 * Bare NAME tokens 500 by design — the caller searches by email, then phone.
 * One retry on a 5xx, then the failure is the caller's to handle.
 */
export async function searchPerson(
  clientKey: string,
  sessionId: string,
  token: string,
  maxResults = 50,
): Promise<OfficeWriteResult<OfficePersonHit[]>> {
  const bearer = await getOfficeToken(clientKey);
  const path =
    `/api/${clientKey}/search/person` +
    `?token=${encodeURIComponent(token)}&maxResults=${maxResults}`;
  const headers = {
    Authorization: `Bearer ${bearer}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": sessionId,
    clientkey: clientKey,
  };

  let res = await officeHttpsGet(path, headers);
  if (res.status >= 500) res = await officeHttpsGet(path, headers);
  if (res.status >= 400) return { ok: false, kind: "http", status: res.status, raw: res.body };

  const hits = parseWithRawIds<OfficePersonHit[]>(res.body, ["localId"]);
  return {
    ok: true,
    status: res.status,
    data: Array.isArray(hits) ? hits : [],
    raw: res.body,
  };
}

/**
 * The raw-https GET `search/person` insists on. Deliberately NOT the shared
 * `officeAgent`: this is one short-lived call per builder operation, and
 * borrowing the 4-socket pool the mirror's bulk reads live on would let a
 * backfill starve a rep's person lookup.
 */
function officeHttpsGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: OFFICE_HOST, path, headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer | string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("Office search timeout"));
    });
  });
}

/** `GET /person/download?id=` — the full record, for a round-trip PUT. */
export function downloadPerson(
  clientKey: string,
  sessionId: string,
  personId: string,
): Promise<OfficeWriteResult<Record<string, unknown>>> {
  return officeWrite<Record<string, unknown>>(
    clientKey,
    `person/download?id=${encodeURIComponent(personId)}`,
    { method: "GET", sessionId },
  );
}

/**
 * `PUT /person` — the record straight back, with the caller's patch on top.
 *
 * The body is the record Office just gave us, so it is serialised with
 * `serializeWithRawIds`: `downloadPerson` parsed its 17-digit ids INTO strings,
 * and handing those to `JSON.stringify` would put `"id":"63000000009561437"`
 * on a rail whose proven shape is a number. This is the inverse of the parse
 * and the only way to emit one at full precision.
 */
export function putPerson(
  clientKey: string,
  sessionId: string,
  person: Record<string, unknown>,
): Promise<OfficeWriteResult<Record<string, unknown>>> {
  return officeWrite<Record<string, unknown>>(clientKey, "person", {
    method: "PUT",
    body: serializeWithRawIds(person, OFFICE_ID_FIELDS),
    sessionId,
  });
}

export interface OfficePriceAnswer {
  price?: unknown;
  pricePerUnit?: unknown;
  totalPrice?: unknown;
}

/**
 * `POST /projectProduct/price?productId=&date=`.
 *
 * **Weekday and weekend pricing lives HERE**, which is why the builder calls it
 * per date and never caches a number across dates. The same `productId` on a
 * Friday and on a Tuesday is two different answers, and a price frozen into a
 * quote template is the "published price must match the catalogue" incident
 * waiting to happen.
 */
export function productPrice(
  clientKey: string,
  sessionId: string,
  input: { productId: string; date: string; quantity?: number; projectId?: string },
): Promise<OfficeWriteResult<OfficePriceAnswer>> {
  const qs = `productId=${encodeURIComponent(input.productId)}&date=${encodeURIComponent(input.date.slice(0, 10))}`;
  const body: Record<string, unknown> = { quantity: input.quantity ?? 1 };
  if (input.projectId) body.projectId = input.projectId;
  return officeWrite<OfficePriceAnswer>(clientKey, `projectProduct/price?${qs}`, {
    method: "POST",
    body: JSON.stringify(body),
    sessionId,
  });
}

export interface OfficeProjectProduct {
  id?: unknown;
  projectId?: unknown;
  productId?: unknown;
  quantity?: unknown;
  pricePerUnit?: unknown;
  totalPrice?: unknown;
  name?: unknown;
}

/** `POST /projectProduct` — create the line. */
export function createProjectProduct(
  clientKey: string,
  sessionId: string,
  input: ProjectProductInput,
): Promise<OfficeWriteResult<OfficeProjectProduct>> {
  return officeWrite<OfficeProjectProduct>(clientKey, "projectProduct", {
    method: "POST",
    body: projectProductBody(input),
    sessionId,
  });
}

/** `DELETE /projectProduct?id=` — remove one line. */
export function deleteProjectProduct(
  clientKey: string,
  sessionId: string,
  projectProductId: string,
): Promise<OfficeWriteResult<Record<string, unknown>>> {
  return officeWrite<Record<string, unknown>>(
    clientKey,
    `projectProduct?id=${encodeURIComponent(projectProductId)}`,
    { method: "DELETE", sessionId },
  );
}

export interface OfficeLinkScheduleAnswer {
  schedules?: Array<{ id?: unknown; resourceId?: unknown; start?: unknown; stop?: unknown }>;
}

/** `POST /projectProduct/linkSchedule` — the call that can refuse. */
export function linkSchedule(
  clientKey: string,
  sessionId: string,
  input: LinkScheduleInput,
): Promise<OfficeWriteResult<OfficeLinkScheduleAnswer>> {
  return officeWrite<OfficeLinkScheduleAnswer>(clientKey, "projectProduct/linkSchedule", {
    method: "POST",
    body: linkScheduleBody(input),
    sessionId,
  });
}

/** `PUT /projectSchedule/batch` — edit blocks already linked. */
export function putScheduleBatch(
  clientKey: string,
  sessionId: string,
  input: ScheduleBatchInput,
): Promise<OfficeWriteResult<OfficeLinkScheduleAnswer>> {
  return officeWrite<OfficeLinkScheduleAnswer>(clientKey, "projectSchedule/batch", {
    method: "PUT",
    body: scheduleBatchBody(input),
    sessionId,
  });
}

export interface OfficeBalanceAnswer {
  total?: unknown;
  paid?: unknown;
  balance?: unknown;
}

/** `GET /project/balance?id=` — the totals, read back after every write. */
export function projectBalance(
  clientKey: string,
  sessionId: string,
  projectId: string,
): Promise<OfficeWriteResult<OfficeBalanceAnswer>> {
  return officeWrite<OfficeBalanceAnswer>(
    clientKey,
    `project/balance?id=${encodeURIComponent(projectId)}`,
    { method: "GET", sessionId },
  );
}
