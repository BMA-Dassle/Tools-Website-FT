/**
 * Who levelled up in a finished session. PURE — scores in, first names out.
 *
 * The board's whole claim is "these people just earned the next level", so the
 * bar for putting a name up is: their best lap beat the cutoff for a level ABOVE
 * the one the session was run at. Both halves matter.
 *
 * WHY THE SESSION'S OWN TIER IS THE FLOOR: a Pro racer's 34-second lap in a Pro
 * heat clears the Intermediate cutoff by miles, and announcing "Marcus qualified
 * Intermediate" to a room would be both wrong and faintly insulting. The session
 * tells us where they already are; only a level above that is news.
 *
 *   Starter session       → Intermediate and Pro both count
 *   Intermediate session  → only Pro counts
 *   Pro session           → nothing counts (nowhere left to go)
 *
 * Thresholds come from ~/features/racing/qualify, shared with the level-up cron
 * so a wall and a text message can never disagree about who qualified.
 */
import { qualifiesFor, formatLap, type QualifyLevel } from "~/features/racing/qualify";
import type { BriefingQualifier } from "./types";

/** One row of Pandora's records/scores response, narrowed to what we read. */
export interface SessionScoreRow {
  /** Full name as the timing system has it. Reduced to a first name here. */
  name?: string | null;
  /** Best lap in ms. */
  bestLap?: number | null;
  /** Timing-system person id. Used ONLY to dedupe within one session — never
   *  stored, never sent to a screen (PII posture, and the BMI id-precision rule
   *  means we do no arithmetic on it either). */
  persId?: number | string | null;
}

const LEVEL_RANK: Record<QualifyLevel, number> = { Intermediate: 1, Pro: 2 };

/**
 * The lowest level worth announcing for a session of this type.
 *
 * Returns null when nothing is worth announcing — a Pro heat, or a session type
 * we do not recognise. Unrecognised is deliberately silent rather than
 * permissive: a board that says nothing is fine, a board that congratulates
 * somebody on a level they already hold is not.
 */
export function announceFloorFor(raceType: string | null | undefined): QualifyLevel | null {
  const name = (raceType || "").toLowerCase();
  if (!name) return null;
  if (name.includes("pro")) return null;
  if (name.includes("intermediate")) return "Pro";
  if (name.includes("starter")) return "Intermediate";
  return null;
}

/**
 * Qualifiers from one session's scores, best lap first.
 *
 * Deduped per racer (the timing system can list a driver twice across score
 * groups) keeping their fastest lap, and capped by the caller's `limit` so a
 * 20-kart Mega grid cannot overflow a board.
 */
export function qualifiersFromScores(
  scores: SessionScoreRow[] | null | undefined,
  opts: { track: string; raceType: string | null | undefined; limit?: number },
): BriefingQualifier[] {
  const floor = announceFloorFor(opts.raceType);
  if (!floor || !Array.isArray(scores) || scores.length === 0) return [];

  const best = new Map<string, { firstName: string; level: QualifyLevel; bestLapMs: number }>();

  for (const row of scores) {
    const bestLapMs = typeof row?.bestLap === "number" ? row.bestLap : NaN;
    if (!Number.isFinite(bestLapMs) || bestLapMs <= 0) continue;

    const level = qualifiesFor(bestLapMs, opts.track);
    if (!level) continue;
    // Below the session's own tier ⇒ not news. See the header.
    if (LEVEL_RANK[level] < LEVEL_RANK[floor]) continue;

    const firstName = firstNameOf(row?.name);
    if (!firstName) continue;

    // Dedupe on the timing id when we have one, else on the name — two racers
    // genuinely called "Marcus" in one heat is rarer than the same racer listed
    // twice, and collapsing them is the safer error (one fewer name, never a
    // wrong one).
    const dedupeKey = row?.persId != null ? `id:${String(row.persId)}` : `name:${firstName}`;
    const prior = best.get(dedupeKey);
    if (!prior || bestLapMs < prior.bestLapMs) {
      best.set(dedupeKey, { firstName, level, bestLapMs });
    }
  }

  return (
    Array.from(best.values())
      // Fastest first. Level as the tie-break so the order is total and cannot
      // wobble between two polls of the same data.
      .sort((a, b) => a.bestLapMs - b.bestLapMs || LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
      .slice(0, opts.limit ?? 12)
      .map((r) => ({ firstName: r.firstName, level: r.level, bestLap: formatLap(r.bestLapMs) }))
  );
}

/**
 * First name from whatever the timing system stored.
 *
 * Handles "Marcus Webb", "WEBB, MARCUS" (some imports are surname-first) and a
 * bare "Marcus". Title-cased on the way out because the timing system shouts.
 */
export function firstNameOf(raw: string | null | undefined): string {
  const name = (raw || "").trim();
  if (!name) return "";
  const part = name.includes(",")
    ? (name.split(",")[1] ?? "").trim() || name.split(",")[0]
    : name.split(/\s+/)[0];
  const token = (part || "").trim();
  if (!token) return "";
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}
