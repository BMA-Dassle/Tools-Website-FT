/**
 * 3CX (`bma.3cx.us`) — the ONE transport the CRM uses for calls (brief §4 C3).
 *
 * EVERY endpoint below was probed read-only on 2026-09-13 with the live
 * `THREECX_CLIENT_ID` credential before a line was written against it; the
 * results, the exact shapes and what this API user may NOT do are recorded in
 * `docs/crm/3cx.md`, and the captured payloads (numbers redacted) are the MSW
 * fixtures `test/msw/fixtures/threecx-*.json.txt`.
 *
 * Three surfaces, one token:
 *   - Call Control  `GET /callcontrol` (99 DNs), `GET /callcontrol/{dn}`,
 *                   `POST /callcontrol/{dn}/makecall` (click-to-call)
 *   - Configuration `GET /xapi/v1/Users` (extension ↔ person, read-only)
 *   - Call reports  `GET /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(…)` —
 *                   the BOUND OData function, which is the only form that
 *                   answers: the bare entity set is a 404 and
 *                   `/xapi/v1/CallHistoryView` is a 500 on this PBX.
 *
 * Token: client credentials at `POST /connect/token` (form-encoded) with
 * `THREECX_CLIENT_ID` / `THREECX_CLIENT_SECRET` — the same pair
 * `app/api/chat-status/route.ts` already uses, so nothing new in Vercel. The
 * token is short-lived (60 s on this PBX) and cached in-process, refreshed
 * 10 s early; a 401 clears the cache and retries ONCE
 * (`Tools-Call-Center/api/3cx/call-action.js` does the same).
 *
 * Reads only, except `makeCall`, which is reached through `service/dial.ts`
 * behind `crmCallsEnabled()` (kill switch `CRM_CALLS !== "false"`) and only
 * after the Neon intent row exists (R2).
 *
 * No 17-digit ids live here — 3CX ids are small integers (`CallId`,
 * `SegmentId`) or GUID strings (`CdrId`, `CallHistoryId`) — so `JSON.parse` on
 * these bodies is safe; the rule that forbids it is about Office / Pandora.
 */

export const THREECX_DEFAULT_BASE = "https://bma.3cx.us";

/** How long one 3CX call may take before we give up (report reads included). */
export const THREECX_TIMEOUT_MS = 20_000;

/** Refresh the token this many ms before 3CX says it expires. */
const TOKEN_EARLY_MS = 10_000;

export function threecxBase(): string {
  return (process.env.THREECX_API_URL || THREECX_DEFAULT_BASE).replace(/\/+$/, "");
}

/** Both halves of the client credential are present. */
export function threecxConfigured(): boolean {
  return Boolean(process.env.THREECX_CLIENT_ID && process.env.THREECX_CLIENT_SECRET);
}

export class ThreecxError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "ThreecxError";
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

