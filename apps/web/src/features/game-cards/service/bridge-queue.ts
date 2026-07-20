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
 * Per-center bridge liveness for the reload UI ("instant loading" vs "may
 * take a few minutes"). Fails closed to false — a dead Redis just means the
 * softer wording shows.
 */
export async function bridgeStatus(): Promise<Record<string, boolean>> {
  const codes = Object.keys(CENTERS).map(Number);
  const out: Record<string, boolean> = {};
  for (const c of codes) out[String(c)] = false;
  try {
    const vals = await redis.mget(...codes.map(heartbeatKey));
    codes.forEach((c, i) => {
      const t = vals[i] ? Date.parse(vals[i] as string) : NaN;
      out[String(c)] = Number.isFinite(t) && Date.now() - t < BRIDGE_ALIVE_MS;
    });
  } catch {
    /* fail closed */
  }
  return out;
}

/**
 * Centers where web reloads ride the bridge queue. Flag env
 * GAME_CARD_EIS_QUEUE_CENTERS is a comma list of Intercard location codes
 * ("13" pilot → "12,6,13" full); unset/empty = v1 SOAP path everywhere.
 */
export function eisQueueCenters(): Set<number> {
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
