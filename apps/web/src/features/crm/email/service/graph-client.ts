/**
 * Microsoft Graph, app-only — ported from the portal's `api/lib/graph.ts:54-97`
 * with the CRM's OWN env names (brief §1.11; never `GRAPH_TENANT_ID`, which the
 * Teams bot uses for Bot Framework):
 *
 *   CRM_GRAPH_TENANT_ID · CRM_GRAPH_CLIENT_ID · CRM_GRAPH_CLIENT_SECRET
 *
 * Read AT CALL TIME, never at build time (§5.7b): the moment the owner pastes
 * them into Vercel, `graphConfigured()` flips true and the SendGrid fallback
 * in `send.ts` switches itself off.
 *
 * Token: `POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token`,
 * `scope=https://graph.microsoft.com/.default`, cached in-process and renewed
 * 5 minutes early (portal F2.1).
 *
 * SEND IS THE DRAFT FLOW, NEVER `sendMail` (it 202s with no body and no id):
 *   createDraft(mailbox, …)  POST /users/{mailbox}/messages  +  Prefer: IdType="ImmutableId"
 *   → the id that SURVIVES the move to Sent Items (without the header the id
 *     changes; `test/msw/handlers/graph.ts` carries both fixtures)
 *   sendDraft(mailbox, id)   POST /users/{mailbox}/messages/{id}/send → 202
 *
 * Graph bodies carry NO BMI ids, so `JSON.parse` on `res.text()` is correct
 * here (the raw-id rule is for Office / Pandora payloads).
 */

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_LOGIN = "https://login.microsoftonline.com";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';
export const X_HP_LEAD_HEADER = "X-HP-Lead";

/** Token renewed this many ms before Graph says it expires. */
export const TOKEN_EARLY_MS = 5 * 60_000;
export const GRAPH_TIMEOUT_MS = 20_000;

export interface GraphEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export function readGraphEnv(env: NodeJS.ProcessEnv = process.env): GraphEnv | null {
  const tenantId = env.CRM_GRAPH_TENANT_ID?.trim();
  const clientId = env.CRM_GRAPH_CLIENT_ID?.trim();
  const clientSecret = env.CRM_GRAPH_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

/** All three CRM_GRAPH_* values present. False = SendGrid fallback territory. */
export function graphConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGraphEnv(env) !== null;
}

export class GraphError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: string;
  constructor(status: number, code: string | null, message: string, body: string) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** 5xx and 429 are transport-side; everything else is ours or the tenant's. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 0;
  }
}

interface CachedToken {
  key: string;
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

/** Tests reset the cache between cases. */
export function resetGraphTokenCache(): void {
  cached = null;
}

function parseGraphError(status: number, body: string): GraphError {
  let code: string | null = null;
  let message = `Graph ${status}`;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
      error_description?: string;
    };
    code = parsed.error?.code ?? null;
    message = parsed.error?.message ?? parsed.error_description ?? message;
  } catch {
    if (body) message = `${message}: ${body.slice(0, 200)}`;
  }
  return new GraphError(status, code, message, body.slice(0, 2000));
}