/** Tests and the 401 path. */
export function resetThreecxTokenCache(): void {
  tokenCache = null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function getThreecxToken(now: number = Date.now()): Promise<string> {
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;
  if (!threecxConfigured()) throw new ThreecxError(0, "3cx_not_configured");
  const res = await fetch(`${threecxBase()}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.THREECX_CLIENT_ID || "",
      client_secret: process.env.THREECX_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(THREECX_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new ThreecxError(res.status, `3cx token ${res.status}`, text.slice(0, 300));
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ThreecxError(res.status, "3cx token: not JSON", text.slice(0, 300));
  }
  if (!data.access_token) throw new ThreecxError(res.status, "3cx token: no access_token");
  const ttlMs = Math.max(5_000, (Number(data.expires_in) || 60) * 1000 - TOKEN_EARLY_MS);
  tokenCache = { token: data.access_token, expiresAt: now + ttlMs };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface ThreecxResponse {
  status: number;
  ok: boolean;
  text: string;
}

async function once(path: string, init: RequestInit): Promise<ThreecxResponse> {
  const token = await getThreecxToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${threecxBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(THREECX_TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

/** Bearer-authenticated call; a 401 clears the token and retries exactly once. */
export async function threecxFetch(path: string, init: RequestInit = {}): Promise<ThreecxResponse> {
  const first = await once(path, init);
  if (first.status !== 401) return first;
  resetThreecxTokenCache();
  return once(path, init);
}

function parseJson<T>(res: ThreecxResponse, what: string): T {
  if (!res.ok)
    throw new ThreecxError(res.status, `3cx ${what} ${res.status}`, res.text.slice(0, 300));
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ThreecxError(res.status, `3cx ${what}: not JSON`, res.text.slice(0, 300));
  }
}

// ---------------------------------------------------------------------------
// Call Control
// ---------------------------------------------------------------------------

/** One party on a DN (`Tools-Call-Center/api/3cx/extension-status.js`; probed shape). */
export interface CallControlParticipant {
  id: number;
  status?: string;
  dn?: string;
  party_caller_name?: string;
  party_dn?: string;
  party_caller_id?: string;
  party_did?: string;
  party_dn_type?: string;
  device_id?: string;
  direct_control?: boolean;
  originated_by_dn?: string;
  originated_by_type?: string;
  callid?: number;
  legid?: number;
}

export interface CallControlDevice {
  dn: string;
  device_id: string;
  user_agent?: string;
}

export interface CallControlDn {
  dn: string;
  /** `Wextension`, `Wqueue`, `Wivr`, `Wroutepoint`, `Wparkextension`, … */
  type: string;
  devices?: CallControlDevice[];
  participants?: CallControlParticipant[];
}

export async function listCallControl(): Promise<CallControlDn[]> {
  return parseJson<CallControlDn[]>(await threecxFetch("/callcontrol"), "callcontrol");
}

export async function getCallControlDn(dn: string): Promise<CallControlDn | null> {
  const res = await threecxFetch(`/callcontrol/${encodeURIComponent(dn)}`);
  if (res.status === 404) return null;
  return parseJson<CallControlDn>(res, `callcontrol/${dn}`);
}

export interface MakeCallResult {
  finalstatus?: string;
  reason?: string;
  result?: CallControlParticipant;
}

/**
 * `POST /callcontrol/{dn}/makecall {destination, timeout}` — rings the
 * extension's registered device first, then the destination (the prototype's
 * "Ringing your 3CX extension (…) first, then <guest>"). `destination` is the
 * dialable string 3CX expects; E.164 is what the call log carries for external
 * legs, so that is what we send. Only `service/dial.ts` calls this.
 *
 * NOT probed live — a probe would have rung a real handset — so a failure here
 * is expected to be possible in production on day one and is handled as a
 * `tel:` degrade, never a thrown 500 in the rep's face (`service/dial.ts`).
 */
export async function makeCall(
  extension: string,
  destination: string,
  timeoutSeconds = 30,
): Promise<MakeCallResult> {
  const res = await threecxFetch(`/callcontrol/${encodeURIComponent(extension)}/makecall`, {
    method: "POST",
    body: JSON.stringify({ destination, timeout: timeoutSeconds }),
  });
  return parseJson<MakeCallResult>(res, `makecall/${extension}`);
}

// ---------------------------------------------------------------------------
// Configuration API (read-only)
// ---------------------------------------------------------------------------

export interface ThreecxUser {
  Id: number;
  Number: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
}

export async function listUsers(top = 200): Promise<ThreecxUser[]> {
  const q = new URLSearchParams({
    $select: "Id,Number,FirstName,LastName,EmailAddress",
    $top: String(Math.min(Math.max(top, 1), 500)),
  });
  const res = await threecxFetch(`/xapi/v1/Users?${q.toString()}`);
  return parseJson<{ value?: ThreecxUser[] }>(res, "Users").value ?? [];
}

// ---------------------------------------------------------------------------
// Call reports (the reconcile job)
// ---------------------------------------------------------------------------

/**
 * `Pbx.CallLogData` as the PBX returns it (probed 2026-09-13; the property
 * list is the `$metadata` EntityType, not a guess). `CdrId` / `CallHistoryId`
 * are GUID strings; `CallId` / `SegmentId` are small ints; durations are
 * ISO-8601 (`PT1M1.432135S`).
 */
export interface CallLogRow {
  MainCallHistoryId?: string;
  CallHistoryId?: string;
  CdrId?: string;
  CallId?: number;
  Indent?: number;
  StartTime?: string;
  SourceType?: number;
  SourceDn?: string;
  SourceCallerId?: string;
  SourceDisplayName?: string;
  DestinationType?: number;
  DestinationDn?: string;
  DestinationCallerId?: string;
  DestinationDisplayName?: string;
  RingingDuration?: string;
  TalkingDuration?: string;
  Answered?: boolean;
  /** `Inbound` | `Outbound` | `Internal`. */
  Direction?: string;
  /** `Extension` | `Queue` | `System` | `External` | … */
  CallType?: string;
  /** `Answered` | `Unanswered` | `Waiting` | … */
  Status?: string;
  RecordingUrl?: string;
  Reason?: string;
  SegmentId?: number;
  SubrowDescNumber?: number;
}

/** OData date literal for the XAPI (`2026-09-13T12:00:00Z`, no millis). */
export function odataInstant(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The BOUND OData function that actually answers on this PBX (probed
 * 2026-09-13): `/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(<12 params>)`.
 *
 * Everything simpler 404s or 500s — see `docs/crm/3cx.md`. The parameter list
 * comes from `$metadata`'s `<Function Name="GetCallLogData" IsBound="true">`
 * and every one of them is REQUIRED; `sourceType`/`destinationType`/`callsType`
 * `0` mean "all", `hidePcalls=true` drops the PBX's own internal plumbing.
 */
export function callLogPath(from: Date, to: Date): string {
  const args = [
    `periodFrom=${odataInstant(from)}`,
    `periodTo=${odataInstant(to)}`,
    "sourceType=0",
    "sourceFilter=''",
    "destinationType=0",
    "destinationFilter=''",
    "callsType=0",
    "callTimeFilterType=0",
    "callTimeFilterFrom='0:00:0'",
    "callTimeFilterTo='0:00:0'",
    "hidePcalls=true",
  ].join(",");
  return `/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(${args})?$orderby=StartTime desc`;
}

export const CALL_LOG_MAX = 500;

/** Every CDR row that started in the window, newest first. */
export async function fetchCallLog(opts: {
  from: Date;
  to: Date;
  top?: number;
}): Promise<CallLogRow[]> {
  const top = Math.min(Math.max(opts.top ?? 200, 1), CALL_LOG_MAX);
  const res = await threecxFetch(`${callLogPath(opts.from, opts.to)}&$top=${top}`);
  return parseJson<{ value?: CallLogRow[] }>(res, "GetCallLogData").value ?? [];
}

// ---------------------------------------------------------------------------
// Probe (read-only reconnaissance; never throws, never dials)
// ---------------------------------------------------------------------------

/** Mask every run of 7+ digits so a report can be pasted into docs/fixtures. */
export function redactNumbers(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(/\d{7,}/g, (m) => `${m.slice(0, 3)}…${m.slice(-2)}`);
  if (Array.isArray(value)) return value.map(redactNumbers);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactNumbers(v)]),
    );
  }
  return value;
}

export interface ProbeStep {
  ok: boolean;
  status: number;
  /** First 300 chars of a failure body, redacted. */
  error?: string;
  /** Redacted sample of what came back. */
  sample?: unknown;
  keys?: string[];
  count?: number;
}

export interface ProbeReport {
  base: string;
  configured: boolean;
  token: ProbeStep;
  callcontrol: ProbeStep;
  extension: ProbeStep & { dn: string | null };
  users: ProbeStep;
  callLog: ProbeStep;
  ranAt: string;
}

async function step(
  run: () => Promise<Partial<ProbeStep> & { status: number }>,
): Promise<ProbeStep> {
  try {
    const out = await run();
    return { ok: out.status >= 200 && out.status < 300, ...out };
  } catch (err) {
    if (err instanceof ThreecxError) {
      return {
        ok: false,
        status: err.status,
        error: String(redactNumbers(err.body || err.message)),
      };
    }
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function firstKeys(rows: unknown[]): string[] {
  const first = rows[0];
  return first && typeof first === "object" ? Object.keys(first as object) : [];
}

/**
 * What the API user can do today. `extension` picks the DN to read one by one
 * (default: the first `Wextension` in the list). Window: the last 24 h.
 * Dials nothing.
 */
export async function probe(opts: { extension?: string; now?: Date } = {}): Promise<ProbeReport> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - 24 * 3600 * 1000);
  const report: ProbeReport = {
    base: threecxBase(),
    configured: threecxConfigured(),
    token: { ok: false, status: 0 },
    callcontrol: { ok: false, status: 0 },
    extension: { ok: false, status: 0, dn: opts.extension ?? null },
    users: { ok: false, status: 0 },
    callLog: { ok: false, status: 0 },
    ranAt: now.toISOString(),
  };

  report.token = await step(async () => {
    await getThreecxToken();
    return { status: 200 };
  });
  if (!report.token.ok) return report;

  let dns: CallControlDn[] = [];
  report.callcontrol = await step(async () => {
    const res = await threecxFetch("/callcontrol");
    if (!res.ok) throw new ThreecxError(res.status, "callcontrol", res.text);
    dns = JSON.parse(res.text) as CallControlDn[];
    return {
      status: res.status,
      count: dns.length,
      sample: redactNumbers(
        dns.slice(0, 12).map((d) => ({
          dn: d.dn,
          type: d.type,
          devices: d.devices?.length ?? 0,
          participants: d.participants?.length ?? 0,
        })),
      ),
    };
  });

  const dn = opts.extension ?? dns.find((d) => d.type === "Wextension")?.dn ?? null;
  report.extension = {
    dn,
    ...(dn
      ? await step(async () => {
          const res = await threecxFetch(`/callcontrol/${encodeURIComponent(dn)}`);
          if (!res.ok) throw new ThreecxError(res.status, "callcontrol/dn", res.text);
          const one = JSON.parse(res.text) as CallControlDn;
          return { status: res.status, keys: Object.keys(one), sample: redactNumbers(one) };
        })
      : { ok: false, status: 0, error: "no Wextension in /callcontrol" }),
  };

  report.users = await step(async () => {
    const q = new URLSearchParams({ $select: "Id,Number,FirstName,LastName", $top: "100" });
    const res = await threecxFetch(`/xapi/v1/Users?${q.toString()}`);
    if (!res.ok) throw new ThreecxError(res.status, "Users", res.text);
    const rows = (JSON.parse(res.text) as { value?: unknown[] }).value ?? [];
    return {
      status: res.status,
      count: rows.length,
      keys: firstKeys(rows),
      sample: redactNumbers(rows.slice(0, 40)),
    };
  });

  report.callLog = await step(async () => {
    const res = await threecxFetch(`${callLogPath(from, now)}&$top=5`);
    if (!res.ok) throw new ThreecxError(res.status, "GetCallLogData", res.text);
    const rows = (JSON.parse(res.text) as { value?: unknown[] }).value ?? [];
    return {
      status: res.status,
      count: rows.length,
      keys: firstKeys(rows),
      sample: redactNumbers(rows.slice(0, 2)),
    };
  });

  return report;
}
