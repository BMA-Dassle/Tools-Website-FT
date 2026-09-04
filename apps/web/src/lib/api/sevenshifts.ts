import "server-only";

/**
 * 7shifts REST transport. TRANSPORT ONLY: auth, pacing, retry, pagination.
 * No employee knowledge lives here — that is `features/staff/`.
 *
 * SERVER-ONLY, and deliberately so even though the token would come back
 * `undefined` in a browser bundle (Next only inlines `NEXT_PUBLIC_*`). The guard
 * turns "somebody imported this into a client component" into a build error
 * rather than a keypad that silently never verifies anybody. `features/staff`'s
 * barrel re-exports only the pure half, so importing that stays safe.
 *
 * ── THE ONE FACT THAT SHAPES EVERY CALLER ───────────────────────────────────
 *
 * THERE IS NO WAY TO LOOK UP A USER BY PUNCH ID. Verified against the v2 List
 * Users reference 2026-09-03: the endpoint accepts `modified_since`,
 * `location_id`, `department_id`, `role_id`, `status`, `name`, `sort_by`,
 * `cursor` and `limit` — and nothing else. `punch_id` exists only as a field on
 * the RESPONSE, and there is no by-punch-id sibling to `GET /users/{id}` (which
 * takes the 7shifts user id, a number nobody types).
 *
 * So a punch ID can only be resolved by fetching users and matching locally.
 * That is not a shortcut, it is the whole API surface. `features/staff` turns it
 * into something a wall tablet can use by building the index ONCE per refresh
 * window into Redis; nothing should ever page 7shifts on a keypress.
 *
 * ── CLOUDFLARE IS THE OTHER REASON THIS FILE EXISTS ─────────────────────────
 *
 * 7shifts sits behind Cloudflare with rate-based bot mitigation. A burst from a
 * warm serverless container draws a MANAGED CHALLENGE — HTTP 403 with a
 * `cf-mitigated` header and an HTML body — not a clean 401 or 429. Code that
 * treats 403 as "bad token" reads a rate limit as an auth failure and gives up.
 *
 * The defences, all carried over from the team portal's client, which earned
 * them the hard way against this same account:
 *   - ONE module-level serial queue with a 150 ms trailing gap, so a single
 *     container can never burst.
 *   - 403 is RETRYABLE on GET (see isGetRetryable) — the opposite of the usual
 *     rule, and correct here.
 *   - A pinned browser User-Agent. A default node/undici UA from a datacentre
 *     IP is itself a bot signal.
 *
 * ── AND THE REST ────────────────────────────────────────────────────────────
 *
 * Pagination is CURSOR-based (meta.cursor.next), not offset. `limit` caps at
 * 500 and defaults to 100. `x-api-version: 2022-05-01` is required.
 */

/** Company id. Defaulted because it is stable, overridable for a second brand. */
export const SEVEN_SHIFTS_COMPANY_ID = process.env.SEVEN_SHIFTS_COMPANY_ID || "265994";

export const SEVEN_SHIFTS_BASE_URL = `https://api.7shifts.com/v2/company/${SEVEN_SHIFTS_COMPANY_ID}`;

/** The largest page 7shifts will serve. Default is 100 — always ask for 500. */
export const SEVEN_SHIFTS_MAX_LIMIT = 500;

/** Trailing gap between requests from this container. */
const REQUEST_GAP_MS = 150;

/** Per-attempt ceiling. A wall tablet is waiting; a hung socket must not hold it. */
const REQUEST_TIMEOUT_MS = 15_000;

const MAX_RETRIES = 3;

function token(): string {
  return process.env.SEVEN_SHIFTS_API_TOKEN || process.env.SEVEN_SHIFTS_ACCESS_TOKEN || "";
}

/** False when no token is set — callers degrade instead of throwing on every press. */
export function isSevenShiftsConfigured(): boolean {
  return token().length > 0;
}

export class SevenShiftsError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    method: string,
    url: string,
    /** True when this 403 is a Cloudflare challenge rather than a real auth failure. */
    readonly cloudflare = false,
  ) {
    super(
      `7shifts ${method} ${url} → ${status}${cloudflare ? " (cloudflare)" : ""} ${body.slice(0, 300)}`,
    );
    this.name = "SevenShiftsError";
  }

  /** A real credential problem, as distinct from a challenge wearing a 403. */
  get isAuthFailure(): boolean {
    return this.status === 401 || (this.status === 403 && !this.cloudflare);
  }
}

/**
 * A Cloudflare managed challenge, not an auth failure. Identified by the
 * `cf-mitigated` response header, or a 403 whose body is the challenge page.
 * Retry handles it either way; this exists so the logs say which one happened.
 */
