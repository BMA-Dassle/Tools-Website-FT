/**
 * `~/features/crm/reps` — the roster. Other subs import THIS, never the data
 * file (brief §3.2 import rules). Client components import `./queries` by path.
 */
export {
  ensureRepsSchema,
  findRepByLoginEmail,
  listRepLogins,
  listReps,
  mapRepRow,
  seedRepLogins,
  seedReps,
  setRepLogin,
  type RepLoginRow,
  type RepRowRaw,
  type RepSeed,
} from "./data/reps-db";
export {
  assignableReps,
  listRoster,
  publicRep,
  publicRoster,
  repBySlug,
  type RosterFilter,
} from "./service/roster";
export {
  RepIdSchema,
  RepRoleSchema,
  RepSlugSchema,
  RosterQuerySchema,
  type RosterQuery,
} from "./schemas";
export { repsKeys, type RepsKey } from "./queries";