export async function getGraphToken(
  now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const cfg = readGraphEnv(env);
  if (!cfg) throw new GraphError(0, "not_configured", "CRM_GRAPH_* is not set", "");
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  if (cached && cached.key === key && cached.expiresAt - TOKEN_EARLY_MS > now()) {
    return cached.token;
  }
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: "client_credentials",
  });
  const res = await fetch(`${GRAPH_LOGIN}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw parseGraphError(res.status, text);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token)
    throw new GraphError(res.status, "no_token", "token response had no access_token", text);
  cached = {
    key,
    token: json.access_token,
    expiresAt: now() + Math.max(60, Number(json.expires_in) || 3599) * 1000,
  };
  return cached.token;
}

// ---------------------------------------------------------------------------
// What the tenant actually consented to
// ---------------------------------------------------------------------------

/**
 * PROBED LIVE 2026-09-13: the app registration "HeadPinz Sales CRM" holds
 * `["Mail.Read","Mail.Send"]`, and `POST /users/{mailbox}/messages` — the
 * DRAFT CREATE the whole rail is built on — answered
 * `403 ErrorAccessDenied`. That is not a policy problem and not a bug: in
 * Graph, `Mail.Send` authorises only `POST /users/{id}/sendMail` and
 * `POST /messages/{id}/send`. CREATING a message in a mailbox is a WRITE, and
 * writes need `Mail.ReadWrite`.
 *
 * We will not switch to `sendMail` to fit the permission we happen to have:
 * `sendMail` returns 202 with no body, so there is no id to store and the Sent
 * Items copy can never be reconciled with the lead (§1.11). The right fix is
 * one line of tenant admin — add `Mail.ReadWrite` (application) and consent —
 * and until it lands the CRM sends through SendGrid and SAYS SO.
 *
 * `graphSendReadiness` reads the roles out of the app token we already fetch,
 * so it costs nothing, is definitive rather than a guess, and flips itself the
 * moment the owner grants the permission.
 */
export const GRAPH_DRAFT_ROLE = "Mail.ReadWrite";
export const GRAPH_SEND_ROLE = "Mail.Send";
export const GRAPH_READ_ROLE = "Mail.Read";

/** The `roles` claim of an app-only token. Never logs or returns the token. */
export function tokenRoles(token: string): string[] {
  const part = token.split(".")[1];
  if (!part) return [];
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      roles?: unknown;
    };
    return Array.isArray(claims.roles)
      ? claims.roles.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

export interface GraphReadiness {
  /** Both the draft-create and the send permission are consented. */
  ready: boolean;
  roles: string[];
  missing: string[];
  /** Why not, in words a director can act on; null when ready. */
  reason: string | null;
}

export const GRAPH_NOT_CONFIGURED_REASON = "CRM_GRAPH_* is not set on this deployment yet";

/**
 * FIXED, and it has to be. Azure's token endpoint answers with AADSTS codes,
 * the tenant GUID, the app id and a correlation id; `graphReason` is rendered
 * in a rep's browser, and `core/http.ts` returns a fixed `unexpected` on a 500
 * for exactly this reason. The actionable half is the env var name, which is
 * ours; the upstream half goes to the server log (C2-9).
 */
export const GRAPH_CREDENTIALS_REASON =
  "Microsoft Graph refused our credentials — check CRM_GRAPH_CLIENT_SECRET";

export function readinessFromRoles(roles: string[]): GraphReadiness {
  const missing = [GRAPH_DRAFT_ROLE, GRAPH_SEND_ROLE].filter((r) => !roles.includes(r));
  return {
    ready: missing.length === 0,
    roles,
    missing,
    reason:
      missing.length === 0
        ? null
        : `Microsoft Graph is missing the ${missing.join(" and ")} application permission${
            missing.length > 1 ? "s" : ""
          } — an admin has to grant and consent to ${missing.join(" and ")} on the "HeadPinz Sales CRM" app registration.`,
  };
}

const NOT_CONFIGURED: GraphReadiness = Object.freeze({
  ready: false,
  roles: [],
  missing: [GRAPH_DRAFT_ROLE, GRAPH_SEND_ROLE],
  reason: GRAPH_NOT_CONFIGURED_REASON,
});

let readinessCache: { at: number; value: GraphReadiness } | null = null;
export const READINESS_TTL_MS = 5 * 60_000;

export function resetGraphReadinessCache(): void {
  readinessCache = null;
}

/** Cached for five minutes; a token failure is reported, never thrown. */
export async function graphSendReadiness(now: () => number = Date.now): Promise<GraphReadiness> {
  if (!graphConfigured()) return NOT_CONFIGURED;
  if (readinessCache && now() - readinessCache.at < READINESS_TTL_MS) return readinessCache.value;
  let value: GraphReadiness;
  try {
    value = readinessFromRoles(tokenRoles(await getGraphToken()));
  } catch (err) {
    console.error("[crm] graph token refused", {
      error: err instanceof Error ? err.message : String(err),
    });
    value = { ready: false, roles: [], missing: [], reason: GRAPH_CREDENTIALS_REASON };
  }
  readinessCache = { at: now(), value };
  return value;
}

export interface GraphRequestInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

/** Authenticated call; returns the raw text (empty for 202/204) or throws `GraphError`. */
export async function graphFetch(
  path: string,
  init: GraphRequestInit = {},
): Promise<{ status: number; text: string }> {
  const token = await getGraphToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(init.headers ?? {}),
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GraphError(0, "network", err instanceof Error ? err.message : String(err), "");
  }
  const text = await res.text();
  if (!res.ok) throw parseGraphError(res.status, text);
  return { status: res.status, text };
}

function mailboxPath(mailbox: string): string {
  return `/users/${encodeURIComponent(mailbox)}`;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

export interface GraphMessageHeader {
  name: string;
  value: string;
}

/** The fields we `$select` (brief §1.11) plus what create/send return. */
export interface GraphMessage {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  createdDateTime?: string | null;
  conversationId?: string | null;
  internetMessageId?: string | null;
  internetMessageHeaders?: GraphMessageHeader[];
  webLink?: string | null;
  isDraft?: boolean;
  parentFolderId?: string | null;
}

export const MESSAGE_SELECT =
  "id,subject,from,sender,toRecipients,ccRecipients,bodyPreview,receivedDateTime,sentDateTime,conversationId,internetMessageId,internetMessageHeaders,webLink,isDraft,parentFolderId";

export interface DraftInput {
  subject: string;
  /** Plain text body; sent as `contentType: "Text"`. */
  text: string;
  to: { address: string; name?: string }[];
  cc?: { address: string; name?: string }[];
  /** Our own Message-ID so a reply's In-Reply-To can be matched (RFC 5322). */
  internetMessageId?: string;
  /** Extra headers; each name MUST start with `X-` (Graph rejects others). */
  headers?: Record<string, string>;
}

export function draftBody(input: DraftInput): Record<string, unknown> {
  const headers: GraphMessageHeader[] = Object.entries(input.headers ?? {}).map(
    ([name, value]) => ({
      name,
      value,
    }),
  );
  const body: Record<string, unknown> = {
    subject: input.subject,
    body: { contentType: "Text", content: input.text },
    toRecipients: input.to.map((r) => ({ emailAddress: r })),
  };
  if (input.cc && input.cc.length > 0)
    body.ccRecipients = input.cc.map((r) => ({ emailAddress: r }));
  if (input.internetMessageId) body.internetMessageId = input.internetMessageId;
  if (headers.length > 0) body.internetMessageHeaders = headers;
  return body;
}

/** POST /users/{mailbox}/messages with `Prefer: IdType="ImmutableId"` → the draft under its immutable id. */
export async function createDraft(mailbox: string, input: DraftInput): Promise<GraphMessage> {
  const { text } = await graphFetch(`${mailboxPath(mailbox)}/messages`, {
    method: "POST",
    body: draftBody(input),
    headers: { prefer: IMMUTABLE_ID_PREFER },
  });
  return JSON.parse(text) as GraphMessage;
}

/** POST /users/{mailbox}/messages/{id}/send → 202, no body. */
export async function sendDraft(mailbox: string, messageId: string): Promise<void> {
  await graphFetch(`${mailboxPath(mailbox)}/messages/${encodeURIComponent(messageId)}/send`, {
    method: "POST",
  });
}

/** GET one message with the reconciliation fields, under immutable ids. */
export async function getMessage(mailbox: string, messageId: string): Promise<GraphMessage> {
  const { text } = await graphFetch(
    `${mailboxPath(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=${MESSAGE_SELECT}`,
    { headers: { prefer: IMMUTABLE_ID_PREFER } },
  );
  return JSON.parse(text) as GraphMessage;
}

/** The newest `top` Inbox messages — the live-proof read (subjects + dates only). */
export async function listInboxTop(
  mailbox: string,
  top = 3,
): Promise<{ id: string; subject: string | null; receivedDateTime: string | null }[]> {
  const { text } = await graphFetch(
    `${mailboxPath(mailbox)}/mailFolders/inbox/messages?$top=${Math.min(25, Math.max(1, top))}&$select=id,subject,receivedDateTime&$orderby=receivedDateTime desc`,
  );
  const json = JSON.parse(text) as { value?: GraphMessage[] };
  return (json.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject ?? null,
    receivedDateTime: m.receivedDateTime ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Subscriptions (brief §1.11: ≤ 4230 min; renew = PATCH; 404 → recreate)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_MAX_MINUTES = 4230;

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  clientState?: string;
  notificationUrl: string;
  expirationDateTime: string;
}

export function subscriptionResource(mailbox: string, folder: "inbox" | "sentitems"): string {
  return `/users/${mailbox}/mailFolders/${folder}/messages`;
}

export function subscriptionExpiry(now: Date, minutes = SUBSCRIPTION_MAX_MINUTES): string {
  const m = Math.min(SUBSCRIPTION_MAX_MINUTES, Math.max(1, minutes));
  return new Date(now.getTime() + m * 60_000).toISOString();
}

export async function createSubscription(input: {
  resource: string;
  notificationUrl: string;
  clientState: string;
  expirationDateTime: string;
}): Promise<GraphSubscription> {
  const { text } = await graphFetch(`/subscriptions`, {
    method: "POST",
    body: { changeType: "created", ...input },
  });
  return JSON.parse(text) as GraphSubscription;
}

export async function renewSubscription(
  id: string,
  expirationDateTime: string,
): Promise<GraphSubscription> {
  const { text } = await graphFetch(`/subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { expirationDateTime },
  });
  return JSON.parse(text) as GraphSubscription;
}
