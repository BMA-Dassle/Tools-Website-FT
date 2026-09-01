/**
 * Lane blocks — the physical constraint the whole feature exists to model.
 *
 * A block is a set of lanes that SHARE ONE TV. Whoever claims a block first
 * fixes what it shows for that whole window, so a block can serve exactly one
 * game at a time. Two VIP blocks at Fort Myers therefore means at most two games
 * on the VIP side at once, which is the rule the owner described.
 *
 * Nothing in this repo modelled lane grouping before — no lane-pair, no
 * lane-block, no TV-per-lane concept anywhere. This file is that model.
 *
 * Lane numbers verified against QAMF center 9172 on 2026-08-25: the center has
 * lanes 1-28, and four probe holds on the VIP web offer were auto-assigned to
 * lanes 5, 8 and 9, while a PATCH moving one onto regular lane 20 was refused
 * `409 LanesNotCompatible`. So the VIP lane group really is 5-12, and a booking
 * made against the VIP offer can never escape it.
 */

import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";

export type NflBlockKind = "vip" | "regular";

export interface NflLaneBlock {
  /** Stable id, persisted in the claim ledger. Never renumber. */
  id: string;
  /** QAMF center id this block belongs to. */
  centerId: number;
  /** Square center code, for joining to the bowling catalog. */
  centerCode: string;
  /** Staff-facing name. Never shown to guests — see the note below. */
  label: string;
  /** Physical lanes sharing the TV, ascending. */
  lanes: number[];
  kind: NflBlockKind;
  /**
   * Sellable? Regular-lane blocks are modelled but OFF: the owner held them
   * back on 2026-08-25 ("hold on regular because we have some optional
   * issues"). They are here so the ledger, the ops board and the allocator all
   * already understand them — turning them on is a data + Conqueror job, not a
   * restructure.
   */
  enabled: boolean;
}

const FM = 9172;

/**
 * HeadPinz Fort Myers. Lanes 1-4 are Old Time / PinBoyz, 5-12 VIP, 13-28
 * regular. Regular lanes pair up per TV, which is why the disabled blocks come
 * in twos rather than fours.
 */
const FORT_MYERS: NflLaneBlock[] = ([
  { id: "fm-vip-a", label: "VIP A (5-8)", lanes: [5, 6, 7, 8], kind: "vip", enabled: true },
  { id: "fm-vip-b", label: "VIP B (9-12)", lanes: [9, 10, 11, 12], kind: "vip", enabled: true },
  // ── Regular pairs: modelled, NOT sellable (see NflLaneBlock.enabled) ──
  { id: "fm-reg-1", label: "Lanes 13-14", lanes: [13, 14], kind: "regular", enabled: false },
  { id: "fm-reg-2", label: "Lanes 15-16", lanes: [15, 16], kind: "regular", enabled: false },
  { id: "fm-reg-3", label: "Lanes 17-18", lanes: [17, 18], kind: "regular", enabled: false },
  { id: "fm-reg-4", label: "Lanes 19-20", lanes: [19, 20], kind: "regular", enabled: false },
  { id: "fm-reg-5", label: "Lanes 21-22", lanes: [21, 22], kind: "regular", enabled: false },
  { id: "fm-reg-6", label: "Lanes 23-24", lanes: [23, 24], kind: "regular", enabled: false },
  { id: "fm-reg-7", label: "Lanes 25-26", lanes: [25, 26], kind: "regular", enabled: false },
  { id: "fm-reg-8", label: "Lanes 27-28", lanes: [27, 28], kind: "regular", enabled: false },
] as const satisfies ReadonlyArray<Omit<NflLaneBlock, "centerId" | "centerCode">>).map(
  (b): NflLaneBlock => ({ ...b, lanes: [...b.lanes], centerId: FM, centerCode: QAMF_TO_CENTER_CODE[FM] }),
);

/**
 * Every block we know about, by QAMF center id.
 *
 * Naples is deliberately absent. Its VIP lane numbers are not recorded anywhere
 * in this repo, and its lane-group mapping fought the World Cup rollout for
 * days. Adding it is a probe plus an entry here — not a code change anywhere
 * else.
 */
export const NFL_BLOCKS_BY_CENTER: Record<number, NflLaneBlock[]> = {
  [FM]: FORT_MYERS,
};

/** Sellable blocks at a center, in allocation order. */
export function blocksForCenter(centerId: number): NflLaneBlock[] {
  return (NFL_BLOCKS_BY_CENTER[centerId] ?? []).filter((b) => b.enabled);
}

/** Every block at a center, including the ones held back — for the ops board. */
export function allBlocksForCenter(centerId: number): NflLaneBlock[] {
  return NFL_BLOCKS_BY_CENTER[centerId] ?? [];
}

export function blockById(blockId: string): NflLaneBlock | null {
  for (const blocks of Object.values(NFL_BLOCKS_BY_CENTER)) {
    const hit = blocks.find((b) => b.id === blockId);
    if (hit) return hit;
  }
  return null;
}

/** Which block owns a physical lane, or null when it is outside every block. */
export function blockForLane(centerId: number, laneNumber: number): NflLaneBlock | null {
  return allBlocksForCenter(centerId).find((b) => b.lanes.includes(laneNumber)) ?? null;
}

/** Most lanes one booking may take: a single block. */
export function maxLanesPerBooking(centerId: number): number {
  const blocks = blocksForCenter(centerId);
  return blocks.length ? Math.max(...blocks.map((b) => b.lanes.length)) : 0;
}

/**
 * Concurrent games a center can show on sellable blocks.
 *
 * Falls out of the block count rather than being configured separately — with
 * two VIP blocks the answer is two, and it becomes six the day the regular
 * pairs are switched on, with nothing else to change.
 */
export function maxConcurrentGames(centerId: number): number {
  return blocksForCenter(centerId).length;
}
