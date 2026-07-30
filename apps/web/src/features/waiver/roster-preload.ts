/**
 * Reservation roster → party rows, for the reservation-scoped /waiver page.
 *
 * The page used to open with "3 of 8 registered" printed above an EMPTY list: a
 * guest on a forwarded link was told eight people were on the booking and then
 * asked to retype every one of them. /api/waiver/context now returns the roster
 * for ONLINE bookings (racing / laser / gel — owner 2026-07-30: "for regular
 * racing, laser and gel reservation, it should always pull up everyone that has
 * registered for that reservation. I don't think we need this for contract events
 * because those people make way back to contract confirmation page"), and this
 * module is the projection of that roster onto PartyMember rows.
 *
 * Six invariants live here, all load-bearing:
 *
 *  1. A preloaded row carries BOTH a person id AND its real `waiverValid`, so
 *     `needsSetup()` — and with it `peopleReady()` and the member card — read it
 *     correctly. An already-covered guest renders "✓ Ready" with no Sign-waiver
 *     button and is never asked to sign a waiver they already hold; an uncovered
 *     one gets "Sign waiver" (not "Set up"), because the account already exists.
 *     Having an ACCOUNT is not the same as having a SIGNABLE id — invariant 5.
 *
 *  2. A preloaded row is EXCLUDED from the reservation-attach pipeline. It came
 *     FROM this reservation's BMI persons_list, so a /api/kiosk/waiver/join POST
 *     would re-register someone already registered — registerProjectPerson
 *     against an existing confirmed project, the one case bmi-attach.ts calls
 *     unverified — and it would do it under the REDACTED name ("Ann", "A."), the
 *     only name a forwardable link is allowed to carry. `isPreloadedMember` is
 *     that gate; nothing else about the attach pipeline changes.
 *
 *  3. Signer-only guardians stay OUT of `party`. The merge only ever APPENDS to
 *     party, never writes `guardians`, and skips anyone already standing in the
 *     guardians list — a roster preload must not quietly promote the adult who is
 *     merely signing for a minor into a participant.
 *
 *  4. A preloaded row nobody on this device has touched is SOMEBODY ELSE'S JOB.
 *     It renders (that is the entire point of the roster) but it must never gate
 *     this phone's completion — otherwise a guest on a forwarded link for an
 *     8-person booking with 4 unsigned signs themselves and the flow never ends.
 *     `membersOwnedHere` is that split. What the COPY owes those people is a
 *     separate question, and invariant 6 answers it — never this split.
 *
 *  5. A preloaded row can only ever sign with THE ID WE ALREADY HOLD, so whether it
 *     can sign at all is decided here, once, by that id's FORM. BMI's persons_list
 *     carries both — SHORT for people our own booking/kiosk created (their
 *     bmiPersonId IS the Pandora id waiver-sign takes), 17-digit Office for anyone
 *     identified through the Office lookup. A SHORT roster id therefore rides
 *     `pandoraPersonId` as well, and lands on submitSetup's short-id branch by
 *     IDENTITY instead of by an incidental length check two files away. A 17-digit
 *     one is never fabricated into a short id, never re-created as a person, and —
 *     as of round 3 — never handed to the party manager at all, because a card whose
 *     "Sign waiver" button ends on an error is worse than no card. See
 *     `preloadCanSign` for what the code does and does not establish about the
 *     17-digit form, and `splitPartyBySignability` for where the two part company.
 *
 *  6. A GROUP-WIDE CLAIM MAY NEVER BE DERIVED FROM THIS DEVICE'S ROWS. "All waivers
 *     signed" is a statement about the whole reservation, and `party` cannot support
 *     it: the guest can remove cards, BMI's persons_list can come back EMPTY on a
 *     booking whose headcount is 8, and "I'm done" deliberately WIPES the list — each
 *     one leaving zero unsigned rows on screen for a booking where nobody has signed.
 *     `reservationWaiverStatus` is the one place that question is answered, from the
 *     reservation's own `signed`/`total` plus the roster's per-person truth; the
 *     counters here (`unsignedPreloadCount`, `coveredPersonIds`) are its witnesses,
 *     never a verdict on their own. `waiverProgress` applies the same rule to the
 *     progress bar, because a FULL bar labelled "N of N signed" is that same claim.
 *
 * Person ids are 17-digit BMI/Pandora ids. They pass through as STRINGS and are
 * never Number()'d, parseInt'd, or re-serialized as JSON numbers.
 */
