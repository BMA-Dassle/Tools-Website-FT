/**
 * Web-reload → on-prem EIS bridge queue (claim/ack service + rollout flag).
 *
 * WHY: the cloud SOAP credit (TPICreditAccounts) reaches the data center
 * instantly but propagates to each center's on-prem transaction server slowly
 * — the guest reloads online and the card doesn't work on the game floor yet.
 * The EIS credit on the center LAN is immediate, but nothing in the cloud can
 * reach that LAN. So the purchase enqueues (markChargedQueued) and the
 * game-card-bridge on each center's kiosk PC polls OUTBOUND: claim → local
 * EIS credit → ack. No inbound connection to a center exists anywhere.
 *
 * SAFETY: the EIS credit carries NO idempotency id; the SOAP path dedups on
 * tpi_transaction_id. A row is EIS-eligible only while 'claimed' (one bridge,
 * FOR UPDATE SKIP LOCKED) and SOAP-eligible only while queue_state IS NULL or
 * 'soap_fallback' — disjoint sets, one guarded UPDATE per transition. See the
 * state table in data/transactions-log.ts.
 */
import redis from "@/lib/redis";
import { CENTERS, isValidLocationCode } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { BridgeAckInput, BridgeClaimInput } from "../schemas";
import { ackQueuedJob, claimQueuedJobs, type BridgeJob } from "../data/transactions-log";

/** Lease a claim grants before the cron flips it to 'verify'; echoed to the bridge. */
export const CLAIM_LEASE_MS = 180_000;

/** A bridge is "alive" if it claim-polled within this window (poll is ~2.5s). */
const BRIDGE_ALIVE_MS = 30_000;
const heartbeatKey = (code: number) => `gc:bridge:last-claim:${code}`;

/** Best-effort liveness heartbeat — every authenticated claim stamps it. */
async function heartbeat(locationCode: number): Promise<void> {
  try {
    await redis.set(heartbeatKey(locationCode), new Date().toISOString(), "EX", 300);
  } catch {
    /* liveness display only — never block a claim on Redis */
  }
}

/**
 * Per-center "instant loading" truth for the reload UI: the bridge must be
 * ALIVE (heartbeat < 30s) AND the center must be in the queue flag — a live
 * bridge at a non-flagged center gets no jobs, so promising "instant" there
 * would be a lie. Fails closed to false — a dead Redis just means the softer
 * wording shows.
 */
export async function bridgeStatus(): Promise<Record<string, boolean>> {
  const codes = Object.keys(CENTERS).map(Number);
  const flagged = eisQueueCenters();
  const out: Record<string, boolean> = {};
  for (const c of codes) out[String(c)] = false;
  try {
    const vals = await redis.mget(...codes.map(heartbeatKey));
    codes.forEach((c, i) => {
      const t = vals[i] ? Date.parse(vals[i] as string) : NaN;
      out[String(c)] = Number.isFinite(t) && Date.now() - t < BRIDGE_ALIVE_MS && flagged.has(c);
    });
  } catch {
    /* fail closed */
  }
  return out;
}

export type IntercardLoadMode = "cloud" | "local" | "auto";

/**
 * Global Intercard load-path override — the master switch over the per-center
 * GAME_CARD_EIS_QUEUE_CENTERS list. Mirror the SAME value into the client via
 * NEXT_PUBLIC_INTERCARD_LOAD_MODE so the kiosk shim agrees (see
 * features/kiosk/service/game-card-bridge.ts).
 *
 *   cloud — force cloud SOAP EVERYWHERE (web skips the queue; the kiosk stops
 *           dialing the on-prem bridge). The bridge becomes removable — use this
 *           before the card-consolidation project, since the local EIS path can
 *           only load tokens (no consolidate / clear).
 *   local — force local EIS everywhere (all valid centers queue web reloads; the
 *           kiosk dials the bridge).
 *   auto  — default / unset: per-center behavior via GAME_CARD_EIS_QUEUE_CENTERS.
 *
 * The cloud SOAP fallback is NEVER disabled by this flag — it only picks the
 * PREFERRED path, never the recover-forward safety net (paid tokens always land).
 */
export function intercardLoadMode(): IntercardLoadMode {
  const v = (process.env.INTERCARD_LOAD_MODE || "").trim().toLowerCase();
  return v === "cloud" || v === "local" ? v : "auto";
}

/**
 * Centers where web reloads ride the bridge queue (local EIS). Resolution:
 *   - INTERCARD_LOAD_MODE=cloud → ∅ (cloud SOAP everywhere)
 *   - INTERCARD_LOAD_MODE=local → every valid center
 *   - otherwise → GAME_CARD_EIS_QUEUE_CENTERS, a comma list of location codes
 *     ("13" pilot → "12,6,13" full); unset/empty = SOAP path everywhere.
 */
export function eisQueueCenters(): Set<number> {
  const mode = intercardLoadMode();
  if (mode === "cloud") return new Set<number>();
  if (mode === "local") return new Set<number>(Object.keys(CENTERS).map(Number));

  const raw = process.env.GAME_CARD_EIS_QUEUE_CENTERS || "";
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && isValidLocationCode(n)) out.add(n);
  }
  return out;
}

export function isEisQueueCenter(code: number): boolean {
  return eisQueueCenters().has(code);
}

export async function claimJobs(
  input: BridgeClaimInput,
): Promise<{ jobs: BridgeJob[]; leaseMs: number }> {
  if (!isValidLocationCode(input.locationCode)) {
    throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Unknown location code.");
  }
  await heartbeat(input.locationCode);
  const jobs = await claimQueuedJobs(input.locationCode, input.workerId, input.max);
  return { jobs, leaseMs: CLAIM_LEASE_MS };
}

export async function ackJob(input: BridgeAckInput): Promise<{ applied: boolean }> {
  return ackQueuedJob(input);
}
