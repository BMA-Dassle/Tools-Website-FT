/**
 * VIP movement alerts — orchestrator for the every-minute cron.
 *
 * Loads today's VIP combos through the SAME pipeline as the admin
 * reservations board (live BMI heats -> Pandora race truth -> QAMF lane ->
 * buildComboGroups), detects cross-center movements, and posts one combined
 * Adaptive Card per direction to the staff Teams chat via the portal bot.
 *
 * Anti-spam is layered and deliberately conservative (this is a BETA
 * convenience alert — a missed card always beats a flood):
 *   1. fire-once Redis NX key per combo+direction+day,
 *   2. dedup FAILS CLOSED (Redis error -> treat as already sent),
 *   3. a failed Teams send never releases keys (no cross-tick retry spam),
 *   4. one card per direction per tick,
 *   5. daily send-cap valve,
 *   6. VIP_MOVE_ALERTS_ENABLED=false kill switch (checked by the route).
 */
import { listVipComboReservations } from "@/lib/bowling-db";
import { getReservation } from "@/lib/qamf-bowling";
import redis from "@/lib/redis";
import { sendAdaptiveCardToChannel, updateAdaptiveCard } from "@/lib/teams-bot";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { buildComboGroups, type ComboGroup } from "~/features/reservations-admin/combo-board";
import { nowEtWallMs, todayET } from "~/features/reservations-admin/format";
import {
  attachRaceLiveState,
  fetchLiveHeats,
  type LiveHeat,
} from "~/features/reservations-admin/race-live-state.server";
import type { ComboMeta, Reservation } from "~/features/reservations-admin/types";
import { DAILY_SEND_CAP, DEDUP_TTL_S, vipBoardUrl, vipMoveAlertsChatId } from "./config";
import { detectPendingMoves, refreshMoves, type MoveDirection, type PendingMove } from "./detect";
import { buildMoveCard, moveSummaryText } from "./teams-card";

/** QAMF numeric center ids — both center_code namespaces (Square location
 *  IDs and center slugs; combo bowling legs store the slug). */
const QAMF_CENTER_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172, // HeadPinz Fort Myers
  PPTR5G2N0QXF7: 3148, // HeadPinz Naples
  "fort-myers": 9172,
  naples: 3148,
};

/** A posted movement card being kept fresh: the cron edits its countdown in
 *  place each tick until the next activity's start passes, then freezes it. */
interface LiveCardRecord {
  conversationId: string;
  activityId: string;
  direction: MoveDirection;
  moves: PendingMove[];
  sentAtMs: number;
}
const liveCardKey = (ymd: string, activityId: string) => `vip-move:live-card:${ymd}:${activityId}`;
/** Stop refreshing after this long even if the next step never resolves
 *  (e.g. a pending qualify-gated intermediate that never gets booked). */
const LIVE_CARD_MAX_AGE_MS = 2 * 60 * 60_000;

export interface RunResult {
  date: string;
  combos: number;
  movesDetected: number;
  /** Compact view of every detected move — dry-run inspection + cron logs. */
  detected: Array<{
    direction: MoveDirection;
    party: string;
    from: string;
    to: string;
    endingSoon?: boolean;
  }>;
  sent: Array<{ direction: MoveDirection; parties: string[]; activityId?: string }>;
  skippedDedup: number;
  /** Posted cards whose countdown line was edited this tick. */
  cardsRefreshed: number;
  dryRun: boolean;
  errors: string[];
}

/** Today's combo groups through the board's exact enrichment pipeline.
 *  Exported for the dry-run probe so detection can be compared step-for-step
 *  against the admin board. */
