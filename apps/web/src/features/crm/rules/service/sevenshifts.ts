/**
 * 7shifts client — the B2 port of the portal's `api/lib/7shifts-client.ts`
 * (brief §1.9; do not import across repos).
 *
 *   base       https://api.7shifts.com/v2/company/${SEVEN_SHIFTS_COMPANY_ID || "265994"}
 *   headers    Authorization: Bearer ${SEVEN_SHIFTS_API_TOKEN}   (the portal also
 *              accepts SEVEN_SHIFTS_ACCESS_TOKEN — so do we, same order),
 *              x-api-version: 2022-05-01, and a BROWSER User-Agent: Cloudflare
 *              challenges the default one.
 *   pacing     150 ms serial gap between calls (one promise chain per client),
 *              15 s timeout, GET retried ×3 on 403 / 429 / 5xx.
 *   shifts     GET /shifts?location_id=<id>&start[gte]=YYYY-MM-DD 00:00:00
 *              &start[lte]=<end+1d> 04:59:59&limit=500&include_draft=true —
 *              the business day ends 05:00 ET, so "shifts starting on <to>"
 *              runs into the small hours of the next calendar day. NEVER a `Z`
 *              instant in these params (portal T5): they are wall-clock strings
 *              in the location's zone.
 *   filtering  `deleted === true || publish_status.endsWith("_deleted")` are
 *              gone; `user_id === null` is an open shift (nobody's).
 *   times      `start` / `end` carry a local offset — kept verbatim; Postgres
 *              parses them into TIMESTAMPTZ.
 *   paging     `meta.cursor.next` → `?cursor=`.
 *
 * 7shifts ids are small integers, so `JSON.parse` is fine here — this is not a
 * BMI rail. The client is a class only so a test can inject `fetch` and the
 * sleeper; there is no module-level state.
 */

import { shiftYmd } from "~/features/crm/core/dates";

export const SEVEN_SHIFTS_DEFAULT_COMPANY_ID = "265994";
export const SEVEN_SHIFTS_API_VERSION = "2022-05-01";
/** A browser UA — Cloudflare challenges node's default. */
export const SEVEN_SHIFTS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
export const SEVEN_SHIFTS_GAP_MS = 150;
export const SEVEN_SHIFTS_TIMEOUT_MS = 15_000;
export const SEVEN_SHIFTS_RETRIES = 3;
export const SEVEN_SHIFTS_PAGE_LIMIT = 500;
export const SEVEN_SHIFTS_USER_PAGE_LIMIT = 200;

export const SEVEN_SHIFTS_TOKEN_MISSING = "SEVEN_SHIFTS_API_TOKEN is not set";

export interface SevenShiftsConfig {
  token: string | null;
  companyId: string;
  baseUrl: string;
}

/** `process.env`, or a plain object in tests. */
export type EnvLike = Record<string, string | undefined>;

/** Read the env once per call; `token: null` means the mirror cannot run. */
export function sevenShiftsConfig(env: EnvLike = process.env): SevenShiftsConfig {
  const token = env.SEVEN_SHIFTS_API_TOKEN?.trim() || env.SEVEN_SHIFTS_ACCESS_TOKEN?.trim() || null;
  const companyId = env.SEVEN_SHIFTS_COMPANY_ID?.trim() || SEVEN_SHIFTS_DEFAULT_COMPANY_ID;
  return { token, companyId, baseUrl: `https://api.7shifts.com/v2/company/${companyId}` };
}

export function isSevenShiftsConfigured(env: EnvLike = process.env): boolean {
  return sevenShiftsConfig(env).token !== null;
}

/** The fields we read from `GET /shifts` (the API sends more). */
export interface SevenShiftRaw {
  id: number;
  user_id: number | null;
  location_id: number;
  start: string;
  end: string;
  open?: boolean;
  publish_status?: string;
  draft?: boolean;
  deleted?: boolean;
}

export interface SevenShiftsUserRaw {
  id: number;
  first_name: string;
  last_name: string;
  email?: string;
  active?: boolean;
  location_ids?: number[];
}

interface Page<T> {
  data: T[];
  meta?: { cursor?: { next?: string | null } };
}

/** A shift the roster cares about: live, with the raw strings kept. */
export interface SevenShift {
  id: string;
  userId: number | null;
  locationId: number;
  /** Local-with-offset, verbatim from 7shifts. */
  start: string;
  end: string;
  /** YYYY-MM-DD of `start` in the location's zone — the string's own date part. */
  localDate: string;
}

export function isLiveShift(s: Pick<SevenShiftRaw, "deleted" | "publish_status">): boolean {
  if (s.deleted === true) return false;
  return !(typeof s.publish_status === "string" && s.publish_status.endsWith("_deleted"));
}

