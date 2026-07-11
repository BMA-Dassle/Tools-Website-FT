/**
 * Which bowling experience was a reservation booked under?
 *
 * Shared by buildEditPlan (legacy pricing fallback + duration options) and
 * the pricing-stamp backfill. Split into an async loader (dual-namespace
 * center_code probe) and a PURE matcher so batch callers can fetch each
 * center's experiences once and match per row.
 */
import {
  getBowlingExperiences,
  type BowlingExperienceWithDetails,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import { resolveCenter } from "~/features/cancellation/centers";
import type { StoredLine } from "./types";

const PRIMARY_KINDS = ["kbf", "open", "hourly"];

/**
 * center_code is a mixed namespace (v1 rows: Square location ids, v2 rows:
 * slugs) — fetch the experiences under the resolved slug, falling back to
 * the raw code so legacy rows still resolve.
 */
export const loadExperiencesForCenter = async (
  centerCode: string,
  productKind: ReservationProductKind,
): Promise<BowlingExperienceWithDetails[]> => {
  const centerSlug = resolveCenter(centerCode, productKind).slug;
  let experiences = await getBowlingExperiences(centerSlug);
  if (experiences.length === 0 && centerSlug !== centerCode) {
    experiences = await getBowlingExperiences(centerCode);
  }
  return experiences;
};

/**
 * Match the row's experience: stamp slug first; legacy rows by the primary
 * stored line's product — searched in the experience's ITEMS and its
 * duration-option OVERRIDE products (2h bookings book the override).
 */
export const matchExperienceForRow = (params: {
  experiences: BowlingExperienceWithDetails[];
  stampSlug?: string | null;
  stored: StoredLine[];
}): BowlingExperienceWithDetails | null => {
  const { experiences, stampSlug, stored } = params;
  if (stampSlug) {
    const bySlug = experiences.find((e) => e.slug === stampSlug);
    if (bySlug) return bySlug;
  }
  const primary = stored.find(
    (l) => l.productKind != null && PRIMARY_KINDS.includes(l.productKind),
  );
  if (primary?.squareProductId == null) return null;
  return (
    experiences.find(
      (e) =>
        e.items.some((i) => i.squareProductId === primary.squareProductId) ||
        e.durationOptions.some((d) => d.overrideSquareProductId === primary.squareProductId),
    ) ?? null
  );
};