import type { PartyMember } from "~/features/booking/state/types";
import type { WaiverRosterEntry } from "./roster";

/**
 * Marks a PartyMember.id as "came from the reservation, not from this device".
 *
 * Derived from the person id, so seeding is idempotent, and carried on `id` —
 * the one field no patch ever rewrites (`onUpdateMember` merges into a member
 * found BY id), so the mark cannot be lost mid-flow. Cannot collide with the
 * crypto.randomUUID()s `newPartyMember` mints.
 */
const PRELOAD_ID_PREFIX = "res:";

/** The stable local id for the roster row of `personId`. */
export function preloadedMemberId(personId: string): string {
  return `${PRELOAD_ID_PREFIX}${personId}`;
}

/** True for a row seeded from the reservation roster — the ONE gate that keeps
 *  people already on the booking out of the /join attach pipeline (invariant 2). */
export function isPreloadedMember(member: Pick<PartyMember, "id">): boolean {
  return member.id.startsWith(PRELOAD_ID_PREFIX);
}

/** Every person id a member is known by (BMI Office id and/or short Pandora id). */
function idsOf(member: PartyMember): string[] {
  return [member.bmiPersonId, member.pandoraPersonId].filter((id): id is string => !!id);
}

/**
 * Longest person id that is a SHORT Pandora id. Same ≤12 rule `shortPandoraId` in
 * KioskPartyManager branches on — mirrored on purpose, not re-derived: that
 * function is what the sign path actually consults, so if the two ever disagree a
 * row would claim a capability the component then refuses to use.
 */
const SHORT_PERSON_ID_MAX_LENGTH = 12;

/** True for the SHORT Pandora person id — the form Pandora's waiver-sign takes.
 *  False for the 17-digit BMI Office id a returning-racer lookup yields. */
export function isShortPersonId(personId: string): boolean {
  return personId.length > 0 && personId.length <= SHORT_PERSON_ID_MAX_LENGTH;
}

/**
 * One roster row as a party member.
 *
 * `displayName` is already redacted ("Ann A.") and it is ALL we have — NO phone, NO
 * email, NO birthdate, and therefore no `isMinor`. That is deliberate for a
 * forwardable link, and it is also what keeps the row SAFE: with no dedup identity
 * there is nothing for KioskPartyManager's setup path to run a Pandora create
 * against, so a preloaded guest can never be minted as a duplicate person (the
 * 2026-07-25 Strachan class) and the redacted "Ann"/"A." can never be written onto
 * a real BMI record.
 *
 * Read that as a hard precondition, not a coincidence: chooseGuardian's proven rule
 * is "create ONLY with a dedup identity AND a birthdate", and a preloaded row fails
 * that test on all three counts, forever — the setup form's only input is a DOB, so
 * a phone or email can never arrive on this row either. Every downstream decision
 * below follows from it (see `preloadCanSign`).
 *
 * What redaction cannot do is invent a SIGNABLE id, and persons_list hands back
 * whichever id each person happens to be registered under (invariant 5):
 *
 *   - SHORT (≤12 digits) — the Pandora id our own booking/kiosk create returned
 *     for someone added as a new person. That IS the id waiver-sign takes, so it
 *     rides `pandoraPersonId` as well as `bmiPersonId` — exactly what submitNew
 *     and JoinPhoneFlow do for a new person.
 *
 *   - 17-digit OFFICE id — a returning racer identified through the Office
 *     lookup. `pandoraPersonId` stays ABSENT: we do not know their short id and
 *     must not fabricate one. Those rows are what `preloadNeedsSignIn` marks.
 *
 * `isMinor` is left UNSET rather than guessed. It is the field KioskPartyManager's
 * `adults` (and with it the guardian-candidate list) reads, so `false` here would be
 * a claim that a name off a booking is an adult — and `true` would be a claim they
 * are a child AND would make `peopleReady` demand a guardian for a row nobody on
 * this device can resolve. Unset is the only honest value; what follows from it is
 * documented on `preloadCanSign`.
 */