export function toSevenShift(raw: SevenShiftRaw): SevenShift {
  return {
    id: String(raw.id),
    userId: raw.user_id ?? null,
    locationId: raw.location_id,
    start: raw.start,
    end: raw.end,
    localDate: raw.start.slice(0, 10),
  };
}

/** `start[gte]=<from> 00:00:00` … `start[lte]=<to+1d> 04:59:59` — wall clock, no zone. */
export function shiftsQuery(locationId: number, fromYmd: string, toYmd: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set("location_id", String(locationId));
  p.set("start[gte]", `${fromYmd} 00:00:00`);
  p.set("start[lte]", `${shiftYmd(toYmd, 1)} 04:59:59`);
  p.set("limit", String(SEVEN_SHIFTS_PAGE_LIMIT));
  p.set("include_draft", "true");
  return p;
}

export class SevenShiftsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SevenShiftsError";
    this.status = status;
  }
}

export interface SevenShiftsClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: EnvLike;
  /** Override the pacing / timeout in tests. */
  gapMs?: number;
  timeoutMs?: number;
  retries?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

export class SevenShiftsClient {
  private readonly cfg: SevenShiftsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gapMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  /** The serial chain: every call waits for the previous one plus the gap. */
  private chain: Promise<unknown> = Promise.resolve();
  private calls = 0;

  constructor(deps: SevenShiftsClientDeps = {}) {
    this.cfg = sevenShiftsConfig(deps.env ?? process.env);
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? realSleep;
    this.gapMs = deps.gapMs ?? SEVEN_SHIFTS_GAP_MS;
    this.timeoutMs = deps.timeoutMs ?? SEVEN_SHIFTS_TIMEOUT_MS;
    this.retries = deps.retries ?? SEVEN_SHIFTS_RETRIES;
  }

  get configured(): boolean {
    return this.cfg.token !== null;
  }

  /** One GET, serialised behind every earlier call with the 150 ms gap, retried on 403/429/5xx. */
  private get<T>(path: string, params: URLSearchParams): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.cfg.token) throw new SevenShiftsError(0, SEVEN_SHIFTS_TOKEN_MISSING);
      if (this.calls > 0) await this.sleep(this.gapMs);
      this.calls++;
      const url = `${this.cfg.baseUrl}${path}?${params.toString()}`;
      let lastStatus = 0;
      let lastBody = "";
      for (let attempt = 1; attempt <= this.retries; attempt++) {
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            "x-api-version": SEVEN_SHIFTS_API_VERSION,
            "user-agent": SEVEN_SHIFTS_USER_AGENT,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        if (res.ok) return JSON.parse(text) as T;
        lastStatus = res.status;
        lastBody = text.slice(0, 200);
        if (!retryable(res.status) || attempt === this.retries) break;
        await this.sleep(this.gapMs * attempt);
      }
      throw new SevenShiftsError(lastStatus, `7shifts ${lastStatus} on ${path}: ${lastBody}`);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Every page of a cursor-paginated list. */
  private async getAll<T>(path: string, params: URLSearchParams): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page++) {
      const p = new URLSearchParams(params);
      if (cursor) p.set("cursor", cursor);
      const res = await this.get<Page<T>>(path, p);
      out.push(...(Array.isArray(res.data) ? res.data : []));
      cursor = res.meta?.cursor?.next ?? null;
      if (!cursor) break;
    }
    return out;
  }

  /** Live shifts at one location whose start falls in [from 00:00, to+1d 04:59:59] local time. */
  async listShifts(input: {
    locationId: number;
    fromYmd: string;
    toYmd: string;
  }): Promise<SevenShift[]> {
    const raw = await this.getAll<SevenShiftRaw>(
      "/shifts",
      shiftsQuery(input.locationId, input.fromYmd, input.toYmd),
    );
    return raw.filter(isLiveShift).map(toSevenShift);
  }

  /**
   * Active users — `id` is the join key for `crm_reps.seven_shifts_user_id`.
   *
   * `departmentId` is the ONLY way to learn who is in a department: a user row
   * carries no department field at all (probed live 2026-09-13, §5.7b), so
   * membership is a server-side filter, never something to scan `/users` for.
   */
  async listUsers(input: { departmentId?: number } = {}): Promise<SevenShiftsUserRaw[]> {
    const p = new URLSearchParams();
    p.set("status", "active");
    p.set("limit", String(SEVEN_SHIFTS_USER_PAGE_LIMIT));
    if (input.departmentId !== undefined) p.set("department_id", String(input.departmentId));
    return this.getAll<SevenShiftsUserRaw>("/users", p);
  }
}
