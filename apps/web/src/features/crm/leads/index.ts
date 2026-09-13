/**
 * `~/features/crm/leads` — DDL only in PR1. B3 adds `service/create-lead.ts`,
 * `assign.ts`, `response-time.ts`, `mint.ts`, `schemas.ts`, `queries.ts`.
 */
export { ensureAccountsSchema } from "./data/accounts-db";
export { ensureContactsSchema } from "./data/contacts-db";
export { ensureLeadsSchema } from "./data/leads-db";
export { ensureAssignmentsSchema } from "./data/assignments-db";