function memberFromEntry(entry: WaiverRosterEntry): PartyMember {
  const [first, ...rest] = entry.displayName.trim().split(/\s+/);
  return {
    id: preloadedMemberId(entry.personId),
    firstName: first ?? "",
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    // Straight through as a STRING: a 17-digit BMI id must never touch Number().
    bmiPersonId: entry.personId,
    // A short roster id IS the sign id. A 17-digit one is not, and no amount of
    // string work can turn it into one — so the field is simply left off.
    ...(isShortPersonId(entry.personId) ? { pandoraPersonId: entry.personId } : {}),
    // Racing-only field; a waiver-mode card never reads it. False claims nothing.
    isNewRacer: false,
    // Real per-person truth from the same Pandora ∪ Neon-joins sweep that produced
    // the header fraction — never a guess. `true` means "do not ask them again".
    waiverValid: entry.waiverValid,
  };
}

/**
 * Append the roster rows that are not already accounted for, in roster order
 * (BMI persons_list order, then join-only signers).
 *
 * Skipped: anyone already on the party under ANY of their person ids (the guest
 * signed themselves in before the fetch landed), anyone already seeded, and
 * anyone standing in `guardians` (invariant 3 — a signer-only adult must not be
 * dragged into the participating set by a preload).
 *
 * Returns the SAME array when nothing was added, so React bails out of the
 * re-render and the attach pipeline's memo doesn't churn.
 */
export function mergeRosterIntoParty(
  party: PartyMember[],
  roster: WaiverRosterEntry[],
  guardians: PartyMember[] = [],
): PartyMember[] {
  const claimedIds = new Set<string>();
  for (const m of party) for (const id of idsOf(m)) claimedIds.add(id);
  for (const g of guardians) for (const id of idsOf(g)) claimedIds.add(id);
  const takenLocalIds = new Set(party.map((m) => m.id));

  const added: PartyMember[] = [];
  for (const entry of roster) {
    // A row with no id or no name is unusable: it could neither sign nor attach,
    // and it would render as a blank card.
    if (!entry?.personId || !entry.displayName.trim()) continue;
    if (claimedIds.has(entry.personId)) continue;
    if (takenLocalIds.has(preloadedMemberId(entry.personId))) continue;
    claimedIds.add(entry.personId);
    takenLocalIds.add(preloadedMemberId(entry.personId));
    added.push(memberFromEntry(entry));
  }
  return added.length > 0 ? [...party, ...added] : party;
}

/**
 * The members THIS DEVICE is responsible for finishing (invariant 4).
 *
 * `signedHere` is the set of member ids whose waiver was signed on this device
 * (KioskPartyManager's onWaiverSigned reports the member id, so a preloaded row
 * signed from its own card is included — its id keeps the `res:` mark forever).
 *
 * Included:
 *  - everyone NOT preloaded: added by lookup, the new-player form, a license scan,
 *    a linked-family tap, or a promoted guardian. This device put them there.
 *  - every preloaded row this device signed — the guest who opened a forwarded
 *    link and signed their own row. Without them the completion set would be
 *    EMPTY for that guest (their row keeps the `res:` id) and the flow would have
 *    no end at all.
 *
 * Excluded: preloaded rows nobody here has touched — signed or not. A signed one
 * is already done; an unsigned one belongs to whoever else holds the link, and
 * this phone must not wait on them.
 *
 * Deliberately NOT "preloaded && waiverValid": a roster that arrives with 4 of 8
 * already covered would then hand a guest who has done NOTHING a green
 * "you're all set" card built out of other people's signatures.
 */
export function membersOwnedHere(
  party: PartyMember[],
  signedHere: ReadonlySet<string>,
): PartyMember[] {
  return party.filter((m) => !isPreloadedMember(m) || signedHere.has(m.id));
}

