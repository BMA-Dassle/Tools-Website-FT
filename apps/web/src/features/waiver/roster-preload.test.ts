import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  addMemberSupersedingPreload,
  isPreloadedMember,
  membersOwnedHere,
  mergeRosterIntoParty,
  preloadCanSign,
  preloadedMemberId,
  preloadNeedsSignIn,
  coveredPersonIds,
  reservationWaiverStatus,
  splitPartyBySignability,
  unsignedPreloadCount,
  waiverProgress,
} from "./roster-preload";
import type { WaiverRosterEntry } from "./roster";
import {
  needsSetup,
  peopleReady,
  shortPandoraId,
} from "~/features/kiosk/components/KioskPartyManager";
import type { PartyMember } from "~/features/booking/state/types";

/**
 * The preload's job is to hand KioskPartyManager rows that the EXISTING rules read
 * correctly — so these tests assert against the real `needsSetup` / `peopleReady`
 * and against the real attach predicate, not against a local restatement of them.
 */
const entry = (personId: string, displayName: string, waiverValid: boolean): WaiverRosterEntry => ({
  personId,
  displayName,
  waiverValid,
});

/** A member added on THIS device (lookup / new-player form / linked family). */
const local = (over: Partial<PartyMember> = {}): PartyMember => ({
  id: "uuid-local-1",
  firstName: "Ann",
  lastName: "Alpha",
  isNewRacer: false,
  ...over,
});

/** The attach pipeline's own rule, verbatim from useReservationJoinAttach: a
 *  member joins the moment it has a person id AND a valid waiver. */
const wouldAttach = (m: PartyMember) => !!(m.pandoraPersonId ?? m.bmiPersonId) && !!m.waiverValid;

describe("mergeRosterIntoParty", () => {
  it("seeds every registered person, redacted, in roster order", () => {
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", true), entry("12", "Bob B.", false), entry("13", "Cid", true)],
    );
    expect(party.map((m) => [m.id, m.firstName, m.lastName, m.bmiPersonId, m.waiverValid])).toEqual(
      [
        ["res:11", "Ann", "A.", "11", true],
        ["res:12", "Bob", "B.", "12", false],
        // A one-token display name (no last name on the BMI record) stays one token.
        ["res:13", "Cid", undefined, "13", true],
      ],
    );
  });

  it("renders a covered guest as DONE, not as another waiver to sign", () => {
    // Hazard: a preloaded row missing either the person id or waiverValid reads as
    // "needs setup", and the guest is asked to sign a waiver they already hold.
    const party = mergeRosterIntoParty([], [entry("11", "Ann A.", true)]);
    expect(needsSetup(party[0])).toBe(false);
    expect(
      peopleReady(
        party,
        party.map((m) => m.id),
      ),
    ).toBe(true);
  });

  it("leaves an uncovered guest needing a waiver — with their account already found", () => {
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", true), entry("12", "Bob B.", false)],
    );
    const bob = party[1];
    expect(needsSetup(bob)).toBe(true);
    // bmiPersonId present ⇒ the card offers "Sign waiver", not "Set up", and no
    // Pandora create runs for a person who already has a record. Whether that card
    // can FINISH is a separate question, decided by the id FORM — "account found" is
    // not "signable" (see the three-shapes suite). This roster id is short, so this
    // one really can sign.
    expect(bob.bmiPersonId).toBe("12");
    expect(shortPandoraId(bob)).toBe("12");
    // Bob's card asks for a waiver — but Bob is a name off the reservation, not
    // somebody standing here, so he is NOT allowed to gate this device: the flow
    // gates on membersOwnedHere, never on the whole party (see the gate suite
    // below, and the whole-party version this used to assert).
    expect(membersOwnedHere(party, new Set())).toEqual([]);
  });

  it("never lets a preloaded row into the reservation-attach pipeline", () => {
    // They came FROM this reservation's persons_list. Attaching them would
    // re-register an existing projectPerson under the redacted name "Ann"/"A.".
    const party = mergeRosterIntoParty([], [entry("11", "Ann A.", true)]);
    expect(wouldAttach(party[0])).toBe(true); // the hook alone WOULD post a join
    expect(party.filter((m) => !isPreloadedMember(m)).filter(wouldAttach)).toEqual([]);
  });

  it("keeps a guest who signed in first — no second card for one human", () => {
    const signedIn = local({ bmiPersonId: "11", waiverValid: true });
    const party = mergeRosterIntoParty(
      [signedIn],
      [entry("11", "Ann A.", true), entry("12", "Bob B.", false)],
    );
    expect(party).toHaveLength(2);
    expect(party[0]).toBe(signedIn); // untouched, real name intact
    expect(party[1].id).toBe("res:12");
    // The real sign-in still attaches; only the preloaded row is held back.
    expect(party.filter((m) => !isPreloadedMember(m))).toEqual([signedIn]);
  });

  it("matches an existing member by their SHORT Pandora id too", () => {
    // A returning guest's row can carry the 17-digit Office id in bmiPersonId and
    // the short id in pandoraPersonId; the roster may name either one.
    const signedIn = local({ bmiPersonId: "51383608123456789", pandoraPersonId: "412" });
    const party = mergeRosterIntoParty([signedIn], [entry("412", "Ann A.", false)]);
    expect(party).toEqual([signedIn]);
  });

  it("does NOT drag a signer-only guardian into the party", () => {
    // The guardians list and the participating set are the invariant the whole
    // attach path rests on: an adult who is only signing for a minor must not
    // become a participant because they happen to be on the booking.
    const guardian = local({ id: "uuid-guardian", firstName: "Dad", bmiPersonId: "12" });
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", true), entry("12", "Dad D.", true)],
      [guardian],
    );
    expect(party.map((m) => m.id)).toEqual(["res:11"]);
  });

  it("is idempotent, and returns the SAME array when nothing is added", () => {
    const roster = [entry("11", "Ann A.", true)];
    const once = mergeRosterIntoParty([], roster);
    const twice = mergeRosterIntoParty(once, roster);
    expect(twice).toBe(once); // reference-equal → React bails out of the re-render
  });

  it("keeps a 17-digit person id an untouched string", () => {
    const bigId = "51383608123456789";
    expect(Number(bigId)).toBeGreaterThan(Number.MAX_SAFE_INTEGER); // guard the guard
    const [member] = mergeRosterIntoParty([], [entry(bigId, "Ann A.", false)]);
    expect(member.bmiPersonId).toBe(bigId);
    expect(member.id).toBe(preloadedMemberId(bigId));
  });

  it("skips unusable rows and handles an online booking with nobody on it", () => {
    expect(mergeRosterIntoParty([], [])).toEqual([]);
    expect(mergeRosterIntoParty([], [entry("", "Ann A.", true), entry("12", "  ", true)])).toEqual(
      [],
    );
  });
});

