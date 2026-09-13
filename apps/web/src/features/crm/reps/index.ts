/**
 * `~/features/crm/reps` — the roster. Other subs import THIS, never the data
 * file (brief §3.2 import rules). The server agent adds `service/roster.ts`,
 * `schemas.ts` and `queries.ts` behind this door.
 */
export {
  ensureRepsSchema,
  findRepByLoginEmail,
  listReps,
  mapRepRow,
  type RepRowRaw,
} from "./data/reps-db";