/**
 * How many rows STILL ON THIS SCREEN came off the reservation and still need a
 * waiver — a FLOOR under the group's remainder, never a verdict on it (invariant 6).
 *
 * Read the ZERO carefully, because reading it as "the booking is covered" is exactly
 * the lie invariant 6 exists to stop. It is also 0 when the guest removed those
 * cards, when `ctx.roster` arrived EMPTY (BMI's persons_list can be empty on a
 * booking whose `persons` headcount is 8), and after "I'm done" wipes the list.
 *
 * What it is genuinely good for is the one thing the fetched roster cannot do: it
 * counts what the guest is LOOKING AT. A card can go unsigned after the sweep said
 * otherwise — KioskPartyManager's authoritative Pandora re-check patches
 * `waiverValid: false` onto a row the 60s-cached sweep union called covered — and no
 * group-wide sentence may read lower than the number of "Sign waiver" buttons on
 * screen. That is why `reservationWaiverStatus` takes it as a floor.
 *
 * A row superseded by a real sign-in is gone from `party`, and one signed here is
 * `waiverValid`, so neither is double-counted. A row held out of the party manager by
 * `splitPartyBySignability` IS still counted: being unable to sign somebody does not
 * make them somebody else's problem.
 */
export function unsignedPreloadCount(party: PartyMember[]): number {
  return party.filter((m) => isPreloadedMember(m) && !m.waiverValid).length;
}

/**
 * Every person id this device can PROVE holds a valid waiver, under every id form
 * that person is known by — a returning racer carries the 17-digit Office id AND the
 * short Pandora id, and BMI's persons_list names whichever one they were registered
 * under, so matching on one form only would miss them.
 *
 * `carried` is how those proofs survive "I'm done". That wipe destroys `party` on
 * purpose (a list of real names must not sit on a phone handed to the next person in
 * line) and the roster is never re-seeded, so without carrying the ids forward the
 * outstanding count would creep back UP: the guest who just filed Ann's waiver hands
 * the phone over and the next screen asks for Ann again. Ids only — never a name,
 * never a birthdate — which is precisely what the wipe is for.
 */
export function coveredPersonIds(
  party: PartyMember[],
  carried: ReadonlySet<string> = new Set<string>(),
): Set<string> {
  const ids = new Set<string>(carried);
  for (const m of party) {
    if (!m.waiverValid) continue;
    for (const id of idsOf(m)) ids.add(id);
  }
  return ids;
}

/**
 * What this page is ALLOWED to say about the WHOLE reservation (invariant 6).
 *
 *  - `covered`     — every registered guest holds a valid waiver. The ONLY state that
 *                    may say "All waivers signed", and the only one whose SILENCE
 *                    about other people is honest.
 *  - `outstanding` — at least one person on the reservation does not. `count` is how
 *                    many we can prove by name; `null` is "someone, and any number we
 *                    printed would be a guess".
 *  - `unknown`     — we cannot tell. The copy then makes no completion claim in
 *                    either direction: a wrong "all signed" tells a party of twelve
 *                    they are done, and a wrong count nags people who already signed.
 */
export type ReservationWaiverStatus =
  | { kind: "covered" }
  | { kind: "outstanding"; count: number | null }
  | { kind: "unknown" };

/**
 * Answer that question from the RESERVATION, never from this device's rows.
 *
 * Order matters, and each step is here because the step below it can be wrong:
 *
 *  1. THE ROSTER, minus what we have covered since, is the strongest evidence this
 *     page can hold: real per-person validity for every named person on the booking,
 *     and live, because signing someone here subtracts them. Any row it still owes is
 *     the answer, floored by what is unsigned on screen (`unsignedPreloadCount`).
 *  2. A roster with nothing outstanding may say `covered` only if it NAMES THE WHOLE
 *     BOOKING (`roster.length >= total`). `total` is BMI's `persons` headcount, not
 *     the roster length: a booking for 8 whose persons_list holds 4 names has 4
 *     registered heads with no record to sign against, and an EMPTY persons_list has
 *     8 — which is how "All waivers signed" reached a booking where nobody had
 *     signed. An empty roster names nobody and therefore proves nothing.
 *  3. Only then the authoritative fraction. `signed >= total` means every registered
 *     guest was covered at page load, and this device can only ever ADD signatures,
 *     so that stays true. A PARTIAL fraction is frozen and cannot see what we just
 *     signed, so it may only claim a shortfall bigger than everything this device
 *     could have closed — and then without a number, because the number would be
 *     stale.
 *  4. Otherwise `unknown`. Not knowing is a real answer and the copy says so.
 */
