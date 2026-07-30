import { randomBytes } from "node:crypto";
import { sql, isDbConfigured } from "@/lib/db";
import redis from "@/lib/redis";
import { buildWaiverUrl } from "~/features/waiver/build-waiver-url";
import type { CenterCode } from "~/features/booking/types";

/**
 * Short, opaque waiver links — `{origin}/w/{code}` — where the CAPABILITY lives in
 * the code, not in a query param.
 *
 * Owner standard (2026-07-30): "We should use short URLs whenever possible." Guest
 * waiver links are sent by email and SMS, so they must be short, and there are two
 * different links for the same reservation:
 *
 *   admin    — the waiver page WITH the roster AND the ability to REMOVE people.
 *              WE send this, in the confirmation email/SMS, to the person who booked.
 *   register — sign only. This is what Share / Text / Email / Copy hands out.
 *
 * ── Why an opaque code and never `?admin=1` ────────────────────────────────────
 * The admin capability grants a MUTATION (remove a guest from someone else's
 * booking). A guessable flag would mean anyone holding a forwarded register link
 * could flip it and start deleting guests. The capability is therefore a property
 * of the code — an unguessable 96-bit random string that we look up server-side —
 * and there is deliberately no boolean parameter to reintroduce. Treat a code as a
 * BEARER TOKEN: never log it in full (see `maskCode`), never render it anywhere a
 * guest could screenshot it.
 *
 * ── The capability NEVER leaves Neon ──────────────────────────────────────────
 * `resolveWaiverLink` — the only function that reports a capability — reads the
 * STORED ROW, every time. It does not consult Redis, and Redis does not hold a
 * capability at all: the cached payload carries `{center, locationId, projectId}`
 * and nothing else. That is deliberate and it is the fix for a real hole. When the
 * cache was allowed to answer, two things were true at once:
 *
 *   1. A `wvlink:{code}` entry claiming `cap:"admin"` turned a REGISTER code into
 *      an admin code — `waiverLinkGrantsAdminFor` authorizes a guest-DELETE off
 *      this value, so the mutation's authority sat in a disposable key that Neon
 *      never saw and `hits`/`last_seen_at` never recorded.
 *   2. The grant could not be REVOKED. Correcting `capability` on the row did
 *      nothing for up to the 90-day TTL, because the row was never read again.
 *      (Repo lesson: revoke a status with the same reach you granted it.)
 *
 * So: cache the REDIRECT (which is capability-independent — an admin code and a
 * register code for one reservation resolve to the identical `/waiver?…` target),
 * never the capability. An authorization decision is worth one indexed primary-key
 * lookup. `lookupWaiverLinkTarget` is the cache-first path `/w/{code}` uses (it needs
 * the STATUS — see below); `resolveWaiverLinkTarget` is the same read for callers that
 * only want the target and treat every failure alike. Anything that reads
 * `.capability` goes to the row by construction.
 *
 * ── Neon is the truth; Redis is disposable — in that ORDER ────────────────────
 * The existing `/s/{code}` resolver is Redis-only with a 90-day TTL that refreshes
 * only when a link is actually clicked. Events run further out than that (a
 * 2026-12-18 event booked today is ~5 months away), and this Redis has an OOM /
 * eviction history — so a link sitting unclicked in an inbox can simply stop
 * existing, and `/s/`'s miss path dumps the guest on the brand homepage with no
 * explanation. A guest clicking their waiver link in November must not get nothing.
 * So the code -> {center, locationId, projectId, capability} mapping lives in Neon
 * with NO TTL, and Redis `wvlink:{code}` is a disposable read-through cache.
 *
 * Which makes the resolve order a hard contract, not a preference
 * (`lookupWaiverLinkTarget`):
 *
 *   Redis HIT   -> use it.
 *   Redis MISS  -> read NEON and rehydrate the cache. An eviction, a TTL expiry or
 *                  an OOM flush is not evidence ABOUT the link, so it may never end
 *                  a lookup.
 *   NEON MISS   -> and only a Neon miss -> the code is unknown. This is the one
 *                  definitive dead link.
 *   NEON ERROR  -> `unavailable` / `unreadable`: retryable, explicitly NOT "dead
 *                  link". Guest copy says try again; authorization still says no.
 *   ROW UNUSABLE-> `unavailable` / `unusable-row`: we DID read the truth and the row
 *                  cannot answer what was asked. NOT retryable, and NOT unknown —
 *                  the code exists. If the row still points at a reservation the
 *                  REDIRECT is served anyway; only the capability is withheld.
 *
 * `NO TABLE` (42P01) is `unreadable`, NOT a miss. Minting is the only thing that ever
 * creates this table, so a code sitting in an inbox is proof the table existed when it
 * was minted: a 42P01 on the READ path means we asked the wrong database (an unmigrated
 * Neon branch), or the table was dropped/renamed, or `search_path` moved — never that
 * the guest's code is absent. Answering "unknown" there told every outstanding link
 * holder their link was dead and CLEARED their grant cookie, from one catalog mistake.
 *
 * ── The guest read path runs NO DDL ───────────────────────────────────────────
 * The table is bootstrapped lazily but ONLY by minting — a write path, at send time,
 * whose failure already degrades safely to a long URL. Reads (`readStoredLink`,
 * `recordWaiverLinkHit`) never issue DDL: a November click must not be contingent on
 * a CREATE TABLE succeeding, and one broken DDL statement would otherwise kill every
 * outstanding link at once. The idempotency UNIQUE therefore lives IN the table
 * definition, so the first mint cannot insert before the constraint its ON CONFLICT
 * infers exists.
 *
 * ── Why NOT the `short:{code}` key-space, and why `/w` not `/s` ───────────────
 * `short:{code}` holds a BARE URL STRING by contract: `/s/[code]/page.tsx` redirects
 * to the value verbatim, and `app/api/admin/e-tickets/list/route.ts` reads it back
 * and regex-parses it (`/(t|g)/{id}`). There is nowhere in that shape to put a
 * capability, and putting JSON there would make `/s/` redirect a guest to a JSON
 * blob AND break that admin tool. So the capability lives in NEON keyed by code and
 * NOTHING here ever writes `short:`; `lib/short-url.ts`, `/api/s` and `/s/[code]`
 * are untouched.
 *
 * The URL namespace is separate for the same reason. `/s/` codes are 6 chars from a
 * different generator (`lib/short-url.ts`) — deliberately weak, because a shortlink
 * is not a capability. Resolving both through one route would (1) put a 96-bit
 * bearer token and a guessable 6-char public code in one keyspace, where a future
 * change to either generator lets one shadow the other, and (2) inherit `/s/`'s
 * Redis-only miss path, which dumps the guest on the brand homepage — the exact
 * failure this module exists to avoid. `/w/{code}` is its own route, Neon-backed,
 * registered in `middleware.ts` so it serves on BOTH brand hosts.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 * `(location_id, project_id, capability)` is UNIQUE **in the CREATE TABLE**, not in a
 * follow-up CREATE INDEX, and minting is an UPSERT that
 * RETURNs the existing code (the `lib/bmi-deposit-retry.ts` move). One reservation
 * has exactly ONE admin code and ONE register code, forever. A fresh code per email
 * send would fragment click history and, worse, would not appear in mail we already
 * delivered.
 *
 * Note this is stored-random, NOT HMAC-derived like `confirmationShortCode`. A
 * derived code is unguessable only while the secret is secret, and that secret's
 * fallback chain ends in a hardcoded literal — for a capability that can DELETE
 * guests, "computable from a projectId" is not an acceptable threat model.
 *
 * ── Degradation: two different failures, never conflated ──────────────────────
 * A send must NEVER die for a link. `mintWaiverLinkOrLongUrl` starts from the long
 * absolute `buildWaiverUrl` and only upgrades on a successful mint, so if Neon is
 * unreachable the booker gets a sign-only long link: they lose the remove button,
 * they never get a broken link, and no unauthenticated mutation surface is created.
 *
 * But "could not mint" and "minted something I cannot account for" are different
 * events and are reported differently (`WaiverLinkMintFailure`, `isDurabilityFailure`):
 *
 *   invalid-input / not-configured — nothing was written, nothing handed out. Warn;
 *       the send proceeds, and there is nothing to reconcile.
 *   not-persisted / unusable-row  — a WRITE was attempted and cannot be accounted
 *       for. console.error, because a row may exist in Neon that nobody holds a link
 *       to, and the booker silently lost the remove button on their own party.
 *
 * Either way the invariant holds: a code is emitted ONLY when it came back out of the
 * committed row via `RETURNING`, carries the capability that was asked for, and still
 * matches `WAIVER_LINK_CODE_RE` — i.e. only when `/w/{code}` can actually resolve
 * later. The locally generated candidate never escapes this module.
 *
 * BMI ids (projectId, locationId) are TEXT here and `string` in TS end to end.
 * Never Number() / parseInt / JSON.parse them — they exceed MAX_SAFE_INTEGER.
 */