/**
 * THE UNSIGNED PRELOADED GUEST — the case that decides whether the whole preload is
 * worth anything. A row that renders "Sign waiver" and then cannot sign is worse
 * than the empty list it replaced.
 *
 * THREE SHAPES reach the signature path, and only ONE of them can finish it. All
 * three come out of `memberFromEntry`, and what separates them is what the row has
 * to work with:
 *
 *  1. SHORT (≤12) person id — the Pandora id our own booking/kiosk create returned.
 *     `submitSetup`'s short-id branch (KioskPartyManager ~985-1034) checks the waiver
 *     on it, refreshes the age from BMI's birthdate, and signs against it. WORKS.
 *
 *  2. 17-digit OFFICE id — a returning racer identified through the Office lookup.
 *     `submitSetup` falls past the short-id branch to its last arm, which fetches a
 *     template and opens the signature screen on the OFFICE id. Whether Pandora
 *     accepts that is NOT established anywhere in this repo (see below), so the row
 *     is routed to the sign-in rail instead of gambling a signature on it.
 *
 *  3. NO usable dedup identity and NO birthdate — true of EVERY preloaded row, by
 *     construction. It is why shape 2 can never be repaired in place: the only way to
 *     turn an Office id into a short one is `pandoraCreatePerson`, and chooseGuardian's
 *     proven rule is "create only with a dedup identity AND a birthdate". It is also
 *     why a preloaded row must not be treated as an age-verified adult.
 *
 * ON SHAPE 2, DELIBERATELY NOT ASSERTED HERE: that Pandora's waiver-sign *rejects* a
 * 17-digit personID. That claim is in `PartyMember` and three call sites, but
 * app/api/pandora/waiver POST passes `personID` into the multipart body untouched —
 * no length rule, no branch — and that route's own analysis re-diagnosed the
 * 2026-07-18 "sign 500s" as transient Azure bursts plus a blank `invalidationDate`.
 * The repo proves the 500s for /bmi/schedule, a DIFFERENT endpoint. So these tests
 * assert what we actually decided — an UNPROVEN id is not a signature path — not a
 * behaviour of someone else's service that nobody here has measured.
 *
 * Asserted against the REAL rule the sign path branches on (`shortPandoraId`), not a
 * local restatement of it — and with REAL id shapes: the original tests used
 * 2-character ids, which are incidentally "short", which is exactly why every one of
 * them passed while a live 17-digit roster row could not sign.
 */
