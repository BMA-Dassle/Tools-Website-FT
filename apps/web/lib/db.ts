/**
 * Compatibility shim — db.ts moved to @ft/db (packages/db/) in PR6.
 *
 * Existing imports (`import { sql, isDbConfigured } from "@/lib/db"`) keep
 * working via this re-export. New code in apps/web/src/** should import
 * from `@ft/db` directly. Remove this shim when the last `@/lib/db` import
 * has migrated.
 */
export { sql, isDbConfigured } from "@ft/db";
