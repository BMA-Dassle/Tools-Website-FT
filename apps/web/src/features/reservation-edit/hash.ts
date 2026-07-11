/**
 * Plan hashing — the "displayed == executed" seal.
 *
 * The dry-run returns a plan + its hash; execution requires the hash, rebuilds
 * the plan fresh, and refuses (plan_stale) when the hashes differ. Canonical
 * JSON (recursively key-sorted) makes the hash independent of property
 * insertion order, so a semantically identical plan always hashes the same.
 */

import { createHash } from "crypto";

/** Recursively key-sorted JSON. Arrays keep their order (it is meaningful). */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    // undefined inside arrays serializes as null (JSON.stringify parity).
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
};

/** sha256 hex of the canonical JSON. */
export const planHash = (plan: unknown): string =>
  createHash("sha256").update(canonicalJson(plan)).digest("hex");
