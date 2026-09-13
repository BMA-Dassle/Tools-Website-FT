/**
 * `~/features/crm/leads` — DDL from PR1. B1 adds the account / contact upserts
 * the BMI mirror links hosts through (`data/accounts-db.ts`,
 * `data/contacts-db.ts`); B3 adds `service/create-lead.ts`, `assign.ts`,
 * `response-time.ts`, `mint.ts`, `schemas.ts`, `queries.ts`.
 */
export {
  ensureAccountsSchema,
  getAccountById,
  getAccountSummary,
  mapAccountRow,
  mapAccountSummary,
  refreshAccountLifetime,
  searchAccounts,
  upsertAccountByKey,
  type AccountRowRaw,
  type AccountSearchOpts,
  type AccountSummary,
  type AccountSummaryRaw,
  type AccountUpsertInput,
} from "./data/accounts-db";
export {
  ensureContactsSchema,
  listContactsForAccount,
  mapContactRow,
  upsertContactFromBmi,
  type ContactRowRaw,
  type ContactUpsertInput,
} from "./data/contacts-db";
export { ensureLeadsSchema } from "./data/leads-db";
export { ensureAssignmentsSchema } from "./data/assignments-db";