describe("the unsigned preloaded guest — one shape signs, two are routed", () => {
  /** Returning racer, identified through the BMI Office lookup. */
  const OFFICE_ID = "51383608123456789";
  /** Person our own booking/kiosk created (docs/pandora-api.md's real example). */
  const SHORT_ID = "713365";

  /** KioskPartyManager's own guardian-candidate rule, verbatim: `adults` is
   *  `party.filter(m => !m.isMinor)` over the party it was GIVEN. */
  const guardianCandidates = (given: PartyMember[]) => given.filter((m) => !m.isMinor);

  /** chooseGuardian's create precondition, verbatim (KioskPartyManager ~576):
   *  `(phone || email) && dobIso`. False ⇒ no create is even attempted. */
  const couldCreatePerson = (m: PartyMember) =>
    !!((m.phone?.trim() || m.email?.trim()) && m.dobIso);

  describe("shape 1 — a SHORT Pandora id", () => {
    it("signs end to end on the id we already hold, and keeps its card", () => {
      const party = mergeRosterIntoParty([], [entry(SHORT_ID, "Ann A.", false)]);
      const [member] = party;
      // Non-null shortPandoraId ⇒ submitSetup takes the branch that checks the waiver
      // on this id and signs against it. Carried explicitly rather than left to a
      // length check downstream.
      expect(shortPandoraId(member)).toBe(SHORT_ID);
      expect(member.pandoraPersonId).toBe(SHORT_ID);
      expect(preloadCanSign(member)).toBe(true);
      expect(needsSetup(member)).toBe(true); // the waiver itself is still outstanding
      expect(preloadNeedsSignIn(member)).toBe(false);
      // …so it is handed to the party manager, which is what renders "Sign waiver".
      const split = splitPartyBySignability(party);
      expect(split.signable).toBe(party); // same array — no churn in the common case
      expect(split.needSignIn).toEqual([]);
    });
  });

  describe("shape 2 — a 17-digit OFFICE id", () => {
    it("never reaches a signature screen we cannot stand behind", () => {
      const party = mergeRosterIntoParty([], [entry(OFFICE_ID, "Bob B.", false)]);
      const [member] = party;
      // The sign path's own rule says "resolve a short id first" — and shape 3 is why
      // nothing on this row can resolve it. So the row is held OUT of the party the
      // manager renders: no card, therefore no "Sign waiver" button, therefore no
      // dead signature screen. This is the assertion round 2 was missing — it flagged
      // the row for the copy and still handed it the button.
      expect(shortPandoraId(member)).toBeNull();
      expect(preloadCanSign(member)).toBe(false);
      expect(preloadNeedsSignIn(member)).toBe(true);
      const { signable, needSignIn } = splitPartyBySignability(party);
      expect(signable).toEqual([]);
      expect(needSignIn).toEqual([member]);
    });

    it("stays ON the booking — listed, counted, never silently dropped", () => {
      const party = mergeRosterIntoParty(
        [],
        [entry(OFFICE_ID, "Bob B.", false), entry(SHORT_ID, "Ann A.", true)],
      );
      const { signable, needSignIn } = splitPartyBySignability(party);
      // Ann keeps her "✓ Ready" card; Bob is named in the read-only block instead.
      expect(signable.map((m) => m.firstName)).toEqual(["Ann"]);
      expect(needSignIn.map((m) => m.firstName)).toEqual(["Bob"]);
      // The group-wide copy still owes him, and the page's signed/total still counts
      // him — both read the FULL party, never the split.
      expect(unsignedPreloadCount(party)).toBe(1);
      expect(party).toHaveLength(2);
      // And he is still not this device's job, so he cannot block "I'm done".
      expect(membersOwnedHere(party, new Set())).toEqual([]);
    });

    it("never fabricates a short id, and never re-creates a person who has one", () => {
      const [member] = mergeRosterIntoParty([], [entry(OFFICE_ID, "Bob B.", false)]);
      // Inventing a pandoraPersonId would push a 17-digit id down the short-id branch;
      // dropping bmiPersonId would push the row into the CREATE branch and mint a
      // duplicate for someone who already has a BMI record. Both fields stay exactly
      // as BMI reported them, as strings.
      expect(member.pandoraPersonId).toBeUndefined();
      expect(member.bmiPersonId).toBe(OFFICE_ID);
      expect(Number(OFFICE_ID)).toBeGreaterThan(Number.MAX_SAFE_INTEGER); // guard the guard
    });

    it("stays quiet about a COVERED 17-digit row — there is no waiver to sign", () => {
      const party = mergeRosterIntoParty([], [entry(OFFICE_ID, "Ann A.", true)]);
      expect(needsSetup(party[0])).toBe(false);
      expect(preloadNeedsSignIn(party[0])).toBe(false);
      // Her card renders exactly as before: nothing to sign, nothing to route.
      expect(splitPartyBySignability(party).signable).toBe(party);
    });

    it("becomes signable the moment the guest proves the account", () => {
      const party = mergeRosterIntoParty([], [entry(OFFICE_ID, "Bob B.", false)]);
      expect(splitPartyBySignability(party).needSignIn).toHaveLength(1);
      // "Sign in / find people" → OTP → handleVerified resolves the SHORT id from the
      // verified phone → the real account supersedes the placeholder in place.
      const verified = local({
        id: "uuid-bob",
        firstName: "Bob",
        lastName: "Beta",
        bmiPersonId: OFFICE_ID,
        pandoraPersonId: SHORT_ID,
        phone: "2395551212",
      });
      const next = addMemberSupersedingPreload(party, verified);
      expect(next).toEqual([verified]); // one card for one human, never two
      const split = splitPartyBySignability(next);
      expect(split.needSignIn).toEqual([]);
      expect(split.signable).toEqual([verified]);
      expect(shortPandoraId(next[0])).toBe(SHORT_ID); // …and now it can sign
    });

    it("speaks about preloaded rows only", () => {
      // A member added on THIS device carrying only an Office id is the manual path's
      // business: KioskPartyManager holds their phone/email and resolves the short id
      // itself. The preload must not put words in that flow's mouth, or hold it back.
      const manual = local({ bmiPersonId: OFFICE_ID, waiverValid: false });
      expect(preloadNeedsSignIn(manual)).toBe(false);
      expect(splitPartyBySignability([manual]).needSignIn).toEqual([]);
    });
  });

  describe("shape 3 — no usable dedup identity and no birthdate", () => {
    it("can never run a Pandora create — so the id we hold is the only id it gets", () => {
      // This is the precondition every other decision rests on, and it is true for
      // BOTH id forms. chooseGuardian attempts pandoraCreatePerson only when
      // `(phone || email) && dobIso`; a preloaded row fails all three, and cannot
      // acquire any of them (the setup form's only input is the DOB). A create here
      // would either 400 "Validation Exception" or, worse, succeed and mint a
      // duplicate person named "Ann A." — the 2026-07-25 Strachan class.
      const party = mergeRosterIntoParty(
        [],
        [entry(SHORT_ID, "Ann A.", false), entry(OFFICE_ID, "Bob B.", false)],
      );
      for (const m of party) {
        expect(m.phone).toBeUndefined();
        expect(m.email).toBeUndefined();
        expect(m.dobIso).toBeUndefined();
        expect(couldCreatePerson(m)).toBe(false);
      }
      // Which is exactly why signability may only ever be read off the id FORM.
      expect(preloadCanSign(party[0])).toBe(true);
      expect(preloadCanSign(party[1])).toBe(false);
    });

    it("is never offered as a guardian on an id whose signature we cannot place", () => {
      // A preloaded row has no birthdate, so `isMinor` is unset, so KioskPartyManager
      // counts it as an ADULT and offers it as a guardian candidate for someone
      // else's minor. For a 17-digit row chooseGuardian would then fall back to the
      // OFFICE id and file the MINOR's waiver with that as sigPersonID — the same
      // unproven id, now on someone else's signature, and with no age we ever checked.
      // Holding the row out of the party prop removes it from `adults` too.
      const party = mergeRosterIntoParty(
        [],
        [entry(OFFICE_ID, "Bob B.", false), entry(SHORT_ID, "Ann A.", false)],
      );
      expect(party.every((m) => m.isMinor === undefined)).toBe(true);
      const { signable } = splitPartyBySignability(party);
      expect(guardianCandidates(signable).map((m) => m.firstName)).toEqual(["Ann"]);
      // Ann is a safe candidate for a different reason, and it is worth pinning:
      // chooseGuardian resolves her SHORT id, and pandoraCheckWaiver then hands back
      // BMI's birthdate, so the under-18 gate has something real to fire on.
      expect(shortPandoraId(signable[0])).toBe(SHORT_ID);
    });

    it("holds back a whole roster of Office ids without inventing a green card", () => {
      // The worst real shape: every registered person came in through the Office
      // lookup. The manager gets an empty party (so it shows its own "add / sign in"
      // entry points), the page lists all four as outstanding, and nothing about this
      // device's completion changes — it still owns nobody.
      const party = mergeRosterIntoParty(
        [],
        ["1", "2", "3", "4"].map((n) => entry(`5138360812345678${n}`, `P${n} X.`, false)),
      );
      const { signable, needSignIn } = splitPartyBySignability(party);
      expect(signable).toEqual([]);
      expect(needSignIn).toHaveLength(4);
      expect(unsignedPreloadCount(party)).toBe(4);
      expect(membersOwnedHere(party, new Set())).toEqual([]);
      expect(peopleReady(party, [])).not.toBe(true); // ⇒ no terminal card
    });
  });
});

