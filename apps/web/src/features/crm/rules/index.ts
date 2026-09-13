/** `~/features/crm/rules` — DDL + seed only in PR1; B2 adds `service/engine.ts`, `sevenshifts.ts`, `sweep.ts`. */
export { ensureRulesSchema, seedRules, type RuleSeed } from "./data/rules-db";
export { ensureShiftsSchema } from "./data/shifts-db";
