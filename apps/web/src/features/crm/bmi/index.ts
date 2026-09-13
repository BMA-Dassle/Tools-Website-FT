/**
 * `~/features/crm/bmi` — DDL only in PR1. B1 adds `service/mirror.ts` + `delta.ts`,
 * C5 adds `office-write.ts` (over `putProjectFields` from `lib/bmi-office-actions.ts`),
 * `builder.ts`, `availability-heats.ts` and `transport.ts`.
 */
export { ensureBmiProjectsSchema } from "./data/projects-mirror-db";
export { ensureQuoteLinesSchema } from "./data/quote-lines-db";
export { ensureQuoteTemplatesSchema } from "./data/quote-templates-db";
