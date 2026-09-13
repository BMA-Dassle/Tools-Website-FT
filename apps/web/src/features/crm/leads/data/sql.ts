/**
 * SQL fragments shared by the leads sub's data modules.
 *
 * Lives in its own file rather than in `leads-db.ts` because `leads-db`
 * imports `contacts-db` / `accounts-db` for their `ensure*Schema()`, so the
 * helper cannot travel the other way without a cycle.
 */

/**
 * `TIMESTAMPTZ` → ISO-8601 UTC text, so `new Date()` on the client is exact.
 *
 * Neon renders a bare `::text` cast in Postgres' own format
 * (`2026-09-13 12:34:56.789+00`), which `new Date()` parses differently across
 * engines and which is NOT what `CrmLead.createdAt` / `CrmContact.createdAt`
 * and friends are typed as. Every reader in the sub emits this instead.
 */
export const ISO = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
