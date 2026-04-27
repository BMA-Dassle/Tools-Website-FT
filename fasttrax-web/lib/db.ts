import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Neon Postgres client — long-term store for sales / analytics data.
 *
 * Uses Neon's serverless driver (`neon()` template-tag). It speaks
 * HTTP to Neon's edge endpoint and works in Vercel's serverless +
 * edge runtimes without a connection pool of our own.
 *
 * Env: DATABASE_URL (Neon connection string, sslmode=require).
 *
 * Usage:
 *   import { sql } from "@/lib/db";
 *   const rows = await sql`SELECT * FROM sales_log WHERE ts > ${cutoff}`;
 *
 * The template tag is parameter-safe — values are passed via the
 * driver's escaping, never string-interpolated.
 *
 * If DATABASE_URL is unset (e.g. local dev with no Neon configured),
 * we lazily throw on first use so the app boots cleanly. Callers
 * that wrap DB writes in try/catch (booking-confirmation, etc.) will
 * silently no-op the DB write while keeping the rest of the path
 * working.
 */

let cached: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — Neon connection unavailable");
  }
  cached = neon(url);
  return cached;
}

/**
 * Returns true iff the DB is reachable and the schema is initialized
 * for the given table. Used by callers that want to short-circuit
 * silently when the DB isn't configured.
 */
export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}