describe("addMemberSupersedingPreload", () => {
  it("replaces the placeholder in place, keeping the real member's own id", () => {
    // The caller's async follow-ups (authoritative Pandora waiver check, linked
    // family) patch by the id THEY minted — so the added member keeps it.
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", false), entry("12", "Bob B.", false)],
    );
    const real = local({
      id: "uuid-ann",
      bmiPersonId: "11",
      waiverValid: true,
      phone: "2395551212",
    });
    const next = addMemberSupersedingPreload(party, real);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(real); // same position, real identity
    expect(next[1].id).toBe("res:12");
    expect(next.filter(isPreloadedMember)).toHaveLength(1);
  });

  it("re-points a minor whose guardian was the superseded placeholder", () => {
    const seeded = mergeRosterIntoParty([], [entry("12", "Dad D.", true)]);
    const withMinor = [
      ...seeded,
      local({ id: "uuid-kid", firstName: "Kid", isMinor: true, guardianMemberId: "res:12" }),
    ];
    const next = addMemberSupersedingPreload(
      withMinor,
      local({ id: "uuid-dad", firstName: "Dad", bmiPersonId: "12", waiverValid: true }),
    );
    expect(next[0].id).toBe("uuid-dad");
    expect(next[1].guardianMemberId).toBe("uuid-dad"); // never left dangling
  });

  it("appends when the person is not on the roster at all", () => {
    const party = mergeRosterIntoParty([], [entry("11", "Ann A.", true)]);
    const walkUp = local({ id: "uuid-new", firstName: "Eve", bmiPersonId: "77" });
    expect(addMemberSupersedingPreload(party, walkUp).map((m) => m.id)).toEqual([
      "res:11",
      "uuid-new",
    ]);
  });

  it("never supersedes a locally added member (only placeholders)", () => {
    const first = local({ id: "uuid-a", bmiPersonId: "11" });
    const again = local({ id: "uuid-b", bmiPersonId: "11" });
    expect(addMemberSupersedingPreload([first], again)).toEqual([first, again]);
  });
});

/**
 * The completion gate. These are the tests that would have caught the original
 * defect: `ready` was `peopleReady(party, EVERY party id)`, so a preloaded person
 * who had not signed blocked the device that could do nothing about them — no "All
 * waivers signed", no "I'm done", no end to the flow. peopleReady is unchanged and
 * still shared with the kiosk; what changed is the participating set handed to it.
 */
describe("membersOwnedHere", () => {
  const untouched: ReadonlySet<string> = new Set<string>();
  /** Signing patches waiverValid BY ID, so a preloaded row keeps its `res:` mark. */
  const sign = (party: PartyMember[], id: string) =>
    party.map((m) => (m.id === id ? { ...m, waiverValid: true } : m));

  const eightPerson = [
    entry("11", "Ann A.", false),
    entry("12", "Bob B.", false),
    entry("13", "Cid C.", false),
    entry("14", "Dee D.", false),
    entry("15", "Eve E.", true),
    entry("16", "Fay F.", true),
    entry("17", "Gus G.", true),
    entry("18", "Hal H.", true),
  ];

  it("lets a guest who signed only THEMSELVES reach the end of the flow", () => {
    // The reported defect, verbatim: 8-person racing booking, 4 unsigned, the guest
    // opens the forwarded link and signs their own row.
    const party = mergeRosterIntoParty([], eightPerson);
    const afterAnn = sign(party, "res:11");
    const signedHere = new Set(["res:11"]);

    const mine = membersOwnedHere(afterAnn, signedHere);
    expect(mine.map((m) => m.id)).toEqual(["res:11"]);
    expect(
      peopleReady(
        afterAnn,
        mine.map((m) => m.id),
      ),
    ).toBe(true);

    // The old gate — every party id — is still stuck on Bob/Cid/Dee forever.
    const oldGate = peopleReady(
      afterAnn,
      afterAnn.map((m) => m.id),
    );
    expect(oldGate).not.toBe(true);
    expect(oldGate === true ? "" : oldGate.reason).toContain("Bob");

    // And the flow must still SAY that those three are outstanding.
    expect(unsignedPreloadCount(afterAnn)).toBe(3);
  });

  it("does not hand a green card to a guest who has done nothing", () => {
    // 4 of 8 already covered before this phone was even opened. A gate of
    // "!preloaded || waiverValid" would call those four this device's finished work
    // and show "you're all set" to someone who has not signed a thing.
    const party = mergeRosterIntoParty([], eightPerson);
    expect(membersOwnedHere(party, untouched)).toEqual([]);
    expect(peopleReady(party, [])).not.toBe(true); // ⇒ no terminal card
  });

  it("owns every member added on this device, finished or not", () => {
    const party = [
      ...mergeRosterIntoParty([], [entry("11", "Ann A.", false)]),
      local({ id: "uuid-kid", firstName: "Kid" }),
    ];
    const mine = membersOwnedHere(party, untouched);
    expect(mine.map((m) => m.id)).toEqual(["uuid-kid"]);
    // A half-finished member added HERE does block — it is this device's job.
    const gate = peopleReady(
      party,
      mine.map((m) => m.id),
    );
    expect(gate).not.toBe(true);
    expect(gate === true ? "" : gate.reason).toContain("Kid");
  });

  it("owns a promoted guardian and a real sign-in that superseded a placeholder", () => {
    const party = addMemberSupersedingPreload(
      mergeRosterIntoParty([], [entry("11", "Ann A.", false), entry("12", "Bob B.", false)]),
      local({ id: "uuid-ann", bmiPersonId: "11", waiverValid: true }),
    );
    expect(membersOwnedHere(party, untouched).map((m) => m.id)).toEqual(["uuid-ann"]);
    expect(peopleReady(party, ["uuid-ann"])).toBe(true);
  });

  it("owns a minor whose waiver a guardian signed here", () => {
    // The guardian chain reports the MINOR's member id too, so the minor becomes
    // this device's work even though the row came off the reservation.
    const party = sign(mergeRosterIntoParty([], [entry("11", "Kid K.", false)]), "res:11");
    const withGuardian = party.map((m) => ({ ...m, isMinor: true, guardianMemberId: "uuid-dad" }));
    const mine = membersOwnedHere(withGuardian, new Set(["res:11"]));
    expect(mine.map((m) => m.id)).toEqual(["res:11"]);
    expect(
      peopleReady(
        withGuardian,
        mine.map((m) => m.id),
      ),
    ).toBe(true);
  });

  it("ignores a signedHere id that is no longer on the party", () => {
    // "I'm done" wipes the party; a stale id must not resurrect anything.
    expect(membersOwnedHere([], new Set(["res:11"]))).toEqual([]);
  });
});

