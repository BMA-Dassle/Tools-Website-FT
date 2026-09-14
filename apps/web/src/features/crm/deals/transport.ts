/**
 * The deals sub's ONE door to the old code (brief §3.2: "Old code in
 * `apps/web/lib/*` is imported by the transport files only").
 *
 * The deal read joins three tables owned by three different places —
 * `crm_bmi_projects` (the bmi sub), `crm_leads` (the leads sub) and
 * `group_function_quotes` (v1's `lib/group-function-db`). A join cannot be
 * written conditionally, so all three must EXIST before the statement runs or
 * a fresh database answers "relation does not exist" instead of an empty list.
 *
 * Nothing is created here. Each `ensure*` belongs to the sub that owns the
 * table and is idempotent and memoised; this is the one place that says the
 * deal read needs all three of them.
 */

import { ensureGfSchema } from "@/lib/group-function-db";
import { ensureBmiProjectsSchema } from "../bmi/data/projects-mirror-db";
import { ensureLeadsSchema } from "../leads/data/leads-db";

export { ensureGfSchema };

let ready: Promise<void> | null = null;

export function ensureDealSchemas(): Promise<void> {
  ready ??= (async () => {
    await Promise.all([ensureBmiProjectsSchema(), ensureLeadsSchema(), ensureGfSchema()]);
  })();
  return ready;
}