/** `admin` = roster + remove. `register` = sign only. */
export type WaiverLinkCapability = "admin" | "register";

/**
 * Path prefix of the resolver route that turns a code back into a waiver page —
 * served by `app/w/[code]/route.ts`.
 *
 * MIDDLEWARE PAIRING (hard rule, CLAUDE.md): this is a NEW top-level path, so it
 * MUST also be registered in `isSharedTopLevelRoute` in `middleware.ts`. The
 * HeadPinz host rewrites every unregistered top-level path into `/hp/*`, and these
 * links go out in HeadPinz email and SMS — an unregistered `/w` means every
 * HeadPinz waiver link is a 404. Changing this constant without changing
 * `middleware.ts` fails the pin in `waiver-short-link.test.ts`.
 */
export const WAIVER_LINK_PATH = "/w";

/**
 * Cookie the `/w/{code}` resolver carries the ARRIVAL CODE forward in — the code the
 * guest clicked, not a decision about what it grants.
 *
 * Why a cookie and not `?k={code}` on the redirect: the code is a BEARER TOKEN. In
 * the query string it would sit in the address bar, in the browser history, in any
 * screenshot of the roster screen, and in the `Referer` of every outbound request
 * the waiver page makes — for a capability that can DELETE guests from someone
 * else's booking. HttpOnly also keeps it away from page scripts entirely.
 *
 * NEVER trust this cookie on its own, and never store a decision in it. Read it
 * through `waiverLinkGrantsAdminFor(cookie, projectId)` at the point of use, which
 * goes to the ROW and binds the code to the reservation of the page it is being used
 * on. Two consequences, both load-bearing:
 *   - a `register` code in this cookie grants NOTHING, so the resolver does not need
 *     to know (or cache) a capability to hand it over safely;
 *   - correcting `capability` on the row REVOKES the grant immediately — nothing
 *     durable ever holds a stale "yes".
 * A cookie left behind by another reservation, or by another guest on a shared
 * in-center device, therefore grants nothing either.
 */
export const WAIVER_LINK_COOKIE = "wv_cap";

/**
 * 12h — one visit plus interruptions, not a standing grant. The DURABLE capability
 * is the link in the booker's inbox: re-clicking it re-grants instantly, so a short
 * cookie costs the guest nothing while bounding how long a shared device keeps the
 * remove button. Every arrival at `/w/{code}` OVERWRITES this cookie and an
 * unresolvable code CLEARS it, so the last link opened on a device is the only one
 * in play — revoke with the same reach you granted.
 */
export const WAIVER_LINK_COOKIE_MAX_AGE = 60 * 60 * 12;

/**
 * Shape gate for an inbound code. The MINIMUM length is a security property (16
 * base64url chars = 96 bits); widen the maximum if the generator ever changes, but
 * never lower the floor.
 */
export const WAIVER_LINK_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Redis cache namespace. Deliberately NOT `short:` — see the header. */
const CACHE_PREFIX = "wvlink:";
/** Cache only. The Neon row has no expiry; this key may vanish at any time. */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 90;
/**
 * A cache is not allowed to be slower than the truth. ioredis queues commands
 * while a server is unreachable, so an unbounded `get` against a dead Redis would
 * stall a guest's redirect instead of falling through to Neon.
 */
const CACHE_TIMEOUT_MS = 200;
/** Ceiling on the post-resolution hit write. Larger than the cache timeout (a Neon round
 *  trip is slower than Redis) but far below any function budget, so a lock-queued or
 *  stalled UPDATE can never turn a valid link into a 5xx. */