describe("unsignedPreloadCount", () => {
  it("counts only reservation rows nobody here has touched", () => {
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", false), entry("12", "Bob B.", true), entry("13", "Cid C.", false)],
    );
    expect(unsignedPreloadCount(party)).toBe(2);
    // A locally added member is this device's work, never the group's remainder —
    // otherwise "2 more people on this reservation" would count the guest's own kid.
    expect(unsignedPreloadCount([...party, local({ id: "uuid-kid", firstName: "Kid" })])).toBe(2);
  });

  it("is 0 for a covered party — and that alone may NOT say 'All waivers signed'", () => {
    // This test used to be titled "the one case that may say 'All waivers signed'".
    // It is not that case, and reading it that way is what shipped the lie: the count
    // is a floor under what is ON SCREEN, and a screen can be empty for reasons that
    // have nothing to do with the booking. Same zero, three very different bookings.
    const covered = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", true), entry("12", "Bob B.", true)],
    );
    expect(unsignedPreloadCount(covered)).toBe(0);
    // …and only the first of these is actually covered.
    const roster = [entry("11", "Ann A.", true), entry("12", "Bob B.", true)];
    expect(reservationWaiverStatus({ signed: 2, total: 2, roster, party: covered })).toEqual({
      kind: "covered",
    });
    // BMI's persons_list came back empty on a booking for 8 — zero unsigned rows, and
    // nobody has signed anything.
    expect(
      reservationWaiverStatus({ signed: 0, total: 8, roster: [], party: [] }),
    ).not.toMatchObject({ kind: "covered" });
    // The guest removed the four cards that were not their family.
    expect(
      reservationWaiverStatus({
        signed: 4,
        total: 8,
        roster: [...roster, entry("13", "Cid C.", false), entry("14", "Dee D.", false)],
        party: covered,
      }),
    ).toEqual({ kind: "outstanding", count: 2 });
  });

  it("drops as this device resolves rows, by signature or by supersede", () => {
    const party = mergeRosterIntoParty(
      [],
      [entry("11", "Ann A.", false), entry("12", "Bob B.", false)],
    );
    expect(unsignedPreloadCount(party)).toBe(2);
    const signed = party.map((m) => (m.id === "res:11" ? { ...m, waiverValid: true } : m));
    expect(unsignedPreloadCount(signed)).toBe(1);
    const superseded = addMemberSupersedingPreload(
      signed,
      local({ id: "uuid-bob", firstName: "Bob", bmiPersonId: "12", waiverValid: true }),
    );
    expect(unsignedPreloadCount(superseded)).toBe(0);
  });

  it("is 0 with no roster at all (a group function preloads nobody)", () => {
    expect(unsignedPreloadCount([local({ id: "uuid-a", waiverValid: true })])).toBe(0);
  });
});

/**
 * WHAT THE PAGE MAY CLAIM ABOUT THE WHOLE BOOKING (invariant 6).
 *
 * Round 2 wrote the honest sentence and then licensed it with the wrong number: "no
 * unsigned roster rows on this screen". A screen empties for reasons that have
 * nothing to do with a reservation — BMI's persons_list can come back EMPTY on a
 * booking whose `persons` headcount is 8, the guest can remove the cards that are not
 * their family, and "I'm done" wipes the list on purpose — and each one of those read
 * as "All waivers signed" for a booking where nobody had signed.
 *
 * So these tests are written the other way round: every case names the booking, and
 * asserts what the page is ALLOWED to say about it.
 */
