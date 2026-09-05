/**
 * Family picker — the rules behind the linked-family sheet (owner 2026-09-05,
 * "Option A"). A BMI sign-in returns everyone linked to that account; the
 * kiosk collapses them to one summary row and this sheet multi-selects who is
 * actually here today.
 *
 * Pure and shared so the TWO people components (KioskPeopleStep and its twin
 * KioskPartyManager) cannot drift on who may be picked or when the
 * split-payment warning fires — the age floor used to be re-spelled at every
 * call site.
 */

/** The shape both components hold for a linked relative. */
export interface LinkedPerson {
  id: string;
  age: number | null;
  waiverValid: boolean;
}

/** Racing hard floor: karts are 7+. An unknown age is NOT blocked — the
 *  waiver/setup step resolves the real birthday (a linked record often has
 *  none), and blocking on "unknown" would strand a legitimate racer. */
export function tooYoungToRace(age: number | null, isRace: boolean): boolean {
  return isRace && age !== null && age < 7;
}

/** Everyone in the sheet who can actually be selected. */
export function selectableLinked<T extends LinkedPerson>(
  linked: readonly T[],
  isRace: boolean,
): T[] {
  return linked.filter((l) => !tooYoungToRace(l.age, isRace));
}

/** The picks a confirm should act on — selection ∩ selectable, so a stale id
 *  or an under-7 can never ride the batch in. */
export function resolvePicks<T extends LinkedPerson>(
  linked: readonly T[],
  selected: ReadonlySet<string>,
  isRace: boolean,
): T[] {
  return selectableLinked(linked, isRace).filter((l) => selected.has(l.id));
}

/** True when "Select all" should CLEAR instead of select (everything already
 *  picked). An empty roster never reads as "all selected". */
export function allSelected(selectedCount: number, selectableCount: number): boolean {
  return selectableCount > 0 && selectedCount === selectableCount;
}

/**
 * ONE-TIME split-payment heads-up (owner 2026-07-20): kiosk checkout is one
 * payment for the whole group, so the first time a guest grows an ATTRACTION
 * party PAST 3 we intercept the add. `adding` generalizes the old
 * `party.length >= 3` single-tap test to a batch: adding 1 to a party of 3 and
 * adding 3 to a party of 1 both land on 4 and both warn. Racing is exempt —
 * the whole party races on one booking either way.
 */
export function splitWarnNeeded(input: {
  partyLength: number;
  adding: number;
  wholeParty: boolean;
  alreadyWarned: boolean;
}): boolean {
  const { partyLength, adding, wholeParty, alreadyWarned } = input;
  return !wholeParty && !alreadyWarned && partyLength + adding >= 4;
}
