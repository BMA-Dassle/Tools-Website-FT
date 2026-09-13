/**
 * React Query keys for the email sub (brief §3.4). CLIENT-SAFE — no imports.
 * Components import this file by path, never the sub's server barrel.
 */

export const emailKeys = {
  all: ["crm", "email"] as const,
  context: (leadId: string) => ["crm", "email", "context", leadId] as const,
  threads: () => ["crm", "email", "threads"] as const,
};

export type EmailKey =
  | typeof emailKeys.all
  | ReturnType<(typeof emailKeys)["context"]>
  | ReturnType<(typeof emailKeys)["threads"]>;

/** Inbound mail arrives by webhook, so the tab only needs a lazy poll. */
export const EMAIL_POLL_MS = 60_000;