describe("reservationWaiverStatus", () => {
  const sign = (party: PartyMember[], id: string) =>
    party.map((m) => (m.id === id ? { ...m, waiverValid: true } : m));

  /** The reported booking: 8 registered, 4 of them without a waiver. */
  const eight = [
    entry("11", "Ann A.", false),
    entry("12", "Bob B.", false),
    entry("13", "Cid C.", false),
    entry("14", "Dee D.", false),
    entry("15", "Eve E.", true),
    entry("16", "Fay F.", true),
    entry("17", "Gus G.", true),
    entry("18", "Hal H.", true),
  ];
  /** …and what /api/waiver/context ships with it (`signed = min(validCount, persons)`). */
  const ctxEight = { signed: 4, total: 8, roster: eight };

  it("owes the exact remainder while the guest signs only their own row", () => {
    const party = sign(mergeRosterIntoParty([], eight), "res:11");
    expect(reservationWaiverStatus({ ...ctxEight, party })).toEqual({
      kind: "outstanding",
      count: 3,
    });
  });

  it("counts the RESERVATION, so removing other people's cards cannot finish it", () => {
    const party = sign(mergeRosterIntoParty([], eight), "res:11").filter(
      (m) => !["res:12", "res:13", "res:14"].includes(m.id),
    );
    // Nothing unsigned is on screen any more…
    expect(unsignedPreloadCount(party)).toBe(0);
    // …and Bob, Cid and Dee still have no waiver.
    expect(reservationWaiverStatus({ ...ctxEight, party })).toEqual({
      kind: "outstanding",
      count: 3,
    });
  });

  it("survives the 'I'm done' wipe without asking twice for what it just filed", () => {
    const party = sign(mergeRosterIntoParty([], eight), "res:11");
    // What the wipe carries forward: ids only, no names.
    const carried = coveredPersonIds(party);
    expect(carried.has("11")).toBe(true);
    expect(reservationWaiverStatus({ ...ctxEight, party: [], covered: carried })).toEqual({
      kind: "outstanding",
      count: 3,
    });
    // Without the carry-over the next person in line is told to sign Ann again.
    expect(reservationWaiverStatus({ ...ctxEight, party: [] })).toEqual({
      kind: "outstanding",
      count: 4,
    });
  });

  it("says covered when this device finishes the last of them", () => {
    // The organizer case: the frozen fraction still reads 4 of 8, and the roster —
    // live, per-person, and naming the whole booking — knows better.
    let party = mergeRosterIntoParty([], eight);
    for (const id of ["res:11", "res:12", "res:13", "res:14"]) party = sign(party, id);
    expect(reservationWaiverStatus({ ...ctxEight, party })).toEqual({ kind: "covered" });
  });

  it("does NOT let an empty persons_list read as a covered booking", () => {
    // `roster: []` is a real answer, and `total` is BMI's `persons` headcount — so this
    // is 8 registered guests, none of them signed, and one signature on this phone.
    const party = [local({ id: "uuid-me", bmiPersonId: "713365", waiverValid: true })];
    expect(unsignedPreloadCount(party)).toBe(0);
    expect(reservationWaiverStatus({ signed: 0, total: 8, roster: [], party })).toEqual({
      kind: "outstanding",
      count: null,
    });
  });

  it("does NOT let a ZERO headcount plus a join-only roster read as covered", () => {
    // BMI `persons` absent AND persons_list empty (total = 0), but one walk-in has
    // signed via a Neon join — the roster is nonempty and fully covered, yet it
    // names a booking whose headcount we never learned. `roster.length >= total`
    // is trivially true of ANY roster when total is 0; that must not be a verdict.
    const walkInOnly = [entry("99", "Wal K.", true)];
    expect(reservationWaiverStatus({ signed: 0, total: 0, roster: walkInOnly, party: [] })).toEqual(
      { kind: "unknown" },
    );
  });

  it("believes the roster over a CLAMPED fraction that reads 8 of 8", () => {
    // The route clamps: `signed = Math.min(validCount, total)`. Two join-only signers
    // push validCount to 8 on an 8-head booking while two registered guests are
    // genuinely uncovered — the fraction cannot show it, the roster can.
    const roster = [
      entry("11", "Ann A.", false),
      entry("12", "Bob B.", false),
      ...["13", "14", "15", "16", "17", "18"].map((id) => entry(id, `P${id}`, true)),
      entry("91", "Ivy I.", true),
      entry("92", "Jay J.", true),
    ];
    expect(reservationWaiverStatus({ signed: 8, total: 8, roster, party: [] })).toEqual({
      kind: "outstanding",
      count: 2,
    });
  });

  it("will not close the question when the roster names fewer people than heads", () => {
    // persons = 8, persons_list names 4. The other four are registered heads with no
    // person record to sign against — covered is not available, and neither is a count.
    const roster = ["11", "12", "13", "14"].map((id) => entry(id, `P${id}`, true));
    expect(reservationWaiverStatus({ signed: 4, total: 8, roster, party: [] })).toEqual({
      kind: "outstanding",
      count: null,
    });
  });

  it("never reads lower than the Sign-waiver buttons on screen", () => {
    // The sweep union is cached 60s and folds joins by NAME; KioskPartyManager's
    // authoritative Pandora re-check can patch `waiverValid: false` onto a row it
    // called covered. Whatever the fetched roster says, the guest is looking at an
    // unsigned card, and no group-wide sentence may read past it.
    const roster = [entry("11", "Ann A.", true), entry("12", "Bob B.", true)];
    const party = mergeRosterIntoParty([], roster).map((m) =>
      m.id === "res:11" ? { ...m, waiverValid: false } : m,
    );
    expect(reservationWaiverStatus({ signed: 2, total: 2, roster, party })).toEqual({
      kind: "outstanding",
      count: 1,
    });
  });

  it("does not hold the booking open for someone this device just added", () => {
    // A half-finished local member is this DEVICE's job — `ready` blocks on them, and
    // the group-wide sentence must not turn the guest's own kid into "1 more person on
    // this reservation".
    const roster = [entry("11", "Ann A.", true), entry("12", "Bob B.", true)];
    const party = [
      ...mergeRosterIntoParty([], roster),
      local({ id: "uuid-kid", firstName: "Kid" }),
    ];
    expect(reservationWaiverStatus({ signed: 2, total: 2, roster, party })).toEqual({
      kind: "covered",
    });
  });

  it("falls back to the authoritative fraction for a group function (no roster)", () => {
    expect(reservationWaiverStatus({ signed: 10, total: 10, party: [] })).toEqual({
      kind: "covered",
    });
    expect(reservationWaiverStatus({ signed: 6, total: 10, party: [] })).toEqual({
      kind: "outstanding",
      count: null,
    });
  });

  it("stops claiming a shortfall this device could already have closed", () => {
    // 6 of 10 at page load, four people covered here since. The frozen fraction cannot
    // see them, so it may not nag — a wrong count is how you tell people who already
    // signed to sign again.
    const party = ["a", "b", "c", "d"].map((k) =>
      local({ id: `uuid-${k}`, bmiPersonId: `7133${k.charCodeAt(0)}`, waiverValid: true }),
    );
    expect(reservationWaiverStatus({ signed: 6, total: 10, party })).toEqual({ kind: "unknown" });
  });

  it("says unknown — never covered — when there is nothing to go on", () => {
    // Sweep missed its deadline: no fraction, no roster.
    expect(reservationWaiverStatus({ total: 8, party: [] })).toEqual({ kind: "unknown" });
    // No headcount either.
    expect(reservationWaiverStatus({ party: [] })).toEqual({ kind: "unknown" });
    // An empty booking is not a vacuously finished one: `0 >= 0` must not license the
    // claim, and an empty roster names nobody and so proves nothing.
    expect(reservationWaiverStatus({ signed: 0, total: 0, roster: [], party: [] })).toEqual({
      kind: "unknown",
    });
  });
});

