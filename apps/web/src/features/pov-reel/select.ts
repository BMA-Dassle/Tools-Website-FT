/**
 * WHO GETS ON THE WALL — the pure half of the highlight reel's selection.
 *
 * Every rule here exists because getting it wrong puts the wrong footage on a
 * public screen, so each one is stated and tested rather than inferred:
 *
 *  1. TIER comes from the heat NAME, and "intermediate" must be tested BEFORE
 *     "pro" (the venue writes "Intermediate", and a naive `includes("pro")`
 *     would never see it). Same order as briefing/types.ts tierForRaceType.
 *  2. JUNIORS ARE EXCLUDED SEPARATELY. "Junior Pro" and "Junior Intermediate"
 *     both pass a naive tier test — this is the single easiest way to end up
 *     putting a child's footage on a marketing wall.
 *  3. A CAUTION CANNOT REACH THE REEL, structurally. We rank on each racer's
 *     FASTEST lap, and a lap run under a yellow is never anyone's fastest. That
 *     is why there is no yellow-flag filter here: the ranking is the filter.
 *     (Measured 2026-08-17: pixel-motion detection scored a known yellow-flag
 *     clip at the 69th percentile of its own race — it cannot see cautions.)
 *  4. THE VIDEO MUST COVER THE RACE. A camera mounted late or pulled early
 *     produces a file shorter than the race it claims to show; live candidate
 *     NY8G4JUHFD was a 191s video of a 501s race. Reject, never clamp.
 *
 * The per-tier split is applied last so one dominant tier cannot take every
 * slot — Pro cutoffs are ~8.5s faster than Intermediate on Blue, so a straight
 * top-10 would be all Pro on any night Pro runs at all.
 */

export type ReelTier = "pro" | "intermediate";

/** One racer's best lap, as the reel considers it. Structural so this module
 *  stays free of a server-only import. */
export interface ReelCandidate {
  sessionId: string;
  racerName: string;
  kart: string | null;
  bestLapMs: number;
  /** Epoch ms of the line crossing that COMPLETED the best lap. */
  bestLapAtMs: number;
  /** The venue's heat name, e.g. "60 - Red Intermediate". */
  heatName: string | null;
  /** Video, if one has been matched and is unlocked. */
  videoCode?: string | null;
  /** Seconds — VT3's own duration for the matched video. */
  videoDurationS?: number | null;
  /** Seconds — wall-clock length of the race, from race_timings. */
  raceDurationS?: number | null;
  /** From race_timings; > 0 means the race was stopped. */
  pauseCount?: number;
  /** True when staff blocked this heat, e.g. reason "Crash". */
  blocked?: boolean;
}

export interface RejectedCandidate {
  candidate: ReelCandidate;
  reason:
    | "no-heat-name"
    | "junior"
    | "wrong-tier"
    | "race-stopped"
    | "staff-blocked"
    | "no-video"
    | "video-does-not-cover-race";
}

export interface ReelSelection {
  picked: Array<ReelCandidate & { tier: ReelTier; rank: number }>;
  rejected: RejectedCandidate[];
}

/**
 * "60 - Red Intermediate" → "Red Intermediate". Mirrors
 * results-board.ts raceTypeFromHeatName: a name with no " - " separator is a
 * group or custom event and yields null, which is the correct "no tier" answer
 * rather than a guess.
 */
export function raceTypeFromHeatName(heatName: string | null | undefined): string | null {
  if (!heatName) return null;
  const idx = heatName.indexOf(" - ");
  if (idx === -1) return null;
  const type = heatName.slice(idx + 3).trim();
  return type.length > 0 ? type : null;
}

/** True for any junior race, whatever its tier. Checked BEFORE tier — see the
 *  header. Kept separate from tier so the reason survives into the audit. */
export function isJuniorRace(raceType: string): boolean {
  return raceType.toLowerCase().includes("junior");
}