const HIT_WRITE_TIMEOUT_MS = 400;
/**
 * Bump when the cached JSON shape changes; unknown versions read as a miss.
 *
 * v1 -> v2 REMOVED the `cap` field. v1 payloads are still in Redis for up to 90
 * days, and they must never be reinterpreted — the bump is what guarantees an old
 * `{v:1, cap:"admin", …}` blob is discarded rather than half-read.
 */
const CACHE_VERSION = 2;

/**
 * Runtime whitelist for `center`, typed as a total map so ADDING a CenterCode is a
 * tsc error here rather than a silently dropped center. A garbage center string
 * would file a Naples guest's waiver at Fort Myers, where it is not valid.
 */
const KNOWN_CENTERS: Record<CenterCode, true> = { "fort-myers": true, naples: true };

export interface WaiverLinkReservation {
  /** Pandora locationID. Kept as a string; never Number()'d. */
  locationId: string | number;
  /** BMI projectId — 17 digits, string ONLY. */
  projectId: string;
}

export interface MintWaiverLinkParams {
  center?: CenterCode | null;
  /** Required: a capability code with no reservation grants nothing (or, worse,
   *  looks like it grants everything). */
  reservation: WaiverLinkReservation;
  capability: WaiverLinkCapability;
  /** Brand origin for the returned absolute URL — "https://headpinz.com" for a
   *  HeadPinz send, "https://fasttraxent.com" for FastTrax. Defaults to
   *  NEXT_PUBLIC_SITE_URL, same chain as buildWaiverUrl. */
  origin?: string;
}

/**
 * WHERE a code goes — and nothing about what it grants. `target` is always freshly
 * built by buildWaiverUrl.
 *
 * This is the cacheable half, and it is capability-free on purpose: an `admin` code
 * and a `register` code for the same reservation resolve to the IDENTICAL target, so
 * a redirect can be served from Redis without any authorization value passing
 * through it. Anything that needs to know what a code grants must use
 * `ResolvedWaiverLink`, which only ever comes from the stored row.
 */
export interface ResolvedWaiverLinkTarget {
  code: string;
  center: CenterCode | null;
  reservation: { locationId: string; projectId: string };
  /** RELATIVE waiver path, so the guest stays on whichever brand host they opened. */
  target: string;
}

/** A target PLUS the capability — only ever built from the Neon row. */
export interface ResolvedWaiverLink extends ResolvedWaiverLinkTarget {
  capability: WaiverLinkCapability;
}

export interface WaiverLink extends ResolvedWaiverLink {
  /** Absolute short URL — this is what goes in the email/SMS. */
  url: string;
}

/** `/w/{code}` — the path `app/w/[code]/route.ts` serves on both brand hosts. */
export function waiverShortPath(code: string): string {
  return `${WAIVER_LINK_PATH}/${code}`;
}

/** Log-safe rendering of a bearer token. Enough to correlate, not enough to use. */
export function maskCode(code: string): string {
  return `${(code || "").slice(0, 4)}…`;
}

/** 96 bits from node:crypto — never Math.random for a capability token. */
function newCode(): string {
  return randomBytes(12).toString("base64url"); // 16 url-safe chars, no padding
}