export function reservationWaiverStatus(input: {
  /** `ctx.signed` — authoritative across every device, frozen at page load;
   *  undefined when the Pandora sweep missed its deadline. */
  signed?: number;
  /** `ctx.total` — the registered HEADCOUNT (BMI `persons`), not the roster length. */
  total?: number;
  /** `ctx.roster` — present only for an ONLINE booking whose sweep landed. */
  roster?: WaiverRosterEntry[];
  /** This device's live rows. */
  party: PartyMember[];
  /** Person ids covered here whose rows the "I'm done" wipe has already cleared. */
  covered?: ReadonlySet<string>;
}): ReservationWaiverStatus {
  const total = input.total ?? 0;
  const { roster, signed } = input;

  if (roster) {
    const covered = coveredPersonIds(input.party, input.covered);
    const outstanding = Math.max(
      roster.filter((r) => !r.waiverValid && !covered.has(r.personId)).length,
      unsignedPreloadCount(input.party),
    );
    if (outstanding > 0) return { kind: "outstanding", count: outstanding };
    if (roster.length > 0 && roster.length >= total) return { kind: "covered" };
    // Fewer names than heads — the roster cannot close the question either way.
  }

  if (signed === undefined || total <= 0) return { kind: "unknown" };
  if (signed >= total) return { kind: "covered" };
  const coveredHere = input.party.filter((m) => m.waiverValid).length;
  return total - signed - coveredHere > 0
    ? { kind: "outstanding", count: null }
    : { kind: "unknown" };
}

/**
 * The head progress bar's fraction — the RESERVATION's progress in reservation mode,
 * never this phone's (invariant 6). A full bar over "N of N signed" is the same
 * group-wide claim as the headline, and `party` is not entitled to make it: with the
 * device's own rows as numerator AND denominator it reads "2 of 2 signed" under a
 * full cyan bar for a booking with three people outstanding.
 *
 *  - DENOMINATOR: the authoritative registered headcount, floored by the party (a
 *    guest may add someone who was never registered). No authoritative pair yet ⇒
 *    `{ signed: 0, total: 0 }`, and WaiverHead shows no bar at all — the same rule
 *    EventInfoCard already follows by hiding "0 of 100" until the count is real.
 *  - NUMERATOR: computed as `total` MINUS the unsigned segments, never built up from a
 *    signed figure. A COUNTED remainder is the strongest such number, because then the
 *    bar and the sentence under it describe the same booking — "5 of 8" over "3 more
 *    people on this reservation still need a waiver" — and the count already accounts
 *    for what this device covered before "I'm done" cleared the rows (which is why the
 *    server's frozen figure must not be maxed in over it: clamped to `total` it would
 *    FILL the bar). Otherwise the best figure we can prove, the frozen count or this
 *    device's live one, held one short of full.
 *  - UNSIGNED IS FLOORED BY THE SCREEN, and this is the pair to the denominator's
 *    floor rather than a separate nicety. `status` speaks for the REGISTERED heads
 *    only; widening the denominator with people the guest added while subtracting a
 *    remainder that never counted them credits every one of those extras as signed.
 *    Unfixed it read "3 of 4 signed" on a solo booking with NOTHING signed (roster of
 *    1, guest adds 3 family), "9 of 14" where 3 had signed, and — through `covered`,
 *    which is a verdict on the reservation and not on the walk-in beside it — a FULL
 *    bar over "3 of 3 signed" with an unsigned card on screen. The bar may never show
 *    fewer empty segments than there are unsigned cards under it.
 *  - FULL is reserved for `covered`, in every branch, and within `covered` for the
 *    case where nothing on screen is outstanding either. Filling the bar is the claim.
 *
 * `status: null` means standalone: there is no reservation, the party on screen is
 * the whole story, and its own fraction is the honest one.
 */