export async function loadTodayComboGroups(ymd: string, nowMs: number): Promise<ComboGroup[]> {
  const vipReservations = await listVipComboReservations({ startDate: ymd, endDate: ymd });
  if (!vipReservations.length) return [];

  // Live heat lines from BMI for each race leg — office reschedules make the
  // booking_metadata times stale. Copy: raceState gets stamped per run and
  // the cache entry is shared — never mutate it.
  await Promise.all(
    vipReservations.map(async (r) => {
      if (r.productKind !== "race" || !r.bmiBillId || r.status === "cancelled") return;
      const heats = await fetchLiveHeats(r.bmiBillId);
      if (heats && heats.length) {
        (r as { liveHeats?: LiveHeat[] }).liveHeats = heats.map((h) => ({ ...h }));
      }
    }),
  );

  // Live track truth (Pandora actualStart/actualEnd + called watermark).
  await attachRaceLiveState(
    vipReservations
      .filter((r) => r.productKind === "race")
      .map((r) => r as { liveHeats?: LiveHeat[] }),
    ymd,
  );

  // Lane for upcoming bowling legs — dayof_order_lane is only persisted at
  // lane-open, but the VIP lane is already reserved in QAMF. Best-effort.
  await Promise.all(
    vipReservations.map(async (r) => {
      if (
        (r.productKind !== "open" && r.productKind !== "kbf") ||
        r.dayofOrderLane ||
        !r.qamfReservationId
      )
        return;
      const centerId = QAMF_CENTER_ID[r.centerCode];
      if (!centerId) return;
      try {
        const qr = await getReservation(centerId, r.qamfReservationId);
        const lanes = (qr.Lanes ?? [])
          .map((l) => l.LaneNumber)
          .filter((n): n is number => typeof n === "number");
        if (lanes.length) r.dayofOrderLane = lanes.join(", ");
      } catch {
        /* non-fatal — lane just stays blank on the card */
      }
    }),
  );

  const comboMeta: Record<string, ComboMeta> = {};
  for (const r of vipReservations) {
    const id = r.comboSpecialId;
    if (!id || comboMeta[id]) continue;
    const combo = getComboSpecial(id);
    if (combo) {
      const bowlingLeg = combo.components.find((c) => c.kind === "bowling");
      comboMeta[id] = {
        name: combo.name,
        accentColor: combo.accentColor,
        includes: combo.includes,
        center: combo.center,
        bowlingDurationMinutes: bowlingLeg?.durationMinutes,
      };
    }
  }

  // Same structural bridge the board uses: the Neon rows are camelCase and
  // carry every field buildComboGroups touches.
  return buildComboGroups(vipReservations as unknown as Reservation[], comboMeta, nowMs);
}

/** Fire-once claim. FAILS CLOSED — on a Redis error we suppress rather than
 *  risk re-sending every tick until Redis recovers (inverse of the
 *  group-function shouldAlert trade-off, on purpose). */
async function claimOnce(key: string): Promise<boolean> {
  try {
    return (await redis.set(key, "1", "EX", DEDUP_TTL_S, "NX")) === "OK";
  } catch (err) {
    console.warn("[vip-move] redis dedup failed (suppressing send):", err);
    return false;
  }
}

