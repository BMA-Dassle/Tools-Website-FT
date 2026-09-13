/**
 * REP TEXTING NUMBERS — the union of active `crm_reps.vox_did`.
 *
 * Rep DIDs live in `crm_reps.vox_did` ONLY (R8). They are deliberately NOT
 * added to `SMS_A2P_DID`: `src/features/sms/sender.ts:58-72` makes that env
 * list's FIRST entry the A2P sender for every automated message and treats
 * every entry as an inbound DID, so putting a rep's number there would change
 * production sending behaviour, not just a registry. Instead the inbound route
 * UNIONS this list into `allowedDids()` at request time — a number provisioned
 * in the Vox portal starts being accepted the moment the director stores it,
 * with no deploy.
 *
 * FAILS SOFT ON PURPOSE. If Neon is unreachable this returns an empty list, so
 * `allowedDids()` degrades to exactly today's behaviour (the A2P DID) and a
 * STOP still reaches the consent ledger. A thrown error here would 500 the
 * webhook, Vox would retry, and a retried STOP is the one thing the inbound
 * handler must never see twice.
 *
 * The 60-second cache is per process and per lambda instance; it exists so a
 * burst of inbound messages does not become a burst of queries, not as a
 * correctness device.
 */

import { isDbConfigured, sql } from "@ft/db";
import { canonicalizePhone } from "@/lib/participant-contact";
import { listReps } from "~/features/crm/reps";
import type { CrmRep } from "../../core/types";

const CACHE_MS = 60_000;

let cached: { at: number; dids: string[] } | null = null;

/** Exposed for tests: forget the cache. */
export function resetDidCache(): void {
  cached = null;
}

/** Every active rep DID, canonical E.164, de-duplicated. `[]` on any failure. */
export async function activeRepDids(now: number = Date.now()): Promise<string[]> {
  if (cached && now - cached.at < CACHE_MS) return cached.dids;
  if (!isDbConfigured()) return [];
  try {
    const q = sql();
    const rows = (await q`
      SELECT vox_did FROM crm_reps
       WHERE active AND vox_did IS NOT NULL AND vox_did <> ''
    `) as { vox_did: string }[];
    const dids: string[] = [];
    for (const r of rows) {
      const e164 = canonicalizePhone(r.vox_did);
      if (e164 && !dids.includes(e164)) dids.push(e164);
    }
    cached = { at: now, dids };
    return dids;
  } catch (err) {
    console.warn("[crm-sms] rep DID lookup failed; inbound falls back to the A2P list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** The rep who owns a DID, or null when it is the A2P number or unknown. */
export async function repForDid(did: string): Promise<CrmRep | null> {
  const e164 = canonicalizePhone(did);
  if (!e164) return null;
  const reps = await listReps();
  return reps.find((r) => r.voxDid && canonicalizePhone(r.voxDid) === e164) ?? null;
}

/** Pure: fold the env list and the roster's DIDs into one list, env first. */
export function unionDids(envDids: readonly string[], repDids: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of [...envDids, ...repDids]) {
    const e164 = canonicalizePhone(d) ?? d.trim();
    if (e164 && !out.includes(e164)) out.push(e164);
  }
  return out;
}