export function waiverProgress(input: {
  status: ReservationWaiverStatus | null;
  partySize: number;
  partySigned: number;
  signed?: number;
  total?: number;
}): { signed: number; total: number } {
  const { status, partySize, partySigned } = input;
  if (status === null) return { signed: partySigned, total: partySize };
  if (input.signed === undefined || !input.total) return { signed: 0, total: 0 };
  const total = Math.max(input.total, partySize);
  // Unsigned cards the guest is looking at. `status` cannot see anyone this device
  // added, so it is this — not the status — that keeps the extras the denominator
  // just absorbed from being credited as signatures.
  const unsignedOnScreen = Math.max(partySize - partySigned, 0);
  // ONE subtraction, so "the bar fills only when nothing is owed" is true by
  // construction: `unsigned` can only reach 0 on the `covered` branch.
  const unsigned =
    status.kind === "covered"
      ? unsignedOnScreen
      : status.kind === "outstanding" && status.count !== null
        ? // `count` is > 0 here, so this branch can never fill the bar.
          Math.max(status.count, unsignedOnScreen)
        : // Nothing countable: hold one short of full, and still never read past the
          // Sign-waiver buttons on screen.
          Math.max(total - Math.max(input.signed, partySigned), unsignedOnScreen, 1);
  return { signed: Math.max(total - unsigned, 0), total };
}

/**
 * Can the signature path FINISH this preloaded row, using only the id we already
 * hold? Mirrors `shortPandoraId` in KioskPartyManager, which is what the sign path
 * actually consults.
 *
 * "Only the id we already hold" is not a simplification — it is the whole situation.
 * The one way to turn a 17-digit Office id into a short Pandora id is
 * `pandoraCreatePerson`, and chooseGuardian's rule (proven live 2026-07-30, when
 * tapping an existing adult 400'd) is: attempt it ONLY with a dedup identity AND a
 * birthdate, because Pandora answers anything less with a bare 400 "Validation
 * Exception". A preloaded row has no phone, no email and no birthdate — and cannot
 * acquire one, because the setup form's only field is the DOB. So no create is ever
 * legitimate here, and attempting one anyway would either 400 or, worse, succeed and
 * mint a duplicate person carrying the redacted name "Ann A." (2026-07-25 Strachan).
 *
 * That leaves the id form, and the two forms are NOT symmetric:
 *
 *   - SHORT (≤12) → `submitSetup`'s short-id branch checks the waiver on this id
 *     (pandoraCheckWaiver), refreshes the age from BMI's own birthdate, and signs
 *     against it. A proven path end to end. Signable.
 *
 *   - 17-digit Office id → NOT ESTABLISHED, either way. Verified 2026-07-30 by
 *     reading app/api/pandora/waiver POST: it drops `personID` into the multipart
 *     body verbatim — no length rule, no validation, no branch — so the route makes
 *     no claim about the Office form on its own account, and it cannot rescue a
 *     rejection either (a 4xx breaks straight out of the retry loop, and the salvage
 *     probe re-reads the SAME id). The "waiver-sign rejects the 17-digit id" that
 *     `PartyMember` and three call sites assert traces back to the 2026-07-18 kiosk
 *     500s — which THAT ROUTE's own analysis re-diagnosed as transient Azure bursts
 *     plus a blank `invalidationDate`, both since fixed. The repo also proves the
 *     500s for /bmi/schedule, a different endpoint. Nothing here settles /bmi/waiver.
 *
 * An unproven id is not a signature path. So the code does not gamble a guest's
 * signature on it: `splitPartyBySignability` keeps the row off the party manager
 * entirely and the page routes it to the rail that CAN establish identity. Note the
 * one thing we do know works on a 17-digit id is the waiver CHECK (/api/pandora GET
 * accepts Office ids — chooseGuardian and valid-count both rely on it), which is why
 * such a row can still be reported as covered or outstanding truthfully.
 */
export function preloadCanSign(member: PartyMember): boolean {
  if (member.pandoraPersonId) return true;
  return !!member.bmiPersonId && isShortPersonId(member.bmiPersonId);
}

/**
 * A preloaded row that still needs a waiver and cannot sign with the id we hold —
 * the one case where the card's "Sign waiver" button could not finish, so the guest
 * is pointed at the path that can instead of at a signature screen.
 *
 * WHAT DOES work is the rail already on this page, and it is the same rail a
 * manually-added person walks: "Sign in / find people" → OTP → `handleVerified`
 * resolves the SHORT id from the verified phone/email → `addMemberSupersedingPreload`
 * swaps the real account in for this placeholder, and the row becomes signable. On a
 * link anyone can forward, proving the phone before writing a signature onto a
 * stranger's record is a feature, not friction.
 */