/** Mirrors buildWaiverUrl's origin normalization so `/w/` can never double-slash. */
function resolveOrigin(origin?: string): string {
  return (origin || process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com")
    .trim()
    .replace(/\/+$/, "");
}

function normalizeCenter(center: unknown): CenterCode | null {
  const c = typeof center === "string" ? center.trim() : "";
  return c && Object.prototype.hasOwnProperty.call(KNOWN_CENTERS, c) ? (c as CenterCode) : null;
}

/**
 * Both ids or neither — the same rule buildWaiverUrl enforces. A half-set pair
 * would store a row that claims to be reservation-scoped while its target attaches
 * to nothing, which for an `admin` code means a bearer token pointing at a
 * standalone page.
 */
function normalizeReservation(
  res: WaiverLinkReservation | null | undefined,
): { locationId: string; projectId: string } | null {
  const locationId = String(res?.locationId ?? "").trim();
  const projectId = String(res?.projectId ?? "").trim();
  if (!locationId || !projectId) return null;
  // buildWaiverUrl drops a numeric 0 as falsy; stay consistent with it.
  if (/^0+$/.test(locationId) || /^0+$/.test(projectId)) return null;
  return { locationId, projectId };
}

function isCapability(v: unknown): v is WaiverLinkCapability {
  return v === "admin" || v === "register";
}

// ── Postgres error classification ───────────────────────────────────────────

/** SQLSTATE off a NeonDbError, when the driver gave us one. */
function pgCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/**
 * `CREATE … IF NOT EXISTS` is check-then-create, not atomic, so two lambdas
 * bootstrapping in the same instant collide in the catalog: 42P07 duplicate_table,
 * 42710 duplicate_object, or a unique violation on a `pg_*` catalog index. The
 * object exists either way, which is all the caller needed — losing that race must
 * not cost a booker their admin link. A unique violation on one of OUR indexes is
 * NOT benign (it means genuinely duplicated rows) and is deliberately unmatched.
 */
function isBenignDdlError(err: unknown): boolean {
  const code = pgCode(err);
  if (code === "42P07" || code === "42710") return true;
  const msg = errMessage(err);
  return /already exists/i.test(msg) || /violates unique constraint "pg_/i.test(msg);
}

/** 42P01 — the table is not there at all. */
function isMissingTableError(err: unknown): boolean {
  return pgCode(err) === "42P01" || /relation .*does not exist/i.test(errMessage(err));
}

/**
 * "The schema was not ready when I wrote": no table (42P01), or no unique index for
 * the ON CONFLICT target (42P10). Only these justify re-running the bootstrap and
 * retrying a mint — a connection failure must not turn into two failed writes.
 */
function isMissingSchemaError(err: unknown): boolean {
  if (isMissingTableError(err)) return true;
  return pgCode(err) === "42P10" || /no unique or exclusion constraint/i.test(errMessage(err));
}

// ── Schema bootstrap (WRITE path only) ──────────────────────────────────────

/**
 * In-process bootstrap latch — a PROMISE, not a boolean. With a boolean, two
 * concurrent mints in one lambda both see "not ready" and both issue DDL, which is
 * exactly the catalog race above; with a promise they await the same bootstrap.
 * Cleared on failure so one transient DDL error cannot poison minting for the life
 * of the instance.
 */
let schemaPromise: Promise<void> | null = null;

/** DDL is idempotent by construction; only a REAL failure may escape. */
async function ddl(statement: Promise<unknown>): Promise<void> {
  try {
    await statement;
  } catch (err) {
    if (isBenignDdlError(err)) return;
    throw err;
  }
}

async function bootstrapSchema(): Promise<void> {
  const q = sql();
  // The idempotency key is part of the TABLE. `ON CONFLICT (location_id, project_id,
  // capability)` needs a matching unique index to infer, and creating that index in
  // a *following* statement leaves a window where the very first mint has a table to
  // insert into and no constraint to conflict on (42P10) — two codes for one
  // reservation, one of them already in delivered mail.
  await ddl(q`
    CREATE TABLE IF NOT EXISTS waiver_link_codes (
      code           TEXT PRIMARY KEY,
      capability     TEXT NOT NULL,
      center         TEXT,
      location_id    TEXT NOT NULL,
      project_id     TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_minted_at TIMESTAMPTZ,
      last_seen_at   TIMESTAMPTZ,
      hits           INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT waiver_link_codes_idem UNIQUE (location_id, project_id, capability)
    )
  `);
  // Backfill for a table created before the constraint moved inline. Named
  // identically to the constraint's own index, so on a table created above this is
  // an IF-NOT-EXISTS skip rather than a second index over the same columns.
  await ddl(q`
    CREATE UNIQUE INDEX IF NOT EXISTS waiver_link_codes_idem
    ON waiver_link_codes (location_id, project_id, capability)
  `);
  // "Which links exist for this reservation" — the unique key above leads with
  // location_id so it cannot serve a project-only lookup.
  await ddl(q`
    CREATE INDEX IF NOT EXISTS waiver_link_codes_project
    ON waiver_link_codes (project_id)
  `);
}

function ensureSchema(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve();
  if (!schemaPromise) {
    schemaPromise = bootstrapSchema().catch((err: unknown) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** Test seam (the `lib/marketing-db.ts` idiom) — forget that DDL already ran. */
export function _resetWaiverLinkSchemaCache(): void {
  schemaPromise = null;
}

interface LinkRow {
  code: unknown;
  capability: unknown;
  center: unknown;
  location_id: unknown;
  project_id: unknown;
}

/**
 * The target is DERIVED, never stored. buildWaiverUrl owns the URL contract
 * (constraint: never hand-roll a waiver URL), and a stored path would freeze
 * today's shape into every outstanding link — so a later fix to buildWaiverUrl
 * would not reach the codes already sitting in guests' inboxes.
 *
 * The code is gated on the SAME `WAIVER_LINK_CODE_RE` every inbound code is gated
 * on. A row (or cache entry) whose code could not survive that gate could never be
 * resolved, so it must never become a link either — minting one would put a
 * permanently dead `/w/{code}` in an inbox that nobody can even report as broken.
 */
function rowToTarget(row: Omit<LinkRow, "capability">): ResolvedWaiverLinkTarget | null {
  const code = String(row.code ?? "");
  if (!WAIVER_LINK_CODE_RE.test(code)) return null;
  const reservation = normalizeReservation({
    locationId: String(row.location_id ?? ""),
    projectId: String(row.project_id ?? ""),
  });
  if (!reservation) return null;
  const center = normalizeCenter(row.center);
  return { code, center, reservation, target: buildWaiverUrl({ center, reservation }) };
}

/**
 * The ONLY place a capability is produced, and both inputs come from a database row.
 * There is no overload, no default and no `capability?` — an unrecognised value yields
 * null (no link, therefore no capability) rather than falling back to anything.
 *
 * It takes the already-built TARGET rather than re-deriving one, so the capability-free
 * object stays a separate value: the spread below builds a NEW object, and the target
 * handed to `lookupWaiverLinkTarget` / `cacheWrite` never grows a `capability` field at
 * runtime even for a row that has a perfectly good one.
 */
function rowToResolved(
  target: ResolvedWaiverLinkTarget | null,
  capabilityColumn: unknown,
): ResolvedWaiverLink | null {
  const capability = String(capabilityColumn ?? "");
  if (!target || !isCapability(capability)) return null;
  return { ...target, capability };
}

/** A cache must never be able to fail or stall its caller. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the cached REDIRECT for a code. Returns a target only — there is no branch in
 * this function that can produce a capability, because there is no capability in the
 * payload to produce one from. A poisoned, stale or hand-written `wvlink:` key can
 * therefore send a guest to the wrong waiver page (bounded by `normalizeReservation`
 * + `normalizeCenter`, and visible to the guest in their own address bar) but it can
 * never grant the remove button.
 */
async function cacheRead(code: string): Promise<ResolvedWaiverLinkTarget | null> {
  const raw = await withTimeout(
    Promise.resolve().then(() => redis.get(`${CACHE_PREFIX}${code}`)),
    CACHE_TIMEOUT_MS,
  );
  if (!raw) return null;
  try {
    // Our own JSON, not an upstream payload — but still only ids-as-strings inside.
    const parsed = JSON.parse(raw) as {
      v?: number;
      c?: string | null;
      loc?: string;
      pid?: string;
    };
    // v1 payloads carried `cap`. Rejecting them here is what stops an entry written
    // by the previous shape from being re-read after this deploy.
    if (parsed.v !== CACHE_VERSION) return null;
    return rowToTarget({
      code,
      center: parsed.c ?? null,
      location_id: parsed.loc,
      project_id: parsed.pid,
    });
  } catch {
    return null;
  }
}

/**
 * Write-through: also repairs a cached entry whose center was filled in later.
 *
 * Takes a TARGET, not a link, so a capability cannot be written here even by
 * accident — `link.capability` is not in scope.
 */
async function cacheWrite(link: ResolvedWaiverLinkTarget): Promise<void> {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    c: link.center,
    loc: link.reservation.locationId,
    pid: link.reservation.projectId,
  });
  await withTimeout(
    Promise.resolve().then(() =>
      redis.set(`${CACHE_PREFIX}${link.code}`, payload, "EX", CACHE_TTL_SECONDS),
    ),
    CACHE_TIMEOUT_MS,
  );
}

// ── Minting ─────────────────────────────────────────────────────────────────

/**
 * Why minting failed, and — crucially — whether anything was WRITTEN. These are two
 * very different degradations and they are not logged the same way:
 *
 *   invalid-input   caller bug (bad capability, half-set reservation). Nothing was
 *                   attempted, nothing to reconcile.
 *   not-configured  no DATABASE_URL. Durability is impossible here by definition.
 *   ── everything below means a write was attempted ──
 *   not-persisted   we tried to write and cannot prove a durable row exists.
 *   unusable-row    a row came back that must not be handed out (a code `/w/` could
 *                   never resolve, or a capability we did not ask for).
 *
 * The first two are an expected degradation: the send proceeds with the long
 * sign-only URL. The last two mean Neon may disagree with what we sent, so they are
 * loud — see `isDurabilityFailure`.
 */
export type WaiverLinkMintFailure =
  | "invalid-input"
  | "not-configured"
  | "not-persisted"
  | "unusable-row";

export class WaiverLinkMintError extends Error {
  readonly failure: WaiverLinkMintFailure;

  constructor(failure: WaiverLinkMintFailure, message: string) {
    super(`[waiver-short-link] ${message}`);
    this.name = "WaiverLinkMintError";
    this.failure = failure;
  }
}

/** True when a mint failure means a write was attempted and is unaccounted for. */
export function isDurabilityFailure(failure: WaiverLinkMintFailure | null): boolean {
  return failure === "not-persisted" || failure === "unusable-row";
}

function notPersisted(err: unknown): WaiverLinkMintError {
  return new WaiverLinkMintError(
    "not-persisted",
    `could not durably store a waiver code — refusing to hand out one that may never resolve: ${errMessage(err)}`,
  );
}

async function upsertLinkRow(
  capability: WaiverLinkCapability,
  center: CenterCode | null,
  ref: { locationId: string; projectId: string },
): Promise<LinkRow[]> {
  const q = sql();
  // DO UPDATE (not DO NOTHING) so the conflicting row is RETURNed in one round trip
  // — DO NOTHING yields zero rows on conflict and would need a second SELECT.
  // COALESCE on center repairs a row minted before the center was known without
  // ever letting a later caller blank one that is already right.
  return (await q`
    INSERT INTO waiver_link_codes (code, capability, center, location_id, project_id, last_minted_at)
    VALUES (${newCode()}, ${capability}, ${center}, ${ref.locationId}, ${ref.projectId}, NOW())
    ON CONFLICT (location_id, project_id, capability)
    DO UPDATE SET
      center = COALESCE(EXCLUDED.center, waiver_link_codes.center),
      last_minted_at = NOW()
    RETURNING code, capability, center, location_id, project_id
  `) as LinkRow[];
}

/**
 * Bootstrap-then-write, with ONE retry reserved for "the schema was not ready".
 * That retry is what makes the first mint safe against its own DDL: an instance that
 * latched a bootstrap from an older deploy, or a table that predates the inline
 * UNIQUE, re-bootstraps and writes again instead of minting a SECOND code for a
 * reservation that already has one.
 */
async function persistLinkRow(
  capability: WaiverLinkCapability,
  center: CenterCode | null,
  ref: { locationId: string; projectId: string },
): Promise<LinkRow[]> {
  try {
    await ensureSchema();
    return await upsertLinkRow(capability, center, ref);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw notPersisted(err);
    schemaPromise = null;
    try {
      await ensureSchema();
      return await upsertLinkRow(capability, center, ref);
    } catch (retryErr) {
      throw notPersisted(retryErr);
    }
  }
}

/**
 * Mint (or re-mint) the ONE code for this (reservation, capability) and return the
 * short URL. Calling it twice returns the identical code and URL.
 *
 * THROWS `WaiverLinkMintError` when it cannot produce a code it has PROVEN is both
 * durable and resolvable, so the caller can consciously fall back — use
 * `mintWaiverLinkOrLongUrl` in a send path, where a throw would cost the guest
 * their email.
 */
export async function mintWaiverLink(params: MintWaiverLinkParams): Promise<WaiverLink> {
  if (!isCapability(params.capability)) {
    throw new WaiverLinkMintError(
      "invalid-input",
      `unknown capability: ${String(params.capability)}`,
    );
  }
  const ref = normalizeReservation(params.reservation);
  if (!ref) {
    throw new WaiverLinkMintError(
      "invalid-input",
      "refusing to mint: locationId AND projectId are both required",
    );
  }
  if (!isDbConfigured()) {
    throw new WaiverLinkMintError(
      "not-configured",
      "DATABASE_URL not configured — cannot mint a durable code",
    );
  }
  const center = normalizeCenter(params.center);
  const rows = await persistLinkRow(params.capability, center, ref);
  // `RETURNING` is the PROOF of persistence: the code we hand out is read back out of
  // the committed row, never the candidate we generated. No row — or a row `/w/`
  // could not resolve — means no link, because a code that cannot resolve is a dead
  // link in an inbox that nobody can even report as broken.
  const row = rows[0];
  const link = row ? rowToResolved(rowToTarget(row), row.capability) : null;
  if (!link) {
    throw row
      ? new WaiverLinkMintError(
          "unusable-row",
          `stored row cannot resolve (code=${maskCode(String(row.code ?? ""))} capability=${String(row.capability ?? "")}) — refusing to send it`,
        )
      : new WaiverLinkMintError(
          "not-persisted",
          "upsert returned no row — the write cannot be confirmed",
        );
  }
  // The row we get back MUST carry the capability we asked for. It does today —
  // `capability` is part of the ON CONFLICT key, so the conflicting row is by
  // definition the same capability. This asserts that rather than assuming it: if the
  // unique index is ever narrowed to (location_id, project_id), the UPSERT would
  // start RETURNing the reservation's OTHER row, and a caller asking for `register`
  // would be handed the ADMIN code — the exact escalation this module exists to
  // prevent, delivered by email. Fail the mint instead; the send degrades to a long
  // sign-only URL.
  if (link.capability !== params.capability) {
    throw new WaiverLinkMintError(
      "unusable-row",
      `upsert returned capability=${link.capability} for a ${params.capability} request — refusing to hand out a capability that was not asked for`,
    );
  }
  // Best-effort, and it can neither throw nor stall: Neon already has the truth.
  await cacheWrite(link);
  return { ...link, url: `${resolveOrigin(params.origin)}${waiverShortPath(link.code)}` };
}

export interface WaiverLinkForSend {
  /** Always usable. Short `/w/{code}` when `short`, otherwise the long waiver URL. */
  url: string;
  /** null means minting failed — the URL carries NO capability. */
  code: string | null;
  /**
   * What the minted code ACTUALLY grants, straight off the stored row — not what was
   * requested. null when minting failed, i.e. the URL grants nothing.
   *
   * The send path is where the two links diverge: one goes to the booker, the other
   * is handed to strangers. A sender that puts the wrong one behind "Share" hands the
   * remove button to every guest, and until this field existed the two results were
   * indistinguishable at the call site. Assert on it before rendering a forwardable
   * link.
   */
  capability: WaiverLinkCapability | null;
  /** false = degraded: an `admin` send became sign-only. Adjust copy accordingly. */
  short: boolean;
  /** Relative waiver path the guest ends up on either way. */
  target: string;
  /**
   * null on success. Otherwise WHY there is no short link — and `isDurabilityFailure`
   * separates "nothing was written" (fine, the send proceeds with the long URL) from
   * "a write happened that we cannot account for" (not fine). Anything that alerts
   * should alert on the second kind only.
   */
  failure: WaiverLinkMintFailure | null;
}

/**
 * Send-path wrapper. NEVER throws: the long absolute waiver URL is the default and
 * a successful mint only upgrades it (the `/api/notifications/level-up` idiom).
 *
 * The degraded form of an `admin` link is a sign-only link — losing the remove
 * button is a much smaller failure than a dead link in an inbox, and it is strictly
 * safer than any capability we could encode without a durable record of it. Either
 * way, `code` is non-null only when Neon proved the code is stored: no `/w/` URL is
 * ever built here.
 */
export async function mintWaiverLinkOrLongUrl(
  params: MintWaiverLinkParams,
): Promise<WaiverLinkForSend> {
  try {
    const link = await mintWaiverLink({ ...params, origin: resolveOrigin(params.origin) });
    return {
      url: link.url,
      code: link.code,
      // From the row via mintWaiverLink, NOT `params.capability`.
      capability: link.capability,
      short: true,
      target: link.target,
      failure: null,
    };
  } catch (err) {
    // An unknown throw is treated as the WORSE case on purpose: if we cannot tell
    // whether a write happened, assume it did and say so loudly.
    const failure: WaiverLinkMintFailure =
      err instanceof WaiverLinkMintError ? err.failure : "not-persisted";
    const center = normalizeCenter(params.center);
    const ref = normalizeReservation(params.reservation);
    const origin = resolveOrigin(params.origin);
    const where = `capability=${String(params.capability)} project=${ref?.projectId ?? "none"}`;
    if (isDurabilityFailure(failure)) {
      // A write was attempted and could not be accounted for. Loud on purpose: a row
      // may exist in Neon that nobody was ever handed a link to, and the booker
      // silently lost the remove button on their own party.
      console.error(
        `[waiver-short-link] MINT NOT DURABLE (${failure}, ${where}) — sending the long URL; a code may exist that was never handed out:`,
        errMessage(err),
      );
    } else {
      // Nothing was written and nothing was handed out — an expected degradation.
      console.warn(
        `[waiver-short-link] no short link (${failure}, ${where}) — sending the long URL:`,
        errMessage(err),
      );
    }
    return {
      url: buildWaiverUrl({ center, reservation: ref }, { absolute: true, origin }),
      code: null,
      capability: null,
      short: false,
      target: buildWaiverUrl({ center, reservation: ref }),
      failure,
    };
  }
}

// ── Resolving ───────────────────────────────────────────────────────────────

/**
 * `unknown` is a VERDICT — Neon says there is no such code (or the code cannot be
 * one of ours by shape). `unavailable` is the ABSENCE of the answer we needed: the
 * link may be perfectly valid, so the guest must never be told it is dead. A Redis
 * miss produces NEITHER — it only sends us to Neon.
 *
 * The distinction exists because the two need different handling, and `/w/{code}`
 * implements exactly that: it EXPLAINS (503 + Retry-After) rather than redirecting when
 * a read failed, leaving the grant cookie untouched, and only redirects to a standalone
 * waiver once it has an authoritative answer. Collapsing the two there would silently
 * (a) have a guest sign a waiver attached to nothing and (b) let a dropped connection
 * revoke a capability nobody revoked. AUTHORIZATION, by contrast, treats every non-found
 * status as no — see `waiverLinkGrantsAdminFor`.
 */
export type WaiverLinkLookupStatus = "found" | "unknown" | "unavailable";

/**
 * WHY there is no verdict — required on every `unavailable`, so it is impossible to
 * produce one without saying which kind it is. The two are not interchangeable:
 *
 *   unreadable    we never got an answer: no DATABASE_URL, the query threw, the table
 *                 is not in the database we asked. RETRYABLE, and the row may well
 *                 exist — this is the status that must never reach a guest as "dead
 *                 link" and must never clear a grant.
 *   unusable-row  we DID read the truth and the ROW cannot answer: an unrecognised
 *                 `capability`, or ids/code that could never resolve. The code EXISTS,
 *                 so it is not `unknown`; the state is permanent, so retrying is a lie.
 *                 A row that still points at a reservation keeps its REDIRECT (see
 *                 `lookupWaiverLinkTarget`) — only the capability is withheld.
 */
export type WaiverLinkUnavailableReason = "unreadable" | "unusable-row";

export type WaiverLinkLookup =
  | { status: "found"; link: ResolvedWaiverLink; reason: null }
  | { status: "unknown"; link: null; reason: null }
  | { status: "unavailable"; link: null; reason: WaiverLinkUnavailableReason };

export type WaiverLinkTargetLookup =
  | { status: "found"; link: ResolvedWaiverLinkTarget; reason: null }
  | { status: "unknown"; link: null; reason: null }
  | { status: "unavailable"; link: null; reason: WaiverLinkUnavailableReason };

/**
 * The ONE condition worth a second attempt: we never got an answer. Every other
 * status/reason pair is an answer, and asking again cannot change it — `unknown` is a
 * verdict, and `unusable-row` is a corrupt row that will still be corrupt in 200ms.
 * Callers retry through this, so "retryable" has a single definition.
 */
export function isRetryableLookup(lookup: {
  status: WaiverLinkLookupStatus;
  reason: WaiverLinkUnavailableReason | null;
}): boolean {
  return lookup.status === "unavailable" && lookup.reason === "unreadable";
}

/**
 * What ONE Neon read produced. Both halves come out of the same round trip so the two
 * consumers never disagree about a row, and the target is a SEPARATE object from the
 * capability-bearing link (see `rowToResolved`).
 *
 *   found                -> both present.
 *   unknown              -> neither: the store authoritatively has no such code.
 *   unavailable/unreadable   -> neither: we never got an answer.
 *   unavailable/unusable-row -> `target` when the row still points at a reservation,
 *                               null when not even that survived.
 */
type StoredLinkRead =
  | { status: "found"; reason: null; link: ResolvedWaiverLink; target: ResolvedWaiverLinkTarget }
  | { status: "unknown"; reason: null; link: null; target: null }
  | {
      status: "unavailable";
      reason: WaiverLinkUnavailableReason;
      link: null;
      target: ResolvedWaiverLinkTarget | null;
    };

/**
 * Read the STORED ROW for a code. The single Neon read behind every capability in
 * this module — there is no other way to obtain one — and the only place that may
 * declare a code unknown.
 *
 * Runs NO DDL, deliberately. `ensureSchema` belongs to minting, a write path whose
 * failure already degrades safely to a long URL. On a guest READ it would mean a
 * November click depends on a CREATE TABLE succeeding, and a single failing DDL
 * statement (a role that lost CREATE, a lock, a catalog race) would kill every
 * outstanding link at once — the opposite of durable.
 */
async function readStoredLink(code: string): Promise<StoredLinkRead> {
  // Not our generator's shape, so it was never one of our codes. A verdict, and it
  // costs the database nothing.
  if (!code || !WAIVER_LINK_CODE_RE.test(code)) {
    return { status: "unknown", reason: null, link: null, target: null };
  }
  if (!isDbConfigured()) {
    console.error(
      "[waiver-short-link] DATABASE_URL not configured — cannot read the truth; refusing to call the link dead",
    );
    return { status: "unavailable", reason: "unreadable", link: null, target: null };
  }
  let rows: LinkRow[];
  try {
    const q = sql();
    rows = (await q`
      SELECT code, capability, center, location_id, project_id
      FROM waiver_link_codes
      WHERE code = ${code}
    `) as LinkRow[];
  } catch (err) {
    if (isMissingTableError(err)) {
      // NOT a miss. Only minting creates this table, so a code in a guest's inbox is
      // proof it existed when that code was minted: 42P01 here means we are reading the
      // wrong database (an unmigrated Neon branch), or it was dropped/renamed, or
      // search_path moved. Calling that "unknown" told every outstanding link holder
      // their link was dead — and cleared their grant — off one catalog mistake. It is
      // still not a guest's job to CREATE it; the next mint bootstraps it.
      console.error(
        `[waiver-short-link] waiver_link_codes is NOT IN THIS DATABASE — every outstanding link is UNREADABLE, not dead (${maskCode(code)}):`,
        errMessage(err),
      );
      return { status: "unavailable", reason: "unreadable", link: null, target: null };
    }
    console.error(
      `[waiver-short-link] resolve UNREADABLE for ${maskCode(code)} (retryable — NOT an unknown code):`,
      errMessage(err),
    );
    return { status: "unavailable", reason: "unreadable", link: null, target: null };
  }
  const row = rows[0];
  // The one and only definitive dead link: we asked the truth and it has no such code.
  if (!row) return { status: "unknown", reason: null, link: null, target: null };

  // From here on the code EXISTS. Nothing below may report `unknown`, and nothing below
  // is retryable — the row will read the same way on a second attempt.
  const target = rowToTarget(row);
  if (!target) {
    // A stored row that points at no reservation (blanked ids, a code that could not
    // survive the inbound shape gate). Permanent, so `unreadable` would be a lie, and
    // it is not the guest's dead link either — it is a data-integrity fault in OUR row.
    console.error(
      `[waiver-short-link] stored row for ${maskCode(code)} points at NO RESERVATION (code shape / ids) — nothing to resolve, and retrying will not help`,
    );
    return { status: "unavailable", reason: "unusable-row", link: null, target: null };
  }
  // Rehydrate the redirect cache off the row we just read, so the next click is a cache
  // hit again. Capability-free by type, and done BEFORE the capability is even looked at:
  // where to send the guest does not depend on what the code grants.
  await cacheWrite(target);

  const link = rowToResolved(target, row.capability);
  if (!link) {
    // The ids and the code are good; only `capability` is not one of ours (ops typo, a
    // hand-inserted row, a migration writing a different vocabulary). The REDIRECT is
    // valid and travels on — the guest signs on their OWN reservation's page — while the
    // capability is withheld, because a capability is only ever a recognised row value.
    // Reporting this as unreadable used to leave the booker on a permanent 503 that
    // claimed their link was still good and asked them to retry forever.
    console.error(
      `[waiver-short-link] stored row for ${maskCode(code)} has an UNRECOGNISED capability — granting nothing; the redirect is still valid and NOT retryable`,
    );
    return { status: "unavailable", reason: "unusable-row", link: null, target };
  }
  return { status: "found", reason: null, link, target };
}

/**
 * Resolve a code to its capability AND reservation. Reads the STORED ROW every time —
 * Redis is never consulted here, because Redis is not the truth and an authorization
 * value read from a disposable, TTL'd, externally-writable key is not an
 * authorization value. One indexed primary-key lookup is the correct price for
 * deciding whether someone may delete a guest from a stranger's booking.
 *
 * Use `resolveWaiverLinkTarget` when all you need is where to send the guest, and
 * `lookupWaiverLink` when "unknown" and "could not read" need different handling.
 *
 * NULL HERE IS AMBIGUOUS, deliberately and unavoidably: it means "no capability", which
 * covers a code that does not exist, a Neon outage, and a corrupt row alike. NEVER
 * render "invalid link" or clear a grant off it — that is how an outage becomes a dead
 * link in a guest's hands. Anything guest-facing uses `lookupWaiverLink` and branches on
 * the status; this form is for callers that only ask "may this code do the thing?", where
 * every failure is correctly the same answer: no.
 */
export async function resolveWaiverLink(code: string): Promise<ResolvedWaiverLink | null> {
  return (await readStoredLink(code)).link;
}

/**
 * Status-bearing form of `resolveWaiverLink` — the form to use for anything a guest
 * sees. `found` carries the capability; `unknown` is a verdict; `unavailable` says why
 * there is none, and only `isRetryableLookup` is worth asking twice.
 */
export async function lookupWaiverLink(code: string): Promise<WaiverLinkLookup> {
  const read = await readStoredLink(code);
  switch (read.status) {
    case "found":
      return { status: "found", link: read.link, reason: null };
    case "unknown":
      return { status: "unknown", link: null, reason: null };
    default:
      // A readable row with an unusable capability lands here too: the code EXISTS, so
      // it is never `unknown`, and there is no capability to report, so it is never
      // `found`. `reason` is what keeps the two apart for the caller.
      return { status: "unavailable", link: null, reason: read.reason };
  }
}

/**
 * Resolve a code to its REDIRECT only, in this ORDER: Redis HIT -> use it; Redis MISS
 * -> read NEON and rehydrate; only a NEON MISS means unknown. A cache miss is not
 * evidence about the link — this Redis has a 90-day TTL and an OOM/eviction history,
 * while the row it caches never expires, so an eviction five months before the event
 * may not end the lookup.
 *
 * This is what `/w/{code}` needs, and it deliberately cannot report a capability:
 * the returned shape has no such field, so a redirect can be served from a warm cache
 * without any authorization value being read from it. The capability is decided later,
 * at the point of use, by `waiverLinkGrantsAdminFor` against the row.
 *
 * Which is exactly why a row whose CAPABILITY column is unusable is still `found` here:
 * this lookup was never asking about the capability. The ids and the code passed the same
 * gates a mint enforces, so the redirect is correct and the guest signs on their own
 * reservation's page; the unrecognised capability grants nothing, because a capability is
 * only ever a recognised row value. Failing the redirect for it put a valid link behind a
 * permanent "your link is still good, try again" 503.
 */
export async function lookupWaiverLinkTarget(code: string): Promise<WaiverLinkTargetLookup> {
  if (!code || !WAIVER_LINK_CODE_RE.test(code)) {
    return { status: "unknown", link: null, reason: null };
  }
  const cached = await cacheRead(code);
  if (cached) return { status: "found", link: cached, reason: null };
  const stored = await readStoredLink(code);
  // `target` is present for `found` AND for a read row whose only fault is its
  // capability — a redirect we HAVE is never withheld for an answer we did not need.
  if (stored.target) return { status: "found", link: stored.target, reason: null };
  if (stored.status === "unknown") return { status: "unknown", link: null, reason: null };
  return { status: "unavailable", link: null, reason: stored.reason ?? "unreadable" };
}

/**
 * Convenience form of `lookupWaiverLinkTarget` for callers that only need the target.
 *
 * NULL HERE IS AMBIGUOUS — "no target" covers an unknown code, an unreachable Neon and a
 * corrupt row alike. Never treat it as a dead link in front of a guest: use
 * `lookupWaiverLinkTarget` and branch on the status (that is what `/w/{code}` does).
 */
export async function resolveWaiverLinkTarget(
  code: string,
): Promise<ResolvedWaiverLinkTarget | null> {
  return (await lookupWaiverLinkTarget(code)).link;
}

/**
 * THE authorization check for the admin capability. Two independent conditions, both
 * read from the same stored row:
 *
 *   1. the row's capability is `admin` — never a cached value, never a parameter,
 *      never a default;
 *   2. the row's projectId is the one being acted on, compared as STRINGS (a 17-digit
 *      BMI id through Number() is a silent off-by-one), so a code minted for one
 *      booking can never manage another.
 *
 * Because it goes to the row on every call, correcting `capability` in Neon revokes
 * the grant on the next request — nothing durable anywhere holds a stale "yes".
 *
 * Never throws. Note the deliberate asymmetry with the resolver route: for DISPLAY,
 * `unavailable` means "try again" (`unreadable`) or "here is your page anyway"
 * (`unusable-row`, which keeps its redirect); for a MUTATION both mean no. We do not
 * grant a capability we could not verify, and we do not guess at one we could not read.
 */
export async function waiverLinkGrantsAdminFor(
  code: string | null | undefined,
  projectId: string | null | undefined,
): Promise<boolean> {
  const wanted = String(projectId ?? "").trim();
  if (!code || !wanted) return false;
  const { link } = await readStoredLink(code);
  if (!link || link.capability !== "admin") return false;
  return link.reservation.projectId === wanted;
}

/**
 * Durable click telemetry. Deliberately in Neon rather than the Redis `click:` hash
 * `/s/` uses: that hash expires in 90 days, which for a link minted 5 months before
 * the event is exactly the window we need it in. Swallowed — an audit write must
 * never cost a guest their redirect.
 *
 * Runs no DDL either: this is on the click path, and if the table is not there yet
 * there is no hit to count.
 */
export async function recordWaiverLinkHit(code: string): Promise<void> {
  if (!code || !WAIVER_LINK_CODE_RE.test(code)) return;
  if (!isDbConfigured()) return;
  try {
    const q = sql();
    // BOUNDED. This runs AFTER the target is already known, so it must never cost the
    // guest their redirect — and swallowing errors is not enough, because the risk here
    // is LATENCY, not rejection: neon() is built with no fetchOptions, so the query
    // carries no AbortSignal, and this route sets no maxDuration (platform default).
    //
    // The contention is structural rather than exotic: one forwarded register link is ONE
    // row, so an organiser's whole party increments the same `WHERE code = X`. A stalled
    // or lock-queued UPDATE would 5xx a guest whose link is perfectly valid.
    //
    // Still awaited (not detached): a serverless function can freeze the instant the
    // response returns, which silently drops a fire-and-forget write. Awaiting a bounded
    // race keeps the write in the common case and caps the worst case. A lost hit count
    // is analytics; a lost redirect is the guest's waiver.
    await withTimeout(
      Promise.resolve().then(
        () => q`
          UPDATE waiver_link_codes
          SET hits = hits + 1, last_seen_at = NOW()
          WHERE code = ${code}
        `,
      ),
      HIT_WRITE_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(`[waiver-short-link] hit write failed for ${maskCode(code)}:`, errMessage(err));
  }
}