function isChallenge(status: number, headers: Headers, body: string): boolean {
  if (headers.get("cf-mitigated") != null) return true;
  return status === 403 && body.includes("challenges.cloudflare.com");
}

/**
 * GET is idempotent, so retry the challenge (403), the rate limit (429) and
 * transient server errors. 403 being retryable is the whole point — see header.
 */
function isGetRetryable(status: number): boolean {
  return status === 403 || status === 429 || (status >= 500 && status < 600);
}

// ── Paced serial queue ──────────────────────────────────────────────────────
// Every request chains onto one module-level promise so they never overlap in a
// warm container, each followed by a fixed gap. Errors are swallowed when
// advancing the chain so one failure cannot wedge the queue for later callers.
let requestChain: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = requestChain.then(task);
  const gap = () => new Promise<void>((r) => setTimeout(r, REQUEST_GAP_MS));
  requestChain = run.then(gap, gap);
  return run;
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const base = path.startsWith("http")
    ? path
    : `${SEVEN_SHIFTS_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function backoff(
  attempt: number,
  method: string,
  url: string,
  status: string,
  cloudflare: boolean,
): Promise<void> {
  const ms = Math.min(6000, 600 * 2 ** attempt) + Math.floor(Math.random() * 200);
  console.warn(
    `[7shifts] ${method} ${url} retry ${attempt + 1}/${MAX_RETRIES} (status=${status}, cloudflare=${cloudflare}), backing off ${ms}ms`,
  );
  await new Promise((r) => setTimeout(r, ms));
}

/** Paced, retrying GET. Returns the parsed body. */
export async function sevenShiftsGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  if (!isSevenShiftsConfigured()) {
    throw new SevenShiftsError(0, "SEVEN_SHIFTS_API_TOKEN not set", "GET", path);
  }
  const url = buildUrl(path, params);

  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let cloudflare = false;
      let body = "";
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token()}`,
            // A library default UA from a datacentre IP is a bot signal.
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "x-api-version": "2022-05-01",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          cache: "no-store",
        });
        if (res.ok) return (await res.json()) as T;

        status = res.status;
        body = await res.text().catch(() => "");
        cloudflare = isChallenge(status, res.headers, body);
      } catch (e) {
        // Network error / timeout. Retryable on the same terms as a 5xx.
        if (attempt >= MAX_RETRIES) throw e;
        await backoff(attempt, "GET", url, "network", false);
        continue;
      }

      if (!isGetRetryable(status) || attempt >= MAX_RETRIES) {
        throw new SevenShiftsError(status, body, "GET", url, cloudflare);
      }
      await backoff(attempt, "GET", url, String(status), cloudflare);
    }
  });
}

/** One page of a cursor-paginated list. */
interface CursorPage<T> {
  data?: T[];
  meta?: { cursor?: { next?: string | null } };
}

/**
 * Follow `meta.cursor.next` and return every item, flat. Each page rides the
 * paced queue. Stops at `maxPages` and reports `truncated` rather than silently
 * cutting off — a half-built punch index is a staff member who cannot start a
 * briefing, and the caller must be able to refuse to publish one.
 */
export async function sevenShiftsGetAll<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { maxPages?: number } = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 50;
  const items: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body = await sevenShiftsGet<CursorPage<T>>(path, { ...params, cursor });
    if (Array.isArray(body?.data)) items.push(...body.data);
    const next = body?.meta?.cursor?.next;
    if (!next) return { items, truncated: false };
    cursor = next ?? undefined;
  }

  console.warn(
    `[7shifts] sevenShiftsGetAll hit maxPages=${maxPages} for ${path} — results truncated`,
  );
  return { items, truncated: true };
}

/** A 7shifts user, narrowed to the fields we consume. */
export interface SevenShiftsUser {
  id: number;
  punch_id?: string | null;
  employee_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  preferred_first_name?: string | null;
  preferred_last_name?: string | null;
  email?: string | null;
  photo_url?: string | null;
  type?: string | null;
  active?: boolean | null;
  status?: string | null;
  location_ids?: number[] | null;
}

/**
 * Every user in the company.
 *
 * `status=active` is passed but NOT trusted: 7shifts' own guide says active
 * filtering "is currently only available on the V1 /users endpoint [and] will be
 * available in the v2 endpoint soon", while the v2 reference lists `status` as a
 * parameter. Rather than bet on which is true this week, we ask for the filter
 * AND filter the response ourselves (see features/staff/punch-index).
 */
export function listSevenShiftsUsers(): Promise<{ items: SevenShiftsUser[]; truncated: boolean }> {
  return sevenShiftsGetAll<SevenShiftsUser>("/users", {
    limit: SEVEN_SHIFTS_MAX_LIMIT,
    status: "active",
  });
}
