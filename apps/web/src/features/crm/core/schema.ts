/**
 * `ensureCrmSchema()` — every sub's `ensureSchema`, awaited once (brief §3.8).
 *
 * Used by the jobs runner and the seed only; normal reads call their own sub's
 * `ensureSchema`. The server agent appends one line per sub as it lands the
 * `data/*-db.ts` files; order matters only where a table references another
 * (reps before leads, statuses before leads, leads before activities).
 */

import { isDbConfigured } from "@ft/db";
import { ensureRepsSchema } from "~/features/crm/reps";

let ready: Promise<void> | null = null;

export function ensureCrmSchema(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve();
  ready ??= (async () => {
    await ensureRepsSchema();
  })();
  return ready;
}