/**
 * The reel's tier for a race type, or null if it is neither Pro nor
 * Intermediate. Intermediate is tested first — deliberately, and pinned by test.
 */
export function reelTierFor(raceType: string): ReelTier | null {
  const n = raceType.toLowerCase();
  if (n.includes("intermediate")) return "intermediate";
  if (n.includes("pro")) return "pro";
  return null; // Starter and anything unrecognised
}

/**
 * Does this video actually contain the race it is paired to?
 *
 * A file shorter than its race cannot contain it, whatever the padding. Unknown
 * durations pass — we only reject on evidence, because a missing duration is an
 * absent fact rather than a bad one.
 */
export function videoCoversRace(c: ReelCandidate): boolean {
  const v = c.videoDurationS;
  const r = c.raceDurationS;
  if (typeof v !== "number" || typeof r !== "number") return true;
  if (v <= 0 || r <= 0) return true;
  return v >= r;
}

/**
 * Rank and split. `perTier` slots each of Pro and Intermediate.
 *
 * `backfill` decides what happens when one tier cannot fill its half — which is
 * not hypothetical: a survey of 199 unlocked videos over 3 days produced 44
 * eligible candidates and NOT ONE was Pro. With backfill on, the spare slots go
 * to the other tier so the wall still shows ten clips.
 */
export function selectReel(
  candidates: readonly ReelCandidate[],
  opts: { perTier?: number; backfill?: boolean } = {},
): ReelSelection {
  const perTier = opts.perTier ?? 5;
  const backfill = opts.backfill ?? true;

  const rejected: RejectedCandidate[] = [];
  const eligible: Array<ReelCandidate & { tier: ReelTier }> = [];

  for (const c of candidates) {
    const raceType = raceTypeFromHeatName(c.heatName);
    if (!raceType) {
      rejected.push({ candidate: c, reason: "no-heat-name" });
      continue;
    }
    if (isJuniorRace(raceType)) {
      rejected.push({ candidate: c, reason: "junior" });
      continue;
    }
    const tier = reelTierFor(raceType);
    if (!tier) {
      rejected.push({ candidate: c, reason: "wrong-tier" });
      continue;
    }
    if ((c.pauseCount ?? 0) > 0) {
      rejected.push({ candidate: c, reason: "race-stopped" });
      continue;
    }
    if (c.blocked) {
      rejected.push({ candidate: c, reason: "staff-blocked" });
      continue;
    }
    if (!c.videoCode) {
      rejected.push({ candidate: c, reason: "no-video" });
      continue;
    }
    if (!videoCoversRace(c)) {
      rejected.push({ candidate: c, reason: "video-does-not-cover-race" });
      continue;
    }
    eligible.push({ ...c, tier });
  }

  // Fastest first, and stable on ties so a rebuild does not reshuffle the wall.
  eligible.sort((a, b) => a.bestLapMs - b.bestLapMs || a.racerName.localeCompare(b.racerName));

  // ONE CLIP PER RACER. A driver who tops both the day and the week would
  // otherwise appear twice in a ten-clip loop, which reads as a bug.
  const seen = new Set<string>();
  const unique = eligible.filter((c) => {
    const key = c.racerName.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const pro = unique.filter((c) => c.tier === "pro");
  const inter = unique.filter((c) => c.tier === "intermediate");
  const take = [...pro.slice(0, perTier), ...inter.slice(0, perTier)];

  if (backfill && take.length < perTier * 2) {
    const chosen = new Set(take);
    for (const c of unique) {
      if (take.length >= perTier * 2) break;
      if (!chosen.has(c)) take.push(c);
    }
  }

  // Presented fastest-first regardless of which tier filled the slot.
  take.sort((a, b) => a.bestLapMs - b.bestLapMs || a.racerName.localeCompare(b.racerName));
  return {
    picked: take.map((c, i) => ({ ...c, rank: i + 1 })),
    rejected,
  };
}
