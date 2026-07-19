/**
 * Experiences-tile package preselect — pure resolution of which package
 * variant(s) to stamp on the race item after the party step, so the product
 * step(s) can skip (owner 2026-07-19: tile tap = package chosen; a mixed
 * adult+junior party skips BOTH product steps, straight to the heat pickers).
 *
 * SAFE by construction: resolves via the SAME eligiblePackages() the product
 * step uses (never a package the step wouldn't offer), per category, and only
 * when that category resolves to EXACTLY one enabled variant. Categories that
 * don't resolve stay unstamped → their product step shows normally
 * (skipWhenPreselected in the kiosk registry is per-category too).
 */
import { eligiblePackages, scheduleForDate } from "@/lib/packages";

interface PreselectMember {
  isNewRacer: boolean;
  category?: "adult" | "junior";
}

export interface PreselectPatch {
  packageIdAdult?: string;
  packageIdJunior?: string;
}

/**
 * The per-category package stamps for a tile-launched race item, or null when
 * there is nothing (new) to stamp. Skips categories already stamped, so the
 * calling effect never re-dispatches an identical patch (no update loop).
 */
export function resolvePreselectPatch(args: {
  party: PreselectMember[];
  date: string;
  preferredFamily: string;
  current: { packageIdAdult?: string | null; packageIdJunior?: string | null };
}): PreselectPatch | null {
  const { party, date, preferredFamily, current } = args;
  if (party.length === 0) return null; // wait for the party step
  if (party.some((m) => !m.isNewRacer)) return null; // packages are new-racer-only

  const schedule = scheduleForDate(date);
  const patch: PreselectPatch = {};
  for (const category of ["adult", "junior"] as const) {
    if (!party.some((m) => (m.category ?? "adult") === category)) continue;
    const already = category === "junior" ? current.packageIdJunior : current.packageIdAdult;
    if (already) continue;
    const variants = eligiblePackages({ racerType: "new", schedule, category }).filter((p) =>
      p.id.startsWith(preferredFamily),
    );
    if (variants.length !== 1) continue; // ambiguous/none → that category's product step shows
    if (category === "junior") patch.packageIdJunior = variants[0].id;
    else patch.packageIdAdult = variants[0].id;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
