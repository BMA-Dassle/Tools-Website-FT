/**
 * The lanes a web offer may be sold on — resolved once, from our own catalog.
 *
 * Both the arrangement engine and the availability guard need this, and BOTH were getting
 * it wrong in different ways: the engine inferred it from today's board (unreliable, and
 * poisonable by a single booking on lane 1), and the guard did not consider sections at all,
 * so its fallback offered lanes 1, 2, 3 — Old Time at Fort Myers — to any product.
 *
 * Resolved here, once per hold, and handed to both.
 */
import { getBowlingExperiences } from "@/lib/bowling-db";
import { QAMF_ID_TO_CENTER_CODE } from "@/lib/qamf-centers";
import { sectionForExperience, sectionsFor } from "./sections";

/**
 * Lanes this offer can be sold on, or `null` when we cannot say.
 *
 * `null` means "no restriction" everywhere it is used, so an unknown offer is never refused
 * a lane — it simply gets the behaviour that predates sections.
 *
 * NEVER THROWS. A catalog read that fails degrades to `null`, not to a lost booking.
 */
export async function laneSectionForOffer(
  centerId: number,
  webOfferId: number,
): Promise<number[] | null> {
  try {
    if (sectionsFor(centerId).length === 0) return null;
    const centerCode = QAMF_ID_TO_CENTER_CODE[centerId];
    if (!centerCode) return null;

    // Include inactive rows: `pinboyz-*` (Old Time) is inactive most of the year, and an
    // Old Time booking still has to be aimed at lanes 1-4 rather than anywhere.
    const rows = await getBowlingExperiences(centerCode, undefined, true);
    const matches = rows.filter((e) => e.qamfWebOfferId === webOfferId);
    if (matches.length === 0) return null;

    // An offer id is shared by several products — 158 at Fort Myers is regular-fri-sun,
    // pizza-bowl AND midnight-madness — but they always sell in the SAME section. If two
    // rows ever disagree, say nothing rather than pick a side.
    const sections = new Set<string>();
    let resolved: number[] | null = null;
    for (const m of matches) {
      const section = sectionForExperience(centerId, m);
      if (!section) continue;
      sections.add(section.name);
      resolved = [...section.lanes];
    }
    return sections.size === 1 ? resolved : null;
  } catch (err) {
    console.warn("[lane-plan] section lookup failed (no restriction applied):", err);
    return null;
  }
}
