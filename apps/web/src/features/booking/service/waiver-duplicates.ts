/**
 * Waiver validity is stored PER BMI/Pandora person record, but returning racers
 * routinely have DUPLICATE records for the same human. Minors are the worst
 * case: siblings share one phone and have no email, so the kiosk's Pandora
 * upsert can't match on phone alone and mints a fresh record each visit (live
 * 2026-07-25: one racer had 8 identical Office records — only 3 carried the
 * valid waiver). The recency dedup surfaces ONE record; when that winner is a
 * blank copy the racer gets asked to sign again even though a sibling duplicate
 * holds a perfectly current signature.
 *
 * This ORs waiver validity across the duplicate cluster (the hidden localIds
 * `office-search.ts` attaches as `duplicateIds`). It mirrors the membership
 * union already in ReturningRacerLookup.fetchAccountDetails — same cluster, same
 * fail-open intent — and is called ONLY when the primary record has no valid
 * waiver, so the happy path pays nothing.
 *
 * Client-side: reads the same open `/api/pandora?personId=` GET the sign-in
 * waiver check uses (it accepts 17-digit Office ids). Any failure → false, so a
 * transport hiccup can never fake a signed waiver (show fewer, re-ask, never
 * wave someone through unsigned).
 */
export async function anyDuplicateWaiverValid(
  duplicateIds: string[] | undefined,
  location?: string,
): Promise<boolean> {
  if (!duplicateIds || duplicateIds.length === 0) return false;
  const locQs = location ? `&location=${encodeURIComponent(location)}` : "";
  const checks = await Promise.all(
    duplicateIds.map(async (id) => {
      try {
        const res = await fetch(
          `/api/pandora?personId=${encodeURIComponent(id)}&picture=false${locQs}`,
        );
        if (!res.ok) return false;
        const data = await res.json();
        return data?.valid === true;
      } catch {
        return false;
      }
    }),
  );
  return checks.some(Boolean);
}
