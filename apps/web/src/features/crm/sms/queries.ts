/**
 * React Query keys for the SMS sub (brief §3.4: `["crm", <sub>, …]` tuples;
 * mutations invalidate `smsKeys.all`). CLIENT-SAFE — no imports. Components
 * import this file by path, never the sub's server barrel.
 */

export const smsKeys = {
  all: ["crm", "sms"] as const,
  conversations: (filters: Record<string, string> = {}) =>
    ["crm", "sms", "conversations", filters] as const,
  conversation: (key: string, cursor: string | null = null) =>
    ["crm", "sms", "conversation", key, cursor] as const,
  unread: () => ["crm", "sms", "unread"] as const,
  templates: (kind: string, key: string | null = null) =>
    ["crm", "sms", "templates", kind, key] as const,
};

export type SmsKey =
  | typeof smsKeys.all
  | ReturnType<(typeof smsKeys)["conversations"]>
  | ReturnType<(typeof smsKeys)["conversation"]>
  | ReturnType<(typeof smsKeys)["unread"]>
  | ReturnType<(typeof smsKeys)["templates"]>;

/** Polling cadence while the tab is visible (`refetchIntervalInBackground: false`). */
export const CONVERSATIONS_POLL_MS = 30_000;
export const THREAD_POLL_MS = 20_000;
