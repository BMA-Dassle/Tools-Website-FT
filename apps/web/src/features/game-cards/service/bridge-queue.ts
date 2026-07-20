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
import { isValidLocationCode } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { BridgeAckInput, BridgeClaimInput } from "../schemas";
import { ackQueuedJob, claimQueuedJobs, type BridgeJob } from "../data/transactions-log";

/** Lease a claim grants before the cron flips it to 'verify'; echoed to the bridge. */
export const CLAIM_LEASE_MS = 180_000;

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
  const jobs = await claimQueuedJobs(input.locationCode, input.workerId, input.max);
  return { jobs, leaseMs: CLAIM_LEASE_MS };
}

export async function ackJob(input: BridgeAckInput): Promise<{ applied: boolean }> {
  return ackQueuedJob(input);
}
