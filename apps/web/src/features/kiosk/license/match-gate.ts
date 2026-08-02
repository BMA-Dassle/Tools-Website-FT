/**
 * Search-before-create verdict — the decision the "New Member" / "Set up"
 * submits make AFTER running the Office name+DOB lookup and BEFORE minting a
 * person (owner 2026-08-01, the Gipson check-in: two guests ended the day
 * with 13 person records across four surfaces because every path created
 * blind; Pandora's create is NOT an upsert).
 *
 * Pure and tested — the components only map the verdict to actions:
 *   create → proceed with pandoraOnboardGuest exactly as before
 *   attach → sign the matched account in (handleVerified rail) — no create
 *   pick   → several candidates; the guest chooses (LicenseMatchPicker,
 *            which keeps duplicates VISIBLE — owner rule — and has the
 *            "None of these" escape back to create)
 *
 * First-name agreement guards the attach: the lookup filters on last name +
 * DOB only, and a single hit with a foreign first name is likelier a twin or
 * sibling than the typist — those go to the picker (or, where no picker can
 * mount, to create) rather than silently merging two people.
 */
import { firstNameAffinity } from "~/features/booking/service/office-search";
import type { LicenseMatch } from "./types";

export type MatchGateVerdict =
  | { kind: "create" }
  | { kind: "attach"; match: LicenseMatch }
  | { kind: "pick"; matches: LicenseMatch[] };

function matchFirstName(m: LicenseMatch): string {
  return m.fullName.trim().split(/\s+/)[0] ?? "";
}

/**
 * `pickable: false` is for surfaces that cannot mount the account picker
 * (the guardian overlay, "Set up" on an existing roster row): an ambiguous
 * result auto-adopts the TOP candidate when its first name agrees (the
 * server already sorts by first-name affinity, then recency), and otherwise
 * falls through to create — never a dead end.
 */
export function matchGateVerdict(
  typedFirstName: string,
  matches: LicenseMatch[] | null,
  opts: { pickable: boolean },
): MatchGateVerdict {
  // Lookup unavailable or found nobody — never block the guest.
  if (!matches || matches.length === 0) return { kind: "create" };
  if (matches.length === 1) {
    const agree = firstNameAffinity(typedFirstName, matchFirstName(matches[0])) >= 1;
    if (agree) return { kind: "attach", match: matches[0] };
    return opts.pickable ? { kind: "pick", matches } : { kind: "create" };
  }
  if (opts.pickable) return { kind: "pick", matches };
  const top = matches[0];
  return firstNameAffinity(typedFirstName, matchFirstName(top)) >= 1
    ? { kind: "attach", match: top }
    : { kind: "create" };
}

/** Cache key for the per-form eager prefetch — one lookup per exact identity. */
export function matchGateKey(firstName: string, lastName: string, dobIso: string): string {
  return `${firstName.trim().toLowerCase()}|${lastName.trim().toLowerCase()}|${dobIso}`;
}