describe("coveredPersonIds", () => {
  it("collects every id form of everyone covered, and nobody else", () => {
    // A returning racer is known by BOTH ids and BMI's persons_list names whichever
    // one they were registered under — matching on one form only would lose them.
    const party = [
      local({
        id: "uuid-a",
        bmiPersonId: "51383608123456789",
        pandoraPersonId: "713365",
        waiverValid: true,
      }),
      local({ id: "uuid-b", bmiPersonId: "713366", waiverValid: false }),
    ];
    expect([...coveredPersonIds(party)].sort()).toEqual(["51383608123456789", "713365"]);
  });

  it("carries proofs forward without mutating the set it was handed", () => {
    // It is React state: mutating it in place would skip the re-render.
    const carried: ReadonlySet<string> = new Set(["11"]);
    const next = coveredPersonIds(
      [local({ id: "uuid-a", bmiPersonId: "12", waiverValid: true })],
      carried,
    );
    expect([...next].sort()).toEqual(["11", "12"]);
    expect([...carried]).toEqual(["11"]);
  });
});

/**
 * The progress bar is a CLAIM. A full cyan bar over "8 of 8 signed" says exactly what
 * the card at the bottom says, and it used to say it off `signedCount / party.length`
 * — this device's own rows as both numerator and denominator.
 */
describe("waiverProgress", () => {
  const outstanding = { kind: "outstanding", count: 3 } as const;

  it("standalone: the party on screen IS the whole story", () => {
    expect(waiverProgress({ status: null, partySize: 3, partySigned: 1 })).toEqual({
      signed: 1,
      total: 3,
    });
  });

  it("cannot be filled by a wiped or trimmed party", () => {
    // The regression, verbatim: two rows signed on this phone rendered a FULL bar over
    // "2 of 2 signed" for a booking with three people outstanding. It now reads the
    // booking — 8 heads, 3 owed — whatever is left on screen.
    expect(
      waiverProgress({ status: outstanding, partySize: 2, partySigned: 2, signed: 4, total: 8 }),
    ).toEqual({ signed: 5, total: 8 });
  });

  it("agrees with the sentence underneath it — the remainder IS the count", () => {
    // "5 of 8 signed" over "3 more people on this reservation still need a waiver".
    // Two numbers describing one booking must not be computed two different ways.
    for (const count of [1, 3, 7]) {
      const bar = waiverProgress({
        status: { kind: "outstanding", count },
        partySize: 8,
        partySigned: 8,
        signed: 8, // the CLAMPED fraction, which on its own would fill the bar
        total: 8,
      });
      expect(bar.total - bar.signed).toBe(count);
      expect(bar.signed).toBeLessThan(bar.total);
    }
  });

  it("stays one short of full when the remainder cannot be counted", () => {
    expect(
      waiverProgress({
        status: { kind: "outstanding", count: null },
        partySize: 8,
        partySigned: 8,
        signed: 4,
        total: 8,
      }),
    ).toEqual({ signed: 7, total: 8 });
  });

  it("fills only on a covered booking with nothing outstanding on screen", () => {
    // `covered` is a verdict on the REGISTERED heads. It says nothing about a card the
    // guest added, so it may not fill a bar that has an unsigned one under it.
    expect(
      waiverProgress({
        status: { kind: "covered" },
        partySize: 8,
        partySigned: 8,
        signed: 4,
        total: 8,
      }),
    ).toEqual({ signed: 8, total: 8 });
    // Same booking, three cards on screen still unsigned: 5 of 8, bar not full.
    expect(
      waiverProgress({
        status: { kind: "covered" },
        partySize: 8,
        partySigned: 5,
        signed: 4,
        total: 8,
      }),
    ).toEqual({ signed: 5, total: 8 });
    // …and extras the guest added fill it again once THEY are signed.
    expect(
      waiverProgress({
        status: { kind: "covered" },
        partySize: 10,
        partySigned: 10,
        signed: 8,
        total: 8,
      }),
    ).toEqual({ signed: 10, total: 10 });
  });

  it("never shows fewer empty segments than there are unsigned cards under it", () => {
    // The round-3 over-claim, in the three shapes it was reachable in. The denominator
    // is floored by the party; without the same floor on the UNSIGNED side every extra
    // head the guest added was silently credited as a signature.
    //
    //  A — covered 2-head booking + one walk-in the guest added, nobody else signed.
    //      Read "3 of 3 signed" under a FULL bar with a Sign-waiver button on screen,
    //      and this is the party shape "does not hold the booking open for someone this
    //      device just added" declares canonical.
    expect(
      waiverProgress({
        status: { kind: "covered" },
        partySize: 3,
        partySigned: 2,
        signed: 2,
        total: 2,
      }),
    ).toEqual({ signed: 2, total: 3 });
    //  B — solo booking, NOTHING signed, guest adds three family members. Read
    //      "3 of 4 signed": three signatures that do not exist.
    expect(
      waiverProgress({
        status: { kind: "outstanding", count: 1 },
        partySize: 4,
        partySigned: 0,
        signed: 0,
        total: 1,
      }),
    ).toEqual({ signed: 0, total: 4 });
    //  C — 8 heads, 3 signed, guest adds six. Read "9 of 14 signed"; over-claimed six.
    expect(
      waiverProgress({
        status: { kind: "outstanding", count: 5 },
        partySize: 14,
        partySigned: 3,
        signed: 3,
        total: 8,
      }),
    ).toEqual({ signed: 3, total: 14 });
  });

  it("can only be filled by `covered` — quantified, not asserted case by case", () => {
    // The one-way implication the whole function exists to guarantee. Filling the bar
    // IS the completion claim, so no other status may reach it, whatever the numbers.
    for (const partySize of [0, 1, 3, 8, 14]) {
      for (const partySigned of [0, 1, 3, 8, 14]) {
        if (partySigned > partySize) continue;
        for (const signed of [0, 3, 8]) {
          for (const total of [1, 8]) {
            for (const status of [
              { kind: "unknown" } as const,
              { kind: "outstanding", count: null } as const,
              { kind: "outstanding", count: 1 } as const,
              { kind: "outstanding", count: 99 } as const,
            ]) {
              const bar = waiverProgress({ status, partySize, partySigned, signed, total });
              const label = `${JSON.stringify({ status, partySize, partySigned, signed, total })} → ${JSON.stringify(bar)}`;
              expect(bar.signed, label).toBeLessThan(bar.total);
              expect(bar.signed, label).toBeGreaterThanOrEqual(0);
              // …and never fewer empty segments than unsigned cards on screen.
              expect(bar.total - bar.signed, label).toBeGreaterThanOrEqual(
                Math.min(partySize - partySigned, bar.total),
              );
            }
          }
        }
      }
    }
  });

  it("moves as this device signs, without waiting for the frozen server count", () => {
    expect(
      waiverProgress({ status: outstanding, partySize: 8, partySigned: 5, signed: 4, total: 8 }),
    ).toEqual({ signed: 5, total: 8 });
  });

  it("takes the party as a floor on the denominator, never as the denominator", () => {
    // A guest may add someone who was never registered: the bar must not read 9 of 8.
    expect(
      waiverProgress({
        status: { kind: "unknown" },
        partySize: 9,
        partySigned: 9,
        signed: 4,
        total: 8,
      }),
    ).toEqual({ signed: 8, total: 9 });
  });

  it("hides the bar rather than guess a denominator (0 of 0 renders nothing)", () => {
    const unknown = { kind: "unknown" } as const;
    expect(waiverProgress({ status: unknown, partySize: 3, partySigned: 3 })).toEqual({
      signed: 0,
      total: 0,
    });
    expect(waiverProgress({ status: unknown, partySize: 3, partySigned: 3, signed: 0 })).toEqual({
      signed: 0,
      total: 0,
    });
    // Same rule EventInfoCard already follows: no fraction until the count is real.
    expect(waiverProgress({ status: unknown, partySize: 3, partySigned: 3, total: 8 })).toEqual({
      signed: 0,
      total: 0,
    });
  });
});