/** Daily cap valve — also fails closed. */
async function underDailyCap(ymd: string): Promise<boolean> {
  try {
    const key = `vip-move:sent:${ymd}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, DEDUP_TTL_S);
    if (n > DAILY_SEND_CAP) {
      console.error(`[vip-move] daily send cap hit (${n} > ${DAILY_SEND_CAP}) — suppressing`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[vip-move] redis cap check failed (suppressing send):", err);
    return false;
  }
}

/** Edit every live card's countdown to match the current clock/schedule.
 *  A card freezes (final edit + record deleted) once its countdown reaches
 *  zero — every NEW movement still gets its own new card; this only keeps
 *  the "Next activity starts in Xm" line honest on already-posted ones. */
async function refreshLiveCards(
  ymd: string,
  groups: ComboGroup[],
  nowMs: number,
  result: RunResult,
): Promise<void> {
  let keys: string[] = [];
  try {
    keys = await redis.keys(`vip-move:live-card:${ymd}:*`);
  } catch {
    return; // next tick retries
  }
  for (const key of keys) {
    try {
      const raw = await redis.get(key);
      if (!raw) continue;
      const rec = JSON.parse(raw) as LiveCardRecord;
      const { moves, settled } = refreshMoves(rec.moves, groups, nowMs);
      const expired = Date.now() - rec.sentAtMs > LIVE_CARD_MAX_AGE_MS;
      const upd = await updateAdaptiveCard(
        rec.conversationId,
        rec.activityId,
        buildMoveCard(rec.direction, moves, nowMs, { boardUrl: vipBoardUrl() }),
      );
      if (upd.ok) result.cardsRefreshed++;
      else console.warn(`[vip-move] card refresh failed (${upd.status}):`, upd.error);
      // Frozen: countdown done (or record aged out) — final state is on the
      // card; delete the record so this card is never edited again.
      if (settled || expired) await redis.del(key);
    } catch (err) {
      console.warn("[vip-move] card refresh error:", err instanceof Error ? err.message : err);
    }
  }
}

const describe = (m: PendingMove) => ({
  direction: m.direction,
  party: m.playerCount ? `${m.guestName} (${m.playerCount})` : m.guestName,
  from: `${m.from.label} @ ${m.from.iso ?? "?"}`,
  to: `${m.to.label} @ ${m.to.iso ?? "TBD"}`,
  ...(m.endingSoon ? { endingSoon: true } : {}),
});

export async function runVipMoveAlerts(opts?: { dryRun?: boolean }): Promise<RunResult> {
  const dryRun = opts?.dryRun ?? false;
  const ymd = todayET();
  const nowMs = nowEtWallMs();
  const result: RunResult = {
    date: ymd,
    combos: 0,
    movesDetected: 0,
    detected: [],
    sent: [],
    skippedDedup: 0,
    cardsRefreshed: 0,
    dryRun,
    errors: [],
  };

  const groups = await loadTodayComboGroups(ymd, nowMs);
  result.combos = groups.length;

  // Keep already-posted cards' countdowns honest (edits in place; new
  // movements below still get their own new cards). Not in dry runs.
  if (!dryRun) await refreshLiveCards(ymd, groups, nowMs, result);

  if (!groups.length) return result;

  const moves = detectPendingMoves(groups, nowMs);
  result.movesDetected = moves.length;
  result.detected = moves.map(describe);
  if (!moves.length || dryRun) return result;

  // Claim every move's key FIRST (including combine-window riders), then send
  // one card per direction with only the claimed ones.
  const claimed: PendingMove[] = [];
  for (const m of moves) {
    if (await claimOnce(`vip-move:${ymd}:${m.groupKey}:${m.direction}`)) claimed.push(m);
    else result.skippedDedup++;
  }
  if (!claimed.length) return result;

  const byDirection = new Map<MoveDirection, PendingMove[]>();
  for (const m of claimed) {
    const arr = byDirection.get(m.direction) ?? [];
    arr.push(m);
    byDirection.set(m.direction, arr);
  }

  for (const [direction, dirMoves] of byDirection) {
    if (!(await underDailyCap(ymd))) break;
    const chatId = vipMoveAlertsChatId();
    try {
      const res = await sendAdaptiveCardToChannel(
        chatId,
        buildMoveCard(direction, dirMoves, nowMs, { boardUrl: vipBoardUrl() }),
        { summaryText: moveSummaryText(direction, dirMoves) },
      );
      result.sent.push({
        direction,
        parties: dirMoves.map((m) => m.guestName),
        activityId: res.id,
      });
      // Record for the countdown refresher — best-effort; without it the
      // card simply keeps its as-sent countdown.
      try {
        const rec: LiveCardRecord = {
          conversationId: chatId,
          activityId: res.id,
          direction,
          moves: dirMoves,
          sentAtMs: Date.now(),
        };
        await redis.set(liveCardKey(ymd, res.id), JSON.stringify(rec), "EX", 6 * 3600);
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      // Keys stay claimed on purpose — see the anti-spam contract up top.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vip-move] Teams send failed (${direction}):`, msg);
      result.errors.push(`${direction}: ${msg}`);
    }
  }

  return result;
}