export function preloadNeedsSignIn(member: PartyMember): boolean {
  return isPreloadedMember(member) && !member.waiverValid && !preloadCanSign(member);
}

/** The working roster, split by what the party manager is allowed to offer. */
export interface PreloadSplit {
  /**
   * What KioskPartyManager gets as its `party`. Everything this device added, plus
   * every preloaded row that is either already covered (renders "✓ Ready") or can
   * genuinely sign.
   */
  signable: PartyMember[];
  /** Preloaded rows still needing a waiver that this link cannot sign — shown
   *  read-only by the page, with the sign-in rail named. */
  needSignIn: PartyMember[];
}

/**
 * Split the working roster into what the party manager may render and what it must
 * not.
 *
 * WHY the split is at the PROP and not inside the card: KioskPartyManager offers
 * "Sign waiver" to every member `needsSetup()` is true for, and `needsSetup` is
 * `!bmiPersonId || !waiverValid` — there is no member shape that renders a preloaded
 * row honestly (id present, waiver outstanding) AND suppresses that button. The two
 * ways to suppress it from here are both lies: `waiverValid: true` claims a waiver
 * that does not exist, and dropping `bmiPersonId` pushes the row into the CREATE
 * branch, which is how you mint a duplicate under a redacted name. So the row is
 * held out of the prop instead.
 *
 * Held out of the PROP, NOT out of state. The caller keeps the full `party`, which is
 * what makes this safe rather than a disappearing act:
 *   - `unsignedPreloadCount` still counts them, so `reservationWaiverStatus` still
 *     owes them and the group-wide copy still says so;
 *   - `membersOwnedHere` still excludes them (nobody here can sign them), so the
 *     completion gate is unchanged;
 *   - `addMemberSupersedingPreload` still finds and replaces the placeholder when the
 *     guest verifies, so there is never a second card for one human;
 *   - the page's own signed/total header still counts the whole booking.
 * And one thing improves for free: a held-out row is no longer in the component's
 * `adults`, so it can no longer be nominated as a GUARDIAN for someone else's minor
 * — which would have filed that minor's waiver with a `sigPersonID` we cannot stand
 * behind, on a row whose age we never knew.
 *
 * Returns the SAME array for `signable` when nothing is held back, so the common
 * case (every roster id short) hands React an unchanged prop.
 */
export function splitPartyBySignability(party: PartyMember[]): PreloadSplit {
  const needSignIn = party.filter((m) => preloadNeedsSignIn(m));
  if (needSignIn.length === 0) return { signable: party, needSignIn };
  return { signable: party.filter((m) => !preloadNeedsSignIn(m)), needSignIn };
}

/**
 * Add a member, superseding their preloaded placeholder if they have one.
 *
 * A guest who is ON the roster may still reach for "Sign in / find people" (or a
 * license scan, or a linked-family tap) rather than the Sign-waiver button on
 * their own row. Left alone that produces TWO cards for one human — the redacted
 * placeholder and the real account — and the placeholder can never be satisfied,
 * so the party never reaches "All waivers signed". The real identity wins: same
 * position in the list, and it keeps its OWN id, because the caller's async
 * follow-ups (the authoritative Pandora waiver check + linked-family import in
 * `handleVerified`) patch by the id they minted.
 *
 * Any minor pointing at the superseded placeholder as their guardian is
 * re-pointed, so the swap can't dangle a guardianMemberId.
 */
export function addMemberSupersedingPreload(
  party: PartyMember[],
  added: PartyMember,
): PartyMember[] {
  const ids = idsOf(added);
  const index = party.findIndex(
    (m) => isPreloadedMember(m) && idsOf(m).some((id) => ids.includes(id)),
  );
  if (index < 0) return [...party, added];
  const supersededId = party[index].id;
  return party.map((m, i) => {
    if (i === index) return added;
    if (m.guardianMemberId === supersededId) return { ...m, guardianMemberId: added.id };
    return m;
  });
}