/**
 * THE WIRING — asserted from source, because the defect this round fixed was not in
 * this module at all. Round 2 computed the flag correctly, wrote honest copy about
 * it, and then handed KioskPartyManager the WHOLE party anyway, so the row it had
 * just warned about still rendered a "Sign waiver" button that ended on an error.
 * Every unit test above was green throughout.
 *
 * There is no RTL harness for WaiverFlow, so this pins the two halves that have to
 * disagree — the manager gets the SUBSET, the bookkeeping keeps the WHOLE — in the
 * same style as share-disclosure.test.ts and waiver-party.theme.test.ts. If one of
 * these goes red, re-read the split's contract in roster-preload.ts; don't relax it.
 */
describe("WaiverFlow wiring", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "WaiverFlow.tsx"),
    "utf8",
  );

  it("hands KioskPartyManager the signable subset, never the whole party", () => {
    expect(source).toMatch(/splitPartyBySignability\(party\)/);
    expect(source).toMatch(/party=\{signable\}/);
    // The regression, verbatim: the manager renders "Sign waiver" for every member
    // needsSetup() is true for, so giving it a row we cannot sign IS the dead end.
    expect(source).not.toMatch(/party=\{party\}/);
    // includedIds has to travel with it, or the manager's own blockReason banner
    // reports on members it is not rendering.
    expect(source).toMatch(/includedIds=\{signableIds\}/);
  });

  it("uses the subset ONLY to build the manager's props — never to count or to gate", () => {
    // This is what makes holding a row back honest rather than a disappearing act:
    // the reservation still owes the waiver, the header still counts the person, the
    // completion gate is unchanged, and their placeholder is still there to be
    // superseded when they verify. All of that holds for exactly one reason — every
    // counter and gate reads the FULL `party` — so instead of naming today's counters
    // (they get refactored; this test should not break when they do) every use of
    // `signable` is enumerated. A new one that isn't a prop is the regression.
    const uses = source.match(/^.*\bsignable\b.*$/gm) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    const allowed = [
      /=\s*splitPartyBySignability\(party\)/, // the split itself
      /const signableIds = new Set\(signable\.map\(/, // the ids that travel with it
      /party=\{signable\}/, // the prop
      /includedIds=\{signableIds\}/, // and its companion
      /^\s*(\/\/|\*|\{\/\*)/, // prose about it
    ];
    for (const line of uses) {
      expect(
        allowed.some((re) => re.test(line)),
        `\`signable\` used outside the party manager's props — a count or gate built ` +
          `from the subset would under-report the booking: ${line.trim()}`,
      ).toBe(true);
    }
    // And the gate itself still reads the whole party.
    expect(source).toMatch(/membersOwnedHere\(party,\s*signedHere\)/);
    expect(source).toMatch(/addMemberSupersedingPreload\(p,\s*\w+\)/);
  });

  it("shows the held-back people by name instead of hiding them", () => {
    // A row with no card and no mention would just be a person who quietly vanished
    // off a booking they are on — and nobody would sign for them.
    expect(source).toMatch(/needSignIn\.length > 0/);
    expect(source).toMatch(/needSignIn\.map\(/);
    expect(source).toContain("Sign in / find people");
  });
});
