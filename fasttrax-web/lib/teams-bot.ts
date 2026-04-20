/**
 * Teams Bot Framework client — ported from
 * `C:\GIT\Tools-Team-Member-Portal\api\lib\bot.ts` (the portal's bot).
 *
 * We share the portal's Azure bot registration (BOT_APP_ID = ecb2f15a-…),
 * which means:
 *   - SEND side: works out-of-the-box with the same credentials — OAuth2
 *     client-credentials against login.microsoftonline.com/{GRAPH_TENANT_ID}.
 *   - RECEIVE side (button clicks via Action.Execute): Azure's registered
 *     messaging endpoint still points at the portal. Portal forwards verbs
 *     starting with `sales_lead_` to `/api/teams/bot-action` here. See
 *     `okay-we-need-to-harmonic-gem.md` §8 for the portal-side spec.
 *
 * Only the functions fasttrax-web actually needs are ported:
 *   - getBotAccessToken()
 *   - sendAdaptiveCardToChannel()
 *   - updateAdaptiveCard()
 *
 * Portal-specific helpers (image download, thread creation, DM send,
 * Postgres-backed ConversationRef storage) are intentionally left out.
 */

const BOT_APP_ID = process.env.BOT_APP_ID || "";
const BOT_APP_SECRET = process.env.BOT_APP_SECRET || "";
const BOT_TENANT_ID = process.env.GRAPH_TENANT_ID || "botframework.com";
const BOT_TOKEN_URL = `https://login.microsoftonline.com/${BOT_TENANT_ID}/oauth2/v2.0/token`;

/**
 * AMER regional service URL for Teams chats registered in North America.
 * Individual chat/channel installations sometimes have different regional
 * hosts (`smba.trafficmanager.net/emea`, `/apac`, etc.). If sends fail with
 * 401/404 for a specific planner chat, capture the actual serviceUrl from
 * a conversationUpdate activity in the portal and pass it as an override.
 */
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/amer";

const BOT_FETCH_TIMEOUT_MS = 8000; // Vercel has a 10s function-timeout; stay under it

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = BOT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── OAuth2 token cache ──────────────────────────────────────────────────────
// Module-scoped so multiple calls in the same Lambda invocation share one
// token. Re-fetched when within 5 min of expiry.

let cachedBotToken: { token: string; expiresAt: number } | null = null;

export async function getBotAccessToken(): Promise<string> {
  if (cachedBotToken && cachedBotToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedBotToken.token;
  }

  if (!BOT_APP_ID || !BOT_APP_SECRET) {
    throw new Error("BOT_APP_ID and BOT_APP_SECRET environment variables are required");
  }

  const resp = await fetchWithTimeout(BOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: BOT_APP_ID,
      client_secret: BOT_APP_SECRET,
      scope: "https://api.botframework.com/.default",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Bot token acquisition failed: ${resp.status} - ${errText}`);
  }

  const data = await resp.json();
  cachedBotToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedBotToken.token;
}

// ── Send / Update Adaptive Cards ────────────────────────────────────────────

export interface BotActivityResponse {
  /** Activity ID — capture this to later `updateAdaptiveCard` in place. */
  id: string;
}

export interface SendCardOpts {
  /** AAD mentions — ID must be raw AAD Object ID (GUID), NOT 29: prefixed. */
  mentions?: Array<{ id: string; name: string }>;
  /** Override the service URL if the conversation is in a non-AMER region. */
  serviceUrl?: string;
  /**
   * Notification preview shown in the Teams activity feed before the user
   * opens the message. Keep under ~80 chars.
   */
  summaryText?: string;
}

/**
 * POST a new Adaptive Card into a Teams conversation (chat or channel).
 * `conversationId` is the `19:…@thread.v2` ID Teams assigns to the chat.
 * Returns the activity ID so callers can persist it for later card updates.
 */
export async function sendAdaptiveCardToChannel(
  conversationId: string,
  card: Record<string, unknown>,
  opts?: SendCardOpts,
): Promise<BotActivityResponse> {
  const token = await getBotAccessToken();
  const svcUrl = (opts?.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  const url = `${svcUrl}/v3/conversations/${conversationId}/activities`;

  const activity: Record<string, unknown> = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
  };

  if (opts?.summaryText) {
    activity.summary = opts.summaryText;
  }

  if (opts?.mentions?.length) {
    activity.entities = opts.mentions.map((m) => {
      const rawId = m.id.startsWith("29:") ? m.id.slice(3) : m.id;
      return {
        type: "mention",
        mentioned: { id: rawId, name: m.name },
        text: `<at>${m.name}</at>`,
      };
    });
  }

  const bodyJson = JSON.stringify(activity);
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  const respText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Bot send failed: ${resp.status} - ${respText.slice(0, 500)}`);
  }

  try {
    return respText ? JSON.parse(respText) : { id: "" };
  } catch {
    return { id: respText || "" };
  }
}

/**
 * PUT to replace an existing card in-place. Used when a user clicks an
 * Action.Execute button — we compute the new card state from Redis + push
 * it back so every participant sees the update live.
 *
 * Does NOT throw on failure — callers may invoke this opportunistically
 * after a state write that has already succeeded, and we don't want a
 * transient Bot Framework hiccup to roll that back.
 */
export async function updateAdaptiveCard(
  conversationId: string,
  activityId: string,
  card: Record<string, unknown>,
  opts?: SendCardOpts,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const token = await getBotAccessToken();
  const svcUrl = (opts?.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  const url = `${svcUrl}/v3/conversations/${conversationId}/activities/${activityId}`;

  const activity: Record<string, unknown> = {
    type: "message",
    id: activityId,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
  };

  if (opts?.summaryText) {
    activity.summary = opts.summaryText;
  }

  if (opts?.mentions?.length) {
    activity.entities = opts.mentions.map((m) => {
      const rawId = m.id.startsWith("29:") ? m.id.slice(3) : m.id;
      return {
        type: "mention",
        mentioned: { id: rawId, name: m.name },
        text: `<at>${m.name}</at>`,
      };
    });
  }

  try {
    const resp = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, error: errText.slice(0, 500) };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}
