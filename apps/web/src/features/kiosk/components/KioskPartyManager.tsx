"use client";

/**
 * Kiosk party manager — the ONE identity method extracted from
 * KioskPeopleStep so BOTH the booking wizard (race / waiver-gated
 * attractions) AND the standalone group-waiver flow share the exact same
 * screens (owner 2026-07-18: "why the different sign-ins?"; group-waiver
 * reuse per owner ask 2026-07-18: "use the add new player screen and
 * existing person screen we have on the race flow").
 *
 * The component is session-agnostic: the party lives wherever the consumer
 * keeps it (booking session for the wizard, local state for the waiver
 * page) and mutations flow through callbacks. `mode` carries the only
 * behavioral splits:
 *   - "race": 7+ hard age floor, tier badges, whole-party semantics.
 *   - "attraction": per-activity include toggle on each card.
 *   - "waiver": no main-contact concept (onSetContact omitted → no Main
 *     badge, no main-email requirement), no include toggle, no age floor —
 *     group events legitimately include kids too young to race.
 *
 * Business rules that apply in EVERY mode (moved verbatim):
 *   - every participant needs a real account + a signed waiver captured
 *     right here (owner rule — all activities except bowling & duckpin).
 *   - a MINOR (age < 18) needs a registered ADULT guardian picked from the
 *     roster; the guardian's person id rides Pandora onboarding.
 *   - NEW racers are Starter-only (badge); RETURNING racers show their
 *     earned tier + credits (race mode).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CenterCode, PartyMember } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import { tierFromMemberships } from "~/features/booking/service/race-products";
import WaiverSigning from "@/components/pandora/WaiverSigning";
import {
  pandoraOnboardGuest,
  pandoraFetchWaiverTemplate,
  pandoraCreatePerson,
  pandoraCheckWaiver,
  type PandoraWaiverTemplate,
} from "@/lib/pandora";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";
import { useKioskConfig } from "../KioskConfigContext";
import { useT } from "../i18n";
import { kioskHasCamera, kioskId } from "../config";
import { useMobileJoin } from "../hooks/useMobileJoin";
import { ageFromIso } from "../join/phone/join-helpers";
import { mergeJoinedGuests } from "../join/merge";
import { kioskMobileJoinEnabled } from "../flags";
import { KioskSignInBoxes } from "./KioskSignInBoxes";
import { KioskWaiverPhoto } from "./KioskWaiverPhoto";
import { formatPersonName } from "~/lib/helpers/name-format";
import { useLicenseScan, type AamvaLicense, type MemberQr } from "../qr-scanner";
import {
  fetchLicenseMatches,
  fetchMemberMatches,
  personDataFromMatch,
  prewarmLicenseLookup,
} from "../license/lookup-client";
import type { LicenseMatch } from "../license/types";
import { LicenseMatchPicker } from "./LicenseMatchPicker";

export type PartyManagerMode = "race" | "attraction" | "waiver";

export interface KioskPartyManagerProps {
  mode: PartyManagerMode;
  /** The roster. Session-scoped in the wizard; page-local in the waiver flow. */
  party: PartyMember[];
  /** Pandora location key — session.entryBrand in the wizard. Center-first:
   *  "naples" for a Naples booking (the mobile /waiver flow passes it). */
  brandLocation: "fasttrax" | "headpinz" | "naples";
  /** Venue center (photo uploads use "naples" at Naples) — session.center in the wizard. */
  center: CenterCode | null;
  /** Contact fallbacks used inside submitNew/submitSetup — session.contact in the wizard. */
  contactEmail?: string;
  contactPhone?: string;
  /** Who's in THIS activity (attraction toggle). Race/waiver: pass all ids / a no-op. */
  includedIds: Set<string>;
  onIncludedChange: (ids: Set<string>) => void;
  /** Roster mutations — mapped onto the booking reducer by the step wrapper. */
  onAddMember: (m: PartyMember) => void;
  onUpdateMember: (id: string, patch: Partial<PartyMember>) => void;
  onRemoveMember: (id: string) => void;
  /** Present in race/attraction (dispatch setContact); OMIT in waiver mode —
   *  hides Main/"Make main" and drops the main-person email requirement. */
  onSetContact?: (m: PartyMember) => void;
  /** StepDef setBusy passthrough. */
  setBusy?: (b: boolean) => void;
  /** When true, a MINOR's waiver is signed BY their guardian (the guardian's
   *  SHORT Pandora id rides Pandora's sigPersonID; the guardian signs their own
   *  waiver first if it's lapsed). Default false = the minor self-signs
   *  (unchanged kiosk behavior). Turned on by the mobile /waiver flow. */
  guardianSigning?: boolean;
  /** WHERE a minor's guardian is resolved.
   *
   *  "form" (default, unchanged) — a guardian is picked on the player form and a
   *  minor cannot be added before a registered adult exists.
   *
   *  "sign-time" — the model KioskPeopleStep uses (owner 2026-07-18): the minor
   *  registers FIRST with no adult required, and the guardian is resolved only
   *  when the minor's waiver actually needs signing, via a choose / add-new /
   *  look-up overlay. A guardian added there is SIGNER-ONLY — they live in
   *  `guardians`, never in `party`, so they are never part of the purchase
   *  ("the parent may just be paying for the kids") until "Join the fun". */
  guardianResolution?: "form" | "sign-time";
  /** Signer-only guardians (sign-time resolution). Consumer-owned, like `party`. */
  guardians?: PartyMember[];
  onAddGuardian?: (m: PartyMember) => void;
  onUpdateGuardian?: (id: string, patch: Partial<PartyMember>) => void;
  /** "Join the fun" — the SAME object id moves onto the roster, so minors'
   *  guardianMemberId refs stay valid. */
  onPromoteGuardian?: (m: PartyMember) => void;
  /** Visual theme. "kiosk" (default) keeps the fixed 1080-wide kiosk canvas
   *  classes, byte-identical to today. "mobile" adds a `wp-mobile` root hook that
   *  the mobile /waiver flow's stylesheet uses to render a phone-native layout. */
  theme?: "kiosk" | "mobile";
  /** Whether a camera is available for the pre-signature photo. Defaults to the
   *  kiosk device config; the mobile flow passes it explicitly. */
  hasCamera?: boolean;
  /** Photo policy: "required-adults" (default — the kiosk behavior: shown when a
   *  camera is present; required for adults / optional for minors inside the photo
   *  component) or "off" to skip the photo step entirely. */
  photoStep?: "required-adults" | "off";
  /** Fires after each waiver is successfully signed (a self-sign, a guardian's
   *  own, or a minor's signed by a guardian) — the mobile /waiver flow posts an
   *  E-SIGN audit row. Kiosk consumers omit it (no-op). */
  onWaiverSigned?: (info: {
    memberId: string;
    personId: string;
    firstName: string;
    signerPersonId?: string;
    waiverId?: string;
    templateContentId?: string;
  }) => void;
  /** Supplies the pre-signature photo UI. Omitted = the kiosk's KioskWaiverPhoto
   *  (dual-camera, device config). The mobile /waiver flow passes a single
   *  front-camera MobileWaiverPhoto. The party overlay owns the upload; this only
   *  renders the capture UI and calls back onCaptured/onSkip. */
  renderPhoto?: (args: {
    memberName: string;
    isMinor: boolean;
    onCaptured: (pngBase64: string) => void;
    onSkip: () => void;
  }) => ReactNode;
}

function ageFromDob(mmddyyyy: string): number | null {
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dob = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthday =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

function toIsoDob(mmddyyyy: string): string {
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : mmddyyyy;
}

/** A participant still needs setup when they lack an account or a valid waiver. */
export function needsSetup(m: PartyMember): boolean {
  return !m.bmiPersonId || !m.waiverValid;
}

/** The SHORT Pandora id Pandora's waiver-sign accepts (a 17-digit Office id 500s
 *  on sign). A new-created person's bmiPersonId IS the short id; a returning
 *  lookup's id is the 17-digit Office id and needs an upsert-create to resolve
 *  the short id — null here signals "resolve the short id before signing." */
/** Prefix marking an error message as written BY US and safe to show a guest.
 *  Anything without it is upstream text and gets replaced with human copy. */
const GUEST_SAFE_ERROR = "guest:";

export function shortPandoraId(m: PartyMember): string | null {
  return m.pandoraPersonId ?? (m.bmiPersonId && m.bmiPersonId.length <= 12 ? m.bmiPersonId : null);
}

/** canAdvance shared logic: at least one participant, everyone set up + waivered,
 *  every minor has a guardian. `ids` = the participating member ids.
 *  TODO(i18n): module-scope + shared with canAdvance and checkin/server.ts, so it
 *  can't reach useT() — the `reason` strings stay English until validation copy is
 *  locale-threaded (see tasks/kiosk-i18n-spanish-plan.md). */
export function peopleReady(party: PartyMember[], ids: string[]): true | { reason: string } {
  if (ids.length === 0 || party.length === 0) {
    return { reason: "Add at least one player — everyone needs an account and waiver." };
  }
  const participating = party.filter((m) => ids.includes(m.id));
  const missing = participating.find((m) => needsSetup(m));
  if (missing) {
    return {
      reason: `${missing.firstName} still needs ${missing.bmiPersonId ? "a signed waiver" : "an account + waiver"} — tap Set up.`,
    };
  }
  const minorNoGuardian = participating.find((m) => m.isMinor && !m.guardianMemberId);
  if (minorNoGuardian) {
    return { reason: `Pick a guardian for ${minorNoGuardian.firstName}.` };
  }
  return true;
}

/** Patch for the member whose waiver just completed. Under sign-time resolution the
 *  guardian lives only in `guardianFlow` until this moment — record the link on the
 *  MINOR too, or peopleReady keeps demanding a guardian pick that already happened
 *  and the flow can never reach its done state (live /waiver, 2026-07-30). */
export function waiverCompletePatch(
  memberId: string,
  guardianFlow: { minorMemberId: string; guardianId?: string } | null,
): Partial<PartyMember> {
  return guardianFlow?.minorMemberId === memberId && guardianFlow.guardianId
    ? { waiverValid: true, guardianMemberId: guardianFlow.guardianId }
    : { waiverValid: true };
}

type FormState = { mode: "new" } | { mode: "setup"; member: PartyMember } | null;

/** A linked-family suggestion (opt-in — NOT auto-added to the party). */
interface LinkedSuggestion {
  id: string; // Pandora person id
  firstName: string;
  lastName: string;
  age: number | null;
  waiverValid: boolean;
}

export function KioskPartyManager({
  mode,
  party,
  brandLocation,
  center,
  contactEmail,
  contactPhone,
  includedIds,
  onIncludedChange,
  onAddMember,
  onUpdateMember,
  onRemoveMember,
  onSetContact,
  setBusy,
  guardianSigning = false,
  guardianResolution = "form",
  guardians = [],
  onAddGuardian,
  onUpdateGuardian,
  onPromoteGuardian,
  theme = "kiosk",
  hasCamera,
  photoStep = "required-adults",
  onWaiverSigned,
  renderPhoto,
}: KioskPartyManagerProps) {
  const t = useT();
  const isRace = mode === "race";

  // Racing races the whole party; an attraction toggles who's in THIS one.
  const included = includedIds;

  const [form, setForm] = useState<FormState>(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [guardianId, setGuardianId] = useState("");
  const signTimeGuardian = guardianResolution === "sign-time";
  // Sign-time guardian resolution (ported from KioskPeopleStep): the minor is
  // already registered; this finds the adult who signs. Cleared on cancel (the
  // minor stays "needs setup") and on the minor's waiver success.
  const [guardianFlow, setGuardianFlow] = useState<{
    minorMemberId: string;
    minorPersonId: string;
    minorTemplate: PandoraWaiverTemplate;
    guardianId?: string;
    stage: "choose" | "new-form" | "lookup";
  } | null>(null);
  // Guardian "add a new adult" fields — SEPARATE from the player form so the two
  // can never contaminate each other (the kiosk keeps them separate for the same
  // reason: both forms can be mid-entry at once).
  const [gFirst, setGFirst] = useState("");
  const [gLast, setGLast] = useState("");
  const [gDob, setGDob] = useState("");
  const [gPhone, setGPhone] = useState("");
  const [gEmail, setGEmail] = useState("");
  const [gError, setGError] = useState<string | null>(null);
  // The tapped chip fires 1-3 Pandora calls before anything else changes on
  // screen, so it must light up immediately or the tap reads as dead.
  const [choosingGuardianId, setChoosingGuardianId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusyLocal] = useState(false);
  const [waiverFor, setWaiverFor] = useState<{
    memberId: string;
    personId: string;
    template: PandoraWaiverTemplate;
    /** Guardian signing a MINOR's waiver: the guardian's SHORT Pandora id +
     *  display name (rides Pandora's sigPersonID). Absent = self-sign (adults;
     *  legacy paths where guardianID rode the person create instead). */
    signerPersonId?: string;
    signerName?: string;
  } | null>(null);
  // guardianSigning: while a guardian signs their OWN (lapsed) waiver first, the
  // pending minor waits here; the guardian's sign-complete chains straight to it.
  const [guardianChain, setGuardianChain] = useState<{
    minorMemberId: string;
    minorPersonId: string;
    minorTemplate: PandoraWaiverTemplate;
    guardianId: string;
    guardianSid: string;
    guardianName: string;
  } | null>(null);
  // Linked family are OPT-IN suggestions — tap to add, never auto-pulled in.
  const [linked, setLinked] = useState<LinkedSuggestion[]>([]);
  // Driver's-license scan flow (handlers live below, after handleVerified):
  // in-flight lookup / multi-match picker / one-line outcome note.
  const [licenseBusy, setLicenseBusy] = useState(false);
  // license is null when the picker came from an SMS-Timing member QR (no
  // scanned name/DOB to prefill a form with).
  const [licenseMatches, setLicenseMatches] = useState<{
    license: AamvaLicense | null;
    matches: LicenseMatch[];
  } | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // Members whose Pandora waiver status is still being fetched — a returning racer
  // lands with waiverValid unknown, so without this the card flashes "Waiver
  // needed" before the check resolves (owner 2026-07-19). Shown as "Checking
  // waiver…" instead, with no Set up button until we actually know.
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  // Waiver-time photo (owner 2026-07-18): captured BEFORE the signature —
  // required for adults, optional for minors. Tracks WHICH member's photo step
  // has been completed/skipped so each signer gets their own capture.
  const { config: kioskCfg } = useKioskConfig();
  const [photoDoneFor, setPhotoDoneFor] = useState<string | null>(null);
  // Camera source: an explicit prop (mobile) wins; else the kiosk device config.
  const hasCameraResolved = hasCamera ?? kioskHasCamera(kioskCfg);

  const adults = party.filter((m) => !m.isMinor);
  const setBusyAll = (b: boolean) => setBusyLocal(b);

  // The MAIN (billing contact) always renders first (owner 2026-07-18). Stable
  // sort — everyone else keeps add order.
  const orderedParty = [...party].sort(
    (a, b) => Number(!!b.isBillingCustomer) - Number(!!a.isBillingCustomer),
  );

  // A person chosen as someone's guardian can't be removed — that would orphan
  // the minor's booking (owner 2026-07-18). Their Remove is hidden until the
  // minor they cover is removed first.
  const isGuardianForSomeone = (m: PartyMember) => party.some((p) => p.guardianMemberId === m.id);

  // Block the wizard's "Continue" whenever a sign-in lookup, add-player form, or
  // onboarding is in progress — otherwise tapping Continue (or OSK "Done" then
  // Continue) advances PAST the OTP step without verifying (owner: entering the
  // phone jumped to the next page). Finish or cancel the lookup to continue.
  useEffect(() => {
    setBusy?.(
      lookupOpen ||
        form !== null ||
        busy ||
        checkingIds.size > 0 ||
        // License scan mid-flight / match picker open — same "mid-task" rule.
        licenseBusy ||
        licenseMatches !== null,
    );
    return () => setBusy?.(false);
  }, [lookupOpen, form, busy, setBusy, checkingIds, licenseBusy, licenseMatches]);

  const setIncluded = (ids: Set<string>) => {
    if (isRace) return;
    onIncludedChange(ids);
  };
  const toggle = (id: string) => {
    if (isRace) return;
    const next = new Set(included);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setIncluded(next);
  };

  // The main person IS the booking contact — push their name + mobile + email
  // into session.contact so there's no separate YOUR INFO step (owner rule).
  const setContactFrom = (m: PartyMember) => {
    onSetContact?.(m);
  };

  const markMain = (id: string) => {
    party.forEach((m) => {
      const shouldBe = m.id === id;
      if (!!m.isBillingCustomer !== shouldBe) {
        onUpdateMember(m.id, { isBillingCustomer: shouldBe });
      }
    });
    const m = party.find((x) => x.id === id);
    if (m) setContactFrom(m);
  };

  const removeMember = (id: string) => {
    // Never remove a selected guardian — the minor they cover would be orphaned
    // (owner 2026-07-18). The UI hides Remove for guardians; this is the guard.
    if (party.some((p) => p.guardianMemberId === id)) return;
    // Also drop this person as anyone's guardian, and from the attraction set.
    party.forEach((m) => {
      if (m.guardianMemberId === id) {
        onUpdateMember(m.id, { guardianMemberId: undefined });
      }
    });
    onRemoveMember(id);
    if (!isRace) {
      const next = new Set(included);
      next.delete(id);
      setIncluded(next);
    }
  };

  const resetForm = () => {
    setForm(null);
    setFirstName("");
    setLastName("");
    setDob("");
    setPhone("");
    setEmail("");
    setGuardianId("");
    setFormError(null);
  };

  // First person added becomes main — only where a main-contact concept exists
  // (the wizard passes onSetContact; the waiver flow doesn't).
  const isMainDefault = !!onSetContact && party.length === 0;

  /** Best-effort BMI-level guardian link: re-run the upsert create for the minor
   *  with guardianID attached (known person → same id, never a duplicate). The
   *  waiver's sigPersonID records the guardian regardless, so a failure is
   *  non-fatal. Skipped when the minor has no phone/email dedup identity. */
  // REMOVED 2026-07-30 — there used to be a best-effort `linkMinorToGuardian`
  // here that re-ran pandoraCreatePerson for the MINOR with guardianID attached,
  // on the belief that the create is an upsert for a known person. It is NOT.
  //
  // Pandora created a fresh DUPLICATE person on every minor sign (the field set
  // differed from the original create), splitting the kid's identity so later
  // waiver checks read a record the signature never landed on — the 2026-07-25
  // Strachan incident. KioskPeopleStep deleted this same call then and left the
  // warning; this extracted copy kept it, so it was still firing for every minor
  // signed by a guardian on /waiver AND in the kiosk race-pack flow.
  //
  // The waiver's sigPersonID already records who signed. Never re-create a person
  // that already has an id.

  /** guardianSigning: resolve the minor's (pre-selected) guardian, ensure the
   *  guardian's OWN waiver is current (sign it first if lapsed), then open the
   *  minor's waiver with the guardian as sigPersonID. Any resolution failure
   *  falls back to the minor's own sign so the flow never dead-ends (the
   *  BMI-level guardianID link was already set at onboard). */
  const beginMinorWaiver = async (
    minor: PartyMember,
    minorPersonId: string,
    minorTemplate: PandoraWaiverTemplate,
  ) => {
    const selfSign = () =>
      setWaiverFor({ memberId: minor.id, personId: minorPersonId, template: minorTemplate });
    try {
      const guardian = minor.guardianMemberId
        ? party.find((m) => m.id === minor.guardianMemberId)
        : undefined;
      if (!guardian) {
        selfSign();
        return;
      }
      let sid = shortPandoraId(guardian);
      if (!sid) {
        const gPhone = guardian.phone?.trim() ?? "";
        const gEmail = guardian.email?.trim() ?? "";
        if (!gPhone && !gEmail) {
          selfSign();
          return;
        }
        const { personId } = await pandoraCreatePerson({
          firstName: guardian.firstName,
          lastName: guardian.lastName ?? "",
          email: gEmail,
          phone: gPhone,
          birthdate: guardian.dobIso,
          location: brandLocation,
        });
        onUpdateMember(guardian.id, { pandoraPersonId: personId });
        sid = personId;
      }
      const status = await pandoraCheckWaiver(sid, brandLocation);
      if (status.valid !== !!guardian.waiverValid) {
        onUpdateMember(guardian.id, { waiverValid: status.valid });
      }
      if (status.valid) {
        setWaiverFor({
          memberId: minor.id,
          personId: minorPersonId,
          template: minorTemplate,
          signerPersonId: sid,
          signerName: guardian.firstName,
        });
        return;
      }
      // Guardian's own waiver lapsed → they sign it first; the overlay's
      // sign-complete handler chains straight to the minor's waiver. A guardian
      // is always an adult, so the adult template (age 35 — the bracket the
      // monolith also defaults to) is correct.
      const ownTemplate = await pandoraFetchWaiverTemplate(35, brandLocation);
      setGuardianChain({
        minorMemberId: minor.id,
        minorPersonId,
        minorTemplate,
        guardianId: guardian.id,
        guardianSid: sid,
        guardianName: guardian.firstName,
      });
      setWaiverFor({ memberId: guardian.id, personId: sid, template: ownTemplate });
    } catch {
      // Rare (network) — never dead-end; the front desk can re-sign if needed.
      selfSign();
    }
  };

  const resetGuardianForm = () => {
    setGFirst("");
    setGLast("");
    setGDob("");
    setGPhone("");
    setGEmail("");
    setGError(null);
  };

  /** Guardian resolved → open the minor's waiver with them as sigPersonID, or send
   *  them to sign their OWN lapsed waiver first (the overlay chains onward). */
  const proceedWithGuardian = (
    g: PartyMember,
    sid: string,
    ownValid: boolean,
    ownTemplate: PandoraWaiverTemplate | null,
    gf: NonNullable<typeof guardianFlow>,
  ) => {
    setGuardianFlow({ ...gf, guardianId: g.id });
    if (ownValid) {
      setWaiverFor({
        memberId: gf.minorMemberId,
        personId: gf.minorPersonId,
        template: gf.minorTemplate,
        signerPersonId: sid,
        signerName: g.firstName,
      });
    } else if (ownTemplate) {
      setGuardianChain({
        minorMemberId: gf.minorMemberId,
        minorPersonId: gf.minorPersonId,
        minorTemplate: gf.minorTemplate,
        guardianId: g.id,
        guardianSid: sid,
        guardianName: g.firstName,
      });
      setWaiverFor({ memberId: g.id, personId: sid, template: ownTemplate });
    }
  };

  /** Patch a person wherever they live — party roster or signer-only guardians. */
  const patchPerson = (id: string, patch: Partial<PartyMember>) => {
    if (party.some((p) => p.id === id)) onUpdateMember(id, patch);
    else onUpdateGuardian?.(id, patch);
  };

  /** Tap an adult already here: resolve their SHORT Pandora id and re-check their
   *  waiver authoritatively before they sign for the minor. */
  const chooseGuardian = async (g: PartyMember) => {
    const gf = guardianFlow;
    if (!gf) return;
    setBusyAll(true);
    setChoosingGuardianId(g.id);
    setGError(null);
    try {
      let sid = shortPandoraId(g);
      if (!sid) {
        const gPhoneTrim = g.phone?.trim() ?? "";
        const gEmailTrim = g.email?.trim() ?? "";
        // The upsert needs a dedup identity AND a birthdate. An adult signed in via
        // account lookup carries a 17-digit Office id and often NO birthdate, and
        // Pandora answers that with a bare 400 "Validation Exception" — which is
        // exactly what a guest saw on 2026-07-30 when tapping an existing adult.
        if ((gPhoneTrim || gEmailTrim) && g.dobIso) {
          try {
            const { personId } = await pandoraCreatePerson({
              firstName: formatPersonName(g.firstName),
              lastName: formatPersonName(g.lastName ?? ""),
              email: gEmailTrim,
              phone: gPhoneTrim,
              birthdate: g.dobIso,
              location: brandLocation,
            });
            patchPerson(g.id, { pandoraPersonId: personId });
            sid = personId;
          } catch {
            // fall through to the Office id rather than dead-ending
          }
        }
        // Last resort: sign with the Office id. pandoraCheckWaiver accepts 17-digit
        // ids, and this is the same fallback the account-lookup path already takes.
        if (!sid && g.bmiPersonId) sid = g.bmiPersonId;
        if (!sid) {
          throw new Error(
            GUEST_SAFE_ERROR +
              t("party.gErr.cantVerifyName", { name: formatPersonName(g.firstName) }),
          );
        }
      }
      const status = await pandoraCheckWaiver(sid, brandLocation);
      // MEMBERSHIP REFRESH (2026-07-23): the check just returned the BMI record's
      // birthdate — use it when the roster entry has no DOB, instead of assuming
      // adult. A 17-year-old once signed an ADULT waiver as a "guardian" because
      // unknown ages defaulted to 35 here.
      const gDobIso = g.dobIso ?? (status.birthdate ? String(status.birthdate).slice(0, 10) : null);
      const gAge = ageFromIso(gDobIso);
      if (gAge !== null && gAge < 18) {
        throw new Error(
          GUEST_SAFE_ERROR + t("party.gErr.underAge", { name: formatPersonName(g.firstName) }),
        );
      }
      if (!g.dobIso && gDobIso) patchPerson(g.id, { dobIso: gDobIso });
      let ownTemplate: PandoraWaiverTemplate | null = null;
      if (!status.valid) {
        ownTemplate = await pandoraFetchWaiverTemplate(gAge ?? 35, brandLocation);
      }
      if (status.valid !== !!g.waiverValid) patchPerson(g.id, { waiverValid: status.valid });
      proceedWithGuardian(g, sid, status.valid, ownTemplate, gf);
    } catch (err) {
      // Only OUR messages are guest-facing. Upstream text ("Validation Exception")
      // means nothing to a parent and looks like the site broke, so it is logged
      // and replaced with something actionable.
      const ours = err instanceof Error && err.message.startsWith(GUEST_SAFE_ERROR);
      if (!ours) console.error("[waiver-guardian] choose failed:", err);
      setGError(
        ours ? err.message.slice(GUEST_SAFE_ERROR.length) : t("party.gErr.verifyAdultFallback"),
      );
    } finally {
      setBusyAll(false);
      setChoosingGuardianId(null);
    }
  };

  /** "Add a new adult" — create + waiver-check the guardian, then chain. They are
   *  SIGNER-ONLY (guardians list), never part of the purchase. */
  const submitGuardianNew = async () => {
    const gf = guardianFlow;
    if (!gf) return;
    const gAge = ageFromDob(gDob);
    if (!gFirst.trim() || !gLast.trim()) {
      setGError(t("party.gErr.enterName"));
      return;
    }
    if (gAge === null) {
      setGError(t("party.gErr.enterDob"));
      return;
    }
    if (gAge < 18) {
      setGError(t("party.gErr.mustBe18"));
      return;
    }
    if (gPhone.replace(/\D/g, "").length < 10) {
      setGError(t("party.gErr.enterPhone"));
      return;
    }
    setBusyAll(true);
    setGError(null);
    try {
      const gCleanFirst = formatPersonName(gFirst);
      const gCleanLast = formatPersonName(gLast);
      const result = await pandoraOnboardGuest(
        {
          firstName: gCleanFirst,
          lastName: gCleanLast,
          email: gEmail.trim() || "",
          phone: gPhone.trim(),
          birthdate: toIsoDob(gDob),
        },
        brandLocation,
      );
      // The upsert may resolve to an EXISTING BMI record — re-gate on ITS
      // birthdate, so a typed adult DOB can't smuggle a known minor in as the
      // guardian.
      const rAge = ageFromIso(result.birthdate) ?? gAge;
      if (rAge < 18) {
        setGError(t("party.gErr.mustBe18"));
        return;
      }
      const g = newPartyMember({
        firstName: gCleanFirst,
        lastName: gCleanLast,
        isNewRacer: true,
        category: "adult",
        bmiPersonId: result.personId,
        waiverValid: result.waiverValid,
        phone: gPhone.trim(),
        email: gEmail.trim() || undefined,
        dobIso: result.birthdate,
      });
      onAddGuardian?.(g);
      resetGuardianForm();
      proceedWithGuardian(g, result.personId, result.waiverValid, result.template, gf);
    } catch (err) {
      setGError(
        err instanceof Error
          ? t("party.err.setupFailMsg", { msg: err.message })
          : t("party.err.setupFail"),
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** "Find their account" — an OTP-verified existing adult becomes the signer.
   *  Resolve their SHORT id via the upsert and take authoritative waiver status;
   *  own waiver first if lapsed. */
  const handleGuardianVerified = async (person: PersonData) => {
    const gf = guardianFlow;
    if (!gf) return;
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const bdIso = person.birthDate ? String(person.birthDate).slice(0, 10) : undefined;
    const bdYears = ageFromIso(bdIso);
    if (bdYears !== null && bdYears < 18) {
      setGError(t("party.gErr.accountIsMinor"));
      setGuardianFlow({ ...gf, stage: "choose" });
      return;
    }
    // Already here (party adult or a prior guardian)? Reuse that entry rather than
    // adding a duplicate person.
    const existing = [...party, ...guardians].find(
      (m) =>
        !m.isMinor && (m.bmiPersonId === person.personId || m.pandoraPersonId === person.personId),
    );
    if (existing) {
      void chooseGuardian(existing);
      return;
    }
    if (party.some((m) => m.isMinor && m.bmiPersonId === person.personId)) {
      setGError(t("party.gErr.accountIsMinor"));
      setGuardianFlow({ ...gf, stage: "choose" });
      return;
    }
    setBusyAll(true);
    setGError(null);
    try {
      const dedupPhone = person.phone?.trim() ?? "";
      const dedupEmail = person.email?.trim() ?? "";
      let sid: string | null = null;
      let ownValid = person.waiverValid === true;
      let ownTemplate: PandoraWaiverTemplate | null = null;
      // MEMBERSHIP REFRESH (2026-07-23): an Office record can come back with NO
      // birthdate, so the age gate above can't fire and this path used to default
      // the template age to 35 — that is how a 17-year-old signed an ADULT waiver.
      let refreshedIso: string | null = bdIso ?? null;
      if (dedupPhone || dedupEmail) {
        const { personId } = await pandoraCreatePerson({
          firstName: formatPersonName(first || person.fullName),
          lastName: formatPersonName(rest.join(" ")) || "",
          email: dedupEmail,
          phone: dedupPhone,
          birthdate: bdIso,
          location: brandLocation,
        });
        sid = personId;
        const status = await pandoraCheckWaiver(personId, brandLocation);
        ownValid = status.valid;
        if (!refreshedIso && status.birthdate) refreshedIso = String(status.birthdate).slice(0, 10);
      } else if (!refreshedIso) {
        const probe = await pandoraCheckWaiver(person.personId, brandLocation).catch(() => null);
        if (probe?.birthdate) refreshedIso = String(probe.birthdate).slice(0, 10);
      }
      const refreshedAge = ageFromIso(refreshedIso);
      if (refreshedAge !== null && refreshedAge < 18) {
        setGError(t("party.gErr.accountIsMinor"));
        setGuardianFlow({ ...gf, stage: "choose" });
        return;
      }
      if (!ownValid) {
        ownTemplate = await pandoraFetchWaiverTemplate(refreshedAge ?? 35, brandLocation);
      }
      const g: PartyMember = {
        ...newPartyMember({
          // CRM records can be stored ALL CAPS — normalize what we keep.
          firstName: formatPersonName(first || person.fullName),
          lastName: formatPersonName(rest.join(" ")) || undefined,
          isNewRacer: false,
          category: "adult",
          memberships: person.memberships,
          bmiPersonId: person.personId,
          waiverValid: ownValid,
          phone: person.phone || undefined,
          email: person.email || undefined,
          dobIso: refreshedIso ?? undefined,
        }),
        ...(sid ? { pandoraPersonId: sid } : {}),
      };
      onAddGuardian?.(g);
      // No phone/email to dedup against → last resort: sign with the Office id.
      proceedWithGuardian(g, sid ?? person.personId, ownValid, ownTemplate, gf);
    } catch (err) {
      setGError(
        err instanceof Error
          ? t("party.err.setupFailMsg", { msg: err.message })
          : t("party.gErr.verifyAdultFallback"),
      );
      setGuardianFlow({ ...gf, stage: "choose" });
    } finally {
      setBusyAll(false);
    }
  };

  /** Open the waiver overlay for a member — the guardian-signs-for-minor chain
   *  when guardianSigning is on, otherwise self-sign (unchanged default). */
  const openWaiverFor = async (
    member: PartyMember,
    personId: string,
    template: PandoraWaiverTemplate,
  ) => {
    if (signTimeGuardian && member.isMinor) {
      // Minor registered without an adult; find the signer NOW.
      setGError(null);
      setGuardianFlow({
        minorMemberId: member.id,
        minorPersonId: personId,
        minorTemplate: template,
        stage: "choose",
      });
      return;
    }
    if (guardianSigning && member.isMinor) {
      await beginMinorWaiver(member, personId, template);
    } else {
      setWaiverFor({ memberId: member.id, personId, template });
    }
  };

  /** Add a brand-NEW person (name + DOB + mobile [+ guardian if minor]) → onboard → waiver. */
  const submitNew = async () => {
    const age = ageFromDob(dob);
    const isMain = !!onSetContact && party.length === 0;
    if (!firstName.trim() || !lastName.trim()) {
      setFormError(t("party.err.name"));
      return;
    }
    if (age === null) {
      setFormError(t("party.err.dob"));
      return;
    }
    // HARD racing age floor (venue rule: juniors are ages 7–13). The safety
    // modal only ATTESTS this — but the kiosk collects a real DOB, so enforce
    // it at capture instead of letting a family book a 5-year-old and get
    // turned away at the track (owner 2026-07-18 age-check ask).
    if (isRace && age < 7) {
      setFormError(t("party.err.tooYoung", { name: firstName.trim() || t("party.thisRacer") }));
      return;
    }
    // Every new player gives a mobile number (owner rule); the main person also
    // gives an email so their contact is complete and no YOUR INFO step is needed.
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setFormError(t("party.err.phone"));
      return;
    }
    if (isMain && !email.includes("@")) {
      setFormError(t("party.err.emailMain"));
      return;
    }
    const minor = age < 18;
    // sign-time resolution: a minor registers FIRST, no adult required up front
    // (owner 2026-07-18). The guardian is found when the waiver needs signing.
    if (!signTimeGuardian) {
      if (minor && adults.length === 0) {
        setFormError(t("party.err.needAdult"));
        return;
      }
      if (minor && !guardianId) {
        setFormError(t("party.err.pickGuardian"));
        return;
      }
    }
    setBusyAll(true);
    setFormError(null);
    try {
      const guardianPersonId = minor
        ? party.find((m) => m.id === guardianId)?.bmiPersonId
        : undefined;
      const result = await pandoraOnboardGuest(
        {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim() || contactEmail || "",
          phone: phone.trim(),
          birthdate: toIsoDob(dob),
          guardianID: guardianPersonId,
        },
        brandLocation,
      );
      const member = newPartyMember({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        isNewRacer: true, // new person → Starter-only for racing
        category: age < 13 ? "junior" : "adult",
        isMinor: minor,
        guardianMemberId: minor ? guardianId : undefined,
        bmiPersonId: result.personId,
        waiverValid: result.waiverValid,
        isBillingCustomer: isMain, // first person is main by default
        phone: phone.trim(),
        email: email.trim() || undefined,
      });
      onAddMember(member);
      if (isMain) setContactFrom(member); // main person → booking contact
      if (!isRace) setIncluded(new Set([...included, member.id]));
      resetForm();
      if (!result.waiverValid && result.template) {
        await openWaiverFor(member, result.personId, result.template);
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? t("party.err.setupFailMsg", { msg: err.message })
          : t("party.err.setupFail"),
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** Finish setup for an EXISTING roster member (needs account and/or waiver). */
  const submitSetup = async (member: PartyMember) => {
    const age = ageFromDob(dob);
    if (age === null) {
      setFormError(t("party.err.dob"));
      return;
    }
    // Same hard racing floor as submitNew — a "Set up" on an existing roster
    // member is still the moment we learn their real DOB.
    if (isRace && age < 7) {
      setFormError(t("party.err.tooYoung", { name: member.firstName }));
      return;
    }
    const minor = age < 18;
    const gid = member.guardianMemberId || guardianId;
    // sign-time resolution: same rule as submitNew — the guardian is found when the
    // waiver needs signing. Demanding a pick here dead-ended every minor, because
    // the picker itself is hidden under sign-time (live /waiver, 2026-07-30).
    if (!signTimeGuardian) {
      if (minor && adults.filter((a) => a.id !== member.id).length === 0) {
        setFormError(t("party.err.needAdult"));
        return;
      }
      if (minor && !gid) {
        setFormError(t("party.err.pickGuardian"));
        return;
      }
    }
    setBusyAll(true);
    setFormError(null);
    try {
      if (!member.bmiPersonId) {
        const guardianPersonId = minor ? party.find((m) => m.id === gid)?.bmiPersonId : undefined;
        const result = await pandoraOnboardGuest(
          {
            firstName: member.firstName,
            lastName: member.lastName ?? "",
            email: contactEmail ?? "",
            phone: contactPhone ?? "",
            birthdate: toIsoDob(dob),
            guardianID: guardianPersonId,
          },
          brandLocation,
        );
        onUpdateMember(member.id, {
          bmiPersonId: result.personId,
          waiverValid: result.waiverValid,
          isMinor: minor,
          category: age < 13 ? "junior" : "adult",
          guardianMemberId: minor ? gid : undefined,
        });
        resetForm();
        if (!result.waiverValid && result.template) {
          await openWaiverFor(
            {
              ...member,
              isMinor: minor,
              guardianMemberId: minor ? gid : undefined,
              bmiPersonId: result.personId,
            },
            result.personId,
            result.template,
          );
        }
      } else {
        // An id is already on the member — NEVER create again. Pandora's
        // create is NOT an upsert: a re-tap used to re-run the "upsert" and
        // mint a fresh duplicate person every time, so the new waiver landed
        // on a record later checks never read (2026-07-25 Strachan incident).
        // Check the waiver on the id we have and sign against it.
        //
        // This branch now takes 17-DIGIT OFFICE IDS TOO. It used to be gated
        // `length <= 12` on the belief that Pandora's waiver sign rejects the
        // Office form (2026-07-18 kiosk 500s) — production's own sign ledger
        // says otherwise (waiver_sign_attempts, 2026-07-31: 41 waivers signed
        // HTTP 201 with a 17-digit personID, 16 with a 17-digit sigPersonID,
        // zero failures at that length; the old 500s were the since-fixed
        // blank-invalidationDate bug). The check half was never in doubt —
        // pandoraCheckWaiver is the same GET the roster sweep runs on Office
        // ids constantly. The two paths this replaces were both worse: the
        // with-contact create resolved a short id by MINTING A PERSON (the
        // duplicate factory — Strachan; the double "William H." roster row,
        // 2026-07-31), and the no-contact fallback signed blind off the typed
        // DOB with no validity check at all.
        const sid = member.pandoraPersonId ?? member.bmiPersonId;
        const status = await pandoraCheckWaiver(sid, brandLocation);
        // MEMBERSHIP REFRESH: BMI's birthdate beats the typed DOB for minor
        // routing + the template age (2026-07-23 adult-waiver-on-a-17yo class
        // — mirrors the KioskPeopleStep twin branch).
        const refreshedIso = status.birthdate
          ? String(status.birthdate).slice(0, 10)
          : toIsoDob(dob);
        const rAge = ageFromIso(refreshedIso) ?? age;
        const rMinor = rAge < 18;
        const rGid = member.guardianMemberId || guardianId;
        if (!signTimeGuardian && rMinor && !rGid) {
          // The typed DOB said adult so the top-of-function guardian gate
          // never fired — re-gate on the refreshed age (form stays open).
          setFormError(t("party.err.pickGuardian"));
          return;
        }
        // Template BEFORE resetForm — a fetch failure must surface in the
        // still-open form (formError renders inside it), not vanish with it.
        const template = status.valid
          ? null
          : await pandoraFetchWaiverTemplate(rAge, brandLocation);
        onUpdateMember(member.id, {
          waiverValid: status.valid,
          isMinor: rMinor,
          category: rAge < 13 ? "junior" : "adult",
          dobIso: refreshedIso,
          guardianMemberId: rMinor ? rGid : undefined,
        });
        resetForm();
        if (template) {
          if (signTimeGuardian && rMinor) {
            // Sign-time: the signer is found at the WAIVER, not on this form.
            // Route through openWaiverFor's guardianFlow interception — the
            // direct setWaiverFor below would let the minor self-sign.
            await openWaiverFor(
              { ...member, isMinor: rMinor, guardianMemberId: rGid || undefined },
              sid,
              template,
            );
            return;
          }
          // A minor never self-signs. This branch has no create to attach
          // guardianID to (that was the duplicate-minting path), so the
          // guardian rides the WAIVER instead as Pandora sigPersonID — same
          // record KioskPeopleStep's guardian flow writes. Office-id guardians
          // are fine here too (chooseGuardian's own "last resort" already
          // signs with them; 16 prod 201s carry a 17-digit sigPersonID).
          const guardian = rMinor ? party.find((m) => m.id === rGid) : undefined;
          const guardianSid = guardian?.pandoraPersonId ?? guardian?.bmiPersonId ?? undefined;
          setWaiverFor({
            memberId: member.id,
            personId: sid,
            template,
            ...(guardianSid ? { signerPersonId: guardianSid } : {}),
          });
        }
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? t("party.err.finishFailMsg", { msg: err.message })
          : t("party.err.finishFail"),
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** Fetch the verified account's waiver status + LINKED family in ONE call.
   *  - The main person's waiver status (`data.valid`) patches their roster card
   *    so a returning racer with a current waiver is NOT asked to sign again
   *    (owner bug 2026-07-19 — the Office lookup can't see waiverExpiry, so this
   *    Pandora check is the only source of truth; web does the exact same patch).
   *  - `data.related` becomes OPT-IN family suggestions — NOT auto-added to the
   *    party (racing races the whole party, so auto-adding pulled everyone in).
   *  allRelated=true here (the ONE call that needs the family array); the
   *  per-relative detail fetches below stay fast (route default allRelated=false). */
  const importLinked = async (personId: string, memberId: string, alreadyIds: Set<string>) => {
    // Flip the main member's card to "Checking waiver…" as soon as we're known to
    // be verifying (cleared the instant the waiver status is applied below).
    const doneChecking = () =>
      setCheckingIds((s) => {
        const n = new Set(s);
        n.delete(memberId);
        return n;
      });
    try {
      const res = await fetch(
        `/api/pandora?personId=${personId}&picture=false&allRelated=true&location=${brandLocation}`,
      );
      if (!res.ok) {
        doneChecking();
        return;
      }
      const data = await res.json();
      // Patch the main person's waiver validity from the authoritative check.
      if (typeof data.valid === "boolean") {
        onUpdateMember(memberId, { waiverValid: data.valid });
      }
      // Backfill DOB → age bucket if the Office lookup didn't carry a birthday.
      if (data.birthdate) {
        const iso = String(data.birthdate).slice(0, 10);
        const yrs = Math.floor(
          (Date.now() - new Date(data.birthdate).getTime()) / (365.25 * 864e5),
        );
        onUpdateMember(memberId, {
          dobIso: iso,
          isMinor: yrs < 18,
          category: yrs < 13 ? "junior" : "adult",
        });
      }
      // Main waiver status now known — flip the card (ready / waiver needed)
      // BEFORE the slower per-relative fetches below.
      doneChecking();
      const relatedIds: string[] = (data.related || [])
        .map((r: unknown) => (typeof r === "string" ? r : ((r as { id?: string })?.id ?? "")))
        .filter(Boolean);
      const collected: LinkedSuggestion[] = [];
      await Promise.all(
        relatedIds.map(async (rid) => {
          if (alreadyIds.has(rid)) return;
          try {
            const r = await fetch(`/api/pandora?personId=${rid}&picture=false`);
            if (!r.ok) return;
            const p = await r.json();
            const first = p.firstName || "";
            const last = p.lastName || "";
            if (!first && !last) return;
            const isoAge = p.birthdate
              ? Math.floor((Date.now() - new Date(p.birthdate).getTime()) / (365.25 * 864e5))
              : null;
            collected.push({
              id: rid,
              firstName: first,
              lastName: last,
              age: isoAge,
              waiverValid: p.valid === true,
            });
          } catch {
            /* skip this relative — non-fatal */
          }
        }),
      );
      if (collected.length) {
        setLinked((prev) => {
          const have = new Set(
            [...prev.map((l) => l.id), ...party.map((m) => m.bmiPersonId)].filter(
              Boolean,
            ) as string[],
          );
          return [...prev, ...collected.filter((l) => !have.has(l.id))];
        });
      }
    } catch {
      /* non-fatal */
    } finally {
      doneChecking(); // belt-and-braces — never leave a card stuck "checking"
    }
  };

  /** Add a linked-family suggestion to the party (opt-in tap). */
  const addLinked = (lp: LinkedSuggestion) => {
    // Belt-and-braces for the disabled card: racing hard floor is 7+.
    if (isRace && lp.age !== null && lp.age < 7) return;
    const member = newPartyMember({
      firstName: lp.firstName,
      lastName: lp.lastName || undefined,
      isNewRacer: false,
      category: lp.age !== null && lp.age < 13 ? "junior" : "adult",
      isMinor: lp.age !== null && lp.age < 18,
      bmiPersonId: lp.id,
      waiverValid: lp.waiverValid,
    });
    onAddMember(member);
    if (!isRace) setIncluded(new Set([...included, member.id]));
    setLinked((prev) => prev.filter((l) => l.id !== lp.id));
  };

  // `claimMain` defaults to the first-added-becomes-main rule; a batch add
  // passes it explicitly so only ONE member claims main (reading party.length
  // inside a loop is stale — every iteration would think it's first). `batchIds`
  // are the other accounts added in the same batch, so linked-family
  // suggestions don't re-offer a sibling already selected.
  const handleVerified = (
    person: PersonData,
    claimMain: boolean = !!onSetContact && party.length === 0,
    batchIds?: Set<string>,
  ) => {
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const isMain = claimMain;
    // Capture the returning racer's saved birthday so we never re-ask it (owner
    // bug 2026-07-19). Office lookup returns birthDate; drive the age bucket from
    // it. importLinked backfills from Pandora if the Office record lacked one.
    const bdIso = person.birthDate ? String(person.birthDate).slice(0, 10) : undefined;
    const bdYears = bdIso
      ? Math.floor((Date.now() - new Date(bdIso).getTime()) / (365.25 * 864e5))
      : null;
    const member = newPartyMember({
      firstName: first || person.fullName,
      lastName: rest.join(" ") || undefined,
      isNewRacer: false,
      category: bdYears !== null && bdYears < 13 ? "junior" : "adult",
      isMinor: bdYears !== null ? bdYears < 18 : undefined,
      dobIso: bdIso,
      bmiPersonId: person.personId,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
      creditBalances: person.creditBalances,
      isBillingCustomer: isMain,
      phone: person.phone || undefined,
      phoneVerified: person.phoneVerified || undefined,
      email: person.email || undefined,
    });
    onAddMember(member);
    if (!isRace) setIncluded(new Set([...included, member.id]));
    if (isMain) setContactFrom(member); // main person → booking contact
    setLookupOpen(false);
    const alreadyIds = new Set(
      [person.personId, ...party.map((m) => m.bmiPersonId), ...(batchIds ?? [])].filter(
        Boolean,
      ) as string[],
    );
    // Mark "checking waiver…" until the authoritative Pandora status lands, so the
    // card doesn't flash "Waiver needed" first (owner 2026-07-19). Skip if the
    // Office lookup already returned a valid waiver.
    if (!person.waiverValid) {
      setCheckingIds((s) => {
        const n = new Set(s);
        n.add(member.id);
        return n;
      });
    }
    // Authoritative waiver check + linked family (mirrors web RacePartyStep).
    void importLinked(person.personId, member.id, alreadyIds);
  };

  // Add several returning racers from ONE OTP (household sharing a phone/email).
  // Only the first claims main (when eligible); each still gets its own
  // authoritative Pandora waiver check via handleVerified → importLinked.
  const handleVerifiedMultiple = (people: PersonData[]) => {
    if (people.length === 0) return;
    const canClaimMain = !!onSetContact && party.length === 0;
    const batchIds = new Set(people.map((p) => p.personId));
    people.forEach((person, i) => handleVerified(person, canClaimMain && i === 0, batchIds));
  };

  const openSetup = (member: PartyMember) => {
    setForm({ mode: "setup", member });
    // Prefill the birthday we already have on file (returning racer) so the guest
    // isn't asked for a saved DOB again (owner 2026-07-19). dobIso "YYYY-MM-DD" →
    // the MM/DD/YYYY the form uses.
    const iso = member.dobIso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    setDob(iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : "");
    setGuardianId(member.guardianMemberId ?? "");
    setFormError(null);
  };

  /* ── driver's-license scan (hardware QR scanner) ─────────────────────────
     Same routing as KioskPeopleStep: roster view → account lookup by last
     name + DOB (physical ID = identity proof, owner 2026-07-23) → sign in /
     prefilled new-player form; an OPEN form just gets filled. State lives up
     with the other hooks (the setBusy effect reads it). */
  const isoToMmDdYyyy = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
  };

  const fillNewForm = (lic: AamvaLicense) => {
    setFirstName(formatPersonName(lic.firstName));
    setLastName(formatPersonName(lic.lastName));
    setDob(isoToMmDdYyyy(lic.dobIso));
    setFormError(null);
  };

  const openNewFormFromLicense = (lic: AamvaLicense) => {
    resetForm();
    setForm({ mode: "new" });
    fillNewForm(lic);
  };

  /** Sign a matched account in through the SAME rail as the OTP lookup. */
  const signInLicenseMatch = (m: LicenseMatch) => {
    const already = party.find(
      (x) => x.bmiPersonId === m.personId || x.pandoraPersonId === m.personId,
    );
    if (already) {
      setScanNote(t("party.err.alreadySignedIn", { name: already.firstName }));
      return;
    }
    handleVerified(personDataFromMatch(m));
    setScanNote(null);
  };

  const runLicenseLookup = async (lic: AamvaLicense) => {
    setLicenseBusy(true);
    setScanNote(null);
    setLookupOpen(false); // a scan at the OTP screen IS the sign-in
    try {
      // CENTER FIRST (same rule as the photo upload below): Naples routes to
      // the Naples Pandora location regardless of brand.
      const matches = await fetchLicenseMatches(
        lic,
        center === "naples" ? "naples" : brandLocation,
      );
      if (matches === null) {
        setScanNote(t("party.license.checkFail"));
        openNewFormFromLicense(lic);
      } else if (matches.length === 0) {
        setScanNote(null);
        openNewFormFromLicense(lic);
      } else if (matches.length === 1) {
        signInLicenseMatch(matches[0]);
      } else {
        setLicenseMatches({ license: lic, matches });
      }
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleLicense = (lic: AamvaLicense) => {
    if (waiverFor || busy || licenseBusy || licenseMatches) return;
    if (form?.mode === "new") {
      fillNewForm(lic);
      return;
    }
    if (form?.mode === "setup") {
      // Only take the DOB when the license plausibly belongs to THIS member —
      // a parent scanning their own ID must not stamp their DOB on the kid.
      if (form.member.firstName.trim().toLowerCase() === lic.firstName.trim().toLowerCase()) {
        setDob(isoToMmDdYyyy(lic.dobIso));
        setFormError(null);
      } else {
        setFormError(t("party.err.licenseMismatch", { name: form.member.firstName }));
      }
      return;
    }
    void runLicenseLookup(lic);
  };

  /** SMS-Timing member QR — straight to lookup (the code IS the identity;
   *  no scanned name to prefill on a miss). */
  const runMemberLookup = async (qr: MemberQr) => {
    setLicenseBusy(true);
    setScanNote(null);
    setLookupOpen(false);
    try {
      const matches = await fetchMemberMatches(qr);
      if (matches === null) {
        setScanNote(t("party.member.checkCodeFail"));
      } else if (matches.length === 0) {
        setScanNote(t("party.member.codeNotFound"));
      } else if (matches.length === 1) {
        signInLicenseMatch(matches[0]);
      } else {
        setLicenseMatches({ license: null, matches });
      }
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleMemberQr = (qr: MemberQr) => {
    if (waiverFor || busy || licenseBusy || licenseMatches || form) return;
    void runMemberLookup(qr);
  };

  const licenseScan = useLicenseScan({
    config: kioskCfg,
    enabled: true, // the hook itself no-ops unless this kiosk has the scanner
    onLicense: handleLicense,
    onMemberQr: handleMemberQr,
  });

  // Absorb Pandora's Azure cold start BEFORE anyone scans (one shot per
  // mount) — otherwise the first scan after idle pays the spin-up.
  const prewarmedRef = useRef(false);
  useEffect(() => {
    if (!prewarmedRef.current && kioskCfg?.qrScannerEnabled) {
      prewarmedRef.current = true;
      prewarmLicenseLookup(center === "naples" ? "naples" : brandLocation);
    }
  }, [kioskCfg, center, brandLocation]);

  // Mobile join (flag-gated, default on): the same phone-QR sign-in the race /
  // attraction people step uses, reused here so the standalone flows (race
  // packs) get "sign in from your phone" too. The join session is fully
  // decoupled from the booking session — itemId is an opaque client key that
  // never reaches the server. Joined guests merge into the LOCAL roster through
  // the same onAddMember / onUpdateMember callbacks the rest of this component
  // uses; there's no separate guardians list here, so pass []. stepKind only
  // labels the phone page (no "race-pack" value exists — race maps to "race").
  const mobileJoin = useMobileJoin({
    enabled: kioskMobileJoinEnabled() && !!kioskCfg && mode !== "waiver",
    itemId: `party-manager:${mode}`,
    kioskId: kioskCfg ? kioskId(kioskCfg) : null,
    center: kioskCfg?.center ?? null,
    brand: kioskCfg?.brand ?? null,
    stepKind: isRace ? "race" : "attraction",
    onGuests: (guests) => {
      const { toAdd, alreadyPresent } = mergeJoinedGuests(party, [], guests);
      for (const member of toAdd) onAddMember(member);
      // Someone already on the roster re-verified by phone — silent success:
      // waiver now signed + the short Pandora id (NEVER touch bmiPersonId) + the
      // OTP-proven phone.
      for (const hit of alreadyPresent) {
        onUpdateMember(hit.memberId, {
          waiverValid: true,
          ...(hit.pandoraPersonId ? { pandoraPersonId: hit.pandoraPersonId } : {}),
          ...(hit.phone && hit.phoneVerified ? { phone: hit.phone, phoneVerified: true } : {}),
        });
      }
    },
  });

  const badgeFor = (m: PartyMember) => {
    if (isRace) {
      if (m.isNewRacer) return { label: t("party.badge.starterOnly"), cls: "text-[#00e2e5]" };
      const tier = tierFromMemberships(m.memberships ?? []);
      return {
        label: tier,
        cls:
          tier === "Pro"
            ? "text-[#ff7a76]"
            : tier === "Intermediate"
              ? "text-[#b39dff]"
              : "text-[#00e2e5]",
      };
    }
    return null;
  };

  // Why Continue is disabled — surfaced as a prominent banner so a greyed-out
  // Continue is never a mystery (owner 2026-07-19). Suppressed while a waiver
  // check is still resolving (the cards show "Checking waiver…" then) or while a
  // form/lookup is open (the guest is mid-task).
  const readyState = peopleReady(party, Array.from(included));
  const blockReason =
    party.length > 0 &&
    checkingIds.size === 0 &&
    form === null &&
    !lookupOpen &&
    !waiverFor &&
    !licenseBusy &&
    !licenseMatches &&
    readyState !== true
      ? readyState.reason
      : null;

  return (
    <div className={theme === "mobile" ? "wp-mobile space-y-4" : "space-y-[24px]"}>
      <p className="text-[26px] text-white/55">
        {party.length > 0 ? t("party.intro.signedIn") : t("party.intro.empty")}
      </p>

      {blockReason && (
        <div className="flex items-start gap-[18px] rounded-2xl border-2 border-[#f0b341]/60 bg-[#f0b341]/12 px-[28px] py-[22px]">
          <span
            aria-hidden="true"
            className="mt-[4px] grid h-[36px] w-[36px] shrink-0 place-items-center rounded-full bg-[#f0b341] text-[26px] font-black text-[#2a1c00]"
          >
            !
          </span>
          <div>
            <div className="k-eyebrow text-[#f0b341]">{t("party.beforeContinue")}</div>
            <div className="mt-[4px] text-[28px] font-bold text-[#f5d38a]">{blockReason}</div>
          </div>
        </div>
      )}

      {/* license-scan progress + outcome (hardware scanner kiosks only) */}
      {licenseBusy && (
        <div className="flex items-center gap-[16px] rounded-2xl border-2 border-[#00e2e5]/40 bg-[#00e2e5]/10 px-[28px] py-[22px]">
          <span className="h-[28px] w-[28px] shrink-0 animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
          <span className="text-[26px] font-bold text-[#7ff3f4]">
            {t("party.license.checking")}
          </span>
        </div>
      )}
      {scanNote && !licenseBusy && (
        <div className="rounded-2xl border border-white/12 bg-white/5 px-[24px] py-[16px] text-[22px] text-white/60">
          {scanNote}
        </div>
      )}

      {/* roster — main always first */}
      <div className="space-y-[16px]">
        {orderedParty.map((m) => {
          const isIn = included.has(m.id);
          const badge = badgeFor(m);
          const guardian = m.guardianMemberId
            ? party.find((g) => g.id === m.guardianMemberId)
            : null;
          const ready = !needsSetup(m);
          const checking = !ready && checkingIds.has(m.id);
          return (
            <div
              key={m.id}
              className={`k-glass relative overflow-hidden p-[24px] ${
                mode === "attraction" && !isIn ? "opacity-55" : ""
              }`}
              style={{
                borderLeft: `8px solid ${ready ? "#46d68c" : checking ? "#00e2e5" : "#f0b341"}`,
              }}
            >
              <div className="flex items-center gap-[20px]">
                {mode === "attraction" && (
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    aria-pressed={isIn}
                    aria-label={
                      isIn
                        ? t("party.member.aria.removeFromActivity", { name: m.firstName })
                        : t("party.member.aria.addToActivity", { name: m.firstName })
                    }
                    className={`grid h-[64px] w-[64px] shrink-0 place-items-center rounded-2xl border-2 text-[32px] font-bold ${
                      isIn
                        ? "border-[#00e2e5] bg-[#00e2e5] text-[#04252b]"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    ✓
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[6px]">
                    <span className="k-display truncate text-[40px]">
                      {m.firstName} {m.lastName ?? ""}
                    </span>
                    {m.isBillingCustomer && (
                      <span className="k-eyebrow rounded-full bg-[#00e2e5]/15 px-[14px] py-[4px] text-[18px] text-[#00e2e5]">
                        {t("party.badge.main")}
                      </span>
                    )}
                    {m.isMinor && (
                      <span className="rounded-full bg-white/10 px-[14px] py-[4px] text-[20px] font-bold text-white/70">
                        {t("party.badge.minor")}
                      </span>
                    )}
                    {badge && (
                      <span className={`text-[22px] font-bold ${badge.cls}`}>{badge.label}</span>
                    )}
                    {m.creditBalances && m.creditBalances.length > 0 && (
                      <span className="text-[22px] font-semibold text-[#46d68c]">
                        {t("party.credits", {
                          n: m.creditBalances.reduce((s, c) => s + c.balance, 0),
                        })}
                      </span>
                    )}
                  </div>
                  <div className="mt-[8px] flex flex-wrap items-center gap-x-[24px] gap-y-[6px] text-[22px]">
                    {ready ? (
                      <span className="font-semibold text-[#46d68c]">
                        ✓ {t("party.status.ready")}
                      </span>
                    ) : checking ? (
                      <span className="flex items-center gap-[10px] font-semibold text-[#00e2e5]">
                        <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
                        {t("party.status.checkingWaiver")}
                      </span>
                    ) : (
                      <span className="font-semibold text-[#f0b341]">
                        {m.bmiPersonId
                          ? t("party.status.waiverNeeded")
                          : t("party.status.accountWaiverNeeded")}
                      </span>
                    )}
                    {guardian && (
                      <span className="text-white/45">
                        {t("party.guardianLabel", { name: guardian.firstName })}
                      </span>
                    )}
                    {onSetContact && !m.isBillingCustomer && (
                      <button
                        type="button"
                        onClick={() => markMain(m.id)}
                        className="text-[#00e2e5]/80 underline-offset-4 hover:underline"
                      >
                        {t("party.makeMain")}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-[12px]">
                  {!ready && !checking && (
                    <button
                      type="button"
                      onClick={() => openSetup(m)}
                      className="rounded-2xl border-2 border-[#f0b341]/55 px-[24px] py-[12px] text-[24px] font-bold text-[#f0b341]"
                    >
                      {m.bmiPersonId ? t("party.signWaiver") : t("party.setUp")}
                    </button>
                  )}
                  {isGuardianForSomeone(m) ? (
                    <span
                      className="text-[20px] font-semibold text-white/30"
                      title={t("party.guardianBadge.title")}
                    >
                      {t("party.guardianBadge")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => removeMember(m.id)}
                      aria-label={t("party.aria.remove", { name: m.firstName })}
                      className="text-[22px] text-white/40"
                    >
                      {t("party.remove")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* add / sign-in entry points */}
      {form === null && !lookupOpen && (
        <div className="grid grid-cols-2 gap-[16px]">
          <button
            type="button"
            onClick={() => {
              resetForm();
              setForm({ mode: "new" });
            }}
            className="k-tap rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[28px] text-[28px] font-bold text-[#00e2e5]"
          >
            + {t("party.addNewPlayer")}
          </button>
          <button
            type="button"
            onClick={() => setLookupOpen(true)}
            className="k-tap rounded-[28px] border-2 border-[#00e2e5]/45 bg-[#00e2e5]/10 px-[24px] py-[28px] text-[28px] font-bold text-white"
          >
            {t("party.signInFindPeople")}
          </button>
        </div>
      )}

      {/* Signer-only guardians — signed for a minor, NOT on the roster and not in
          any purchase. Shown so the adult can see they're accounted for, with the
          "Join the fun" escape hatch if they decide to play after all (owner
          2026-07-18: the parent may just be paying for the kids). */}
      {signTimeGuardian && guardians.length > 0 && (
        <div className="space-y-[12px]">
          {guardians.map((g) => (
            <div
              key={g.id}
              className="flex items-center justify-between gap-[16px] rounded-2xl border border-white/10 bg-white/[0.03] px-[24px] py-[18px]"
            >
              <div>
                <div className="text-[26px] font-bold text-white">
                  {formatPersonName(g.firstName)}
                </div>
                <div className="text-[20px] text-white/45">{t("party.guardian.signerOnly")}</div>
              </div>
              {onPromoteGuardian && (
                <button
                  type="button"
                  onClick={() => onPromoteGuardian(g)}
                  className="k-tap shrink-0 rounded-2xl border-2 border-[#00e2e5]/45 bg-[#00e2e5]/10 px-[24px] py-[14px] text-[22px] font-bold text-white"
                >
                  {t("party.guardian.joinTheFun")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Faster ways to sign in — phone QR + driver's-license + FastTrax
          license, side by side. Phone box hides while the join flag is off /
          idle; the scan boxes show only while the COM scanner is listening;
          once someone's on the roster the trio folds into a slim bar. */}
      {form === null && !lookupOpen && (
        <KioskSignInBoxes
          phone={mobileJoin}
          scanListening={licenseScan.listening}
          collapsed={party.length > 0}
        />
      )}

      {/* Linked family — OPT-IN suggestions (tap to add), never auto-added */}
      {linked.length > 0 && form === null && !lookupOpen && (
        <div>
          <div className="k-eyebrow mb-[12px] text-white/40">{t("party.linked.heading")}</div>
          <div className="flex flex-wrap gap-[12px]">
            {linked.map((lp) => {
              // Racing hard floor (7+): a linked kid under 7 can't be added to
              // a race party — show why instead of a dead tap.
              const tooYoung = isRace && lp.age !== null && lp.age < 7;
              return (
                <button
                  key={lp.id}
                  type="button"
                  onClick={tooYoung ? undefined : () => addLinked(lp)}
                  disabled={tooYoung}
                  className={`k-tap rounded-2xl border-2 px-[24px] py-[16px] text-left ${
                    tooYoung
                      ? "border-white/10 bg-white/[0.03] opacity-50"
                      : "border-[#46d68c]/40 bg-[#46d68c]/5"
                  }`}
                >
                  <div className="text-[26px] font-bold text-white">
                    + {lp.firstName} {lp.lastName}
                  </div>
                  <div className="text-[20px] text-white/50">
                    {lp.age !== null
                      ? t("party.linked.age", { age: lp.age })
                      : t("party.linked.family")}
                    {tooYoung
                      ? t("party.linked.tooYoung")
                      : lp.waiverValid
                        ? t("party.linked.waiverOnFile")
                        : t("party.linked.needsWaiver")}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* person form (new OR setup) */}
      {form !== null && (
        <div className="k-glass space-y-[20px] p-[28px]">
          <div className="k-display text-[32px]">
            {form.mode === "new"
              ? t("party.form.newPlayer")
              : t("party.form.setUpName", { name: form.member.firstName })}
          </div>
          {form.mode === "new" && (
            <div className="grid grid-cols-2 gap-[16px]">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t("party.form.firstName")}
                className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t("party.form.lastName")}
                className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
            </div>
          )}
          <input
            type="text"
            inputMode="numeric"
            data-osk-layout="numeric"
            value={dob}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
              const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(
                Boolean,
              );
              setDob(parts.join("/"));
            }}
            placeholder={t("party.form.birthday")}
            className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
          />
          {/* Every new player gives a mobile number; the main person (first added)
              also gives an email so we never need a separate YOUR INFO step. */}
          {form.mode === "new" && (
            <>
              <input
                type="tel"
                inputMode="tel"
                data-osk-layout="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t("party.form.mobilePhone")}
                className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
              <input
                type="email"
                inputMode="email"
                data-osk-layout="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={
                  isMainDefault ? t("party.form.emailMain") : t("party.form.emailOptional")
                }
                className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
            </>
          )}
          {/* Scanner shortcut inside the form too. */}
          {licenseScan.listening && form.mode === "new" && (
            <p className="text-[20px] text-white/35">{t("party.license.tip")}</p>
          )}
          {/* Guardian picker appears once we know they're a minor. Absent under
              sign-time resolution — the minor registers first and the guardian is
              found at the waiver, so asking here would be the dead end we removed. */}
          {!signTimeGuardian && ageFromDob(dob) !== null && (ageFromDob(dob) as number) < 18 && (
            <div>
              <div className="mb-[6px] text-[22px] text-white/55">
                {t("party.form.guardianPrompt")}
              </div>
              <div className="mb-[10px] text-[18px] leading-snug text-[#f0b341]/80">
                {t("party.form.guardianLegalNote")}
              </div>
              {adults.filter((a) => form.mode !== "setup" || a.id !== form.member.id).length ===
              0 ? (
                <div className="rounded-2xl border border-[#f0b341]/40 bg-[#f0b341]/10 px-[20px] py-[16px] text-[22px] text-[#f0b341]">
                  {t("party.err.needAdult")}
                </div>
              ) : (
                <div className="flex flex-wrap gap-[12px]">
                  {adults
                    .filter((a) => form.mode !== "setup" || a.id !== form.member.id)
                    .map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setGuardianId(a.id)}
                        className={`rounded-2xl border-2 px-[24px] py-[14px] text-[24px] font-bold ${
                          guardianId === a.id
                            ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                            : "border-white/15 text-white/60"
                        }`}
                      >
                        {a.firstName}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
          {formError && <p className="text-[24px] text-red-300">{formError}</p>}
          <div className="flex gap-[16px]">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
            >
              {t("party.form.cancel")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                form.mode === "new" ? void submitNew() : void submitSetup(form.member)
              }
              className="k-btn-primary k-tap h-[80px] flex-1 text-[28px]"
            >
              {busy ? t("party.form.settingUp") : t("party.form.continueToWaiver")}
            </button>
          </div>
        </div>
      )}

      {/* returning lookup */}
      {lookupOpen && (
        <div className="k-glass p-[28px]">
          <div className="mb-[16px] flex items-center justify-between">
            <div className="k-display text-[32px]">{t("party.lookup.title")}</div>
            <button
              type="button"
              onClick={() => setLookupOpen(false)}
              className="text-[24px] font-semibold text-white/50"
            >
              {t("party.lookup.close")}
            </button>
          </div>
          <ReturningRacerLookup
            wide
            onVerified={handleVerified}
            onVerifiedMultiple={handleVerifiedMultiple}
            onSwitchToNew={() => {
              setLookupOpen(false);
              resetForm();
              setForm({ mode: "new" });
            }}
          />
        </div>
      )}

      {/* License matched several accounts (duplicates / twins) — the guest
          picks theirs on the existing account cards. */}
      {licenseMatches && (
        <LicenseMatchPicker
          firstName={
            licenseMatches.license ? formatPersonName(licenseMatches.license.firstName) : ""
          }
          matches={licenseMatches.matches}
          onPick={(m) => {
            setLicenseMatches(null);
            signInLicenseMatch(m);
          }}
          onNewInstead={() => {
            const lic = licenseMatches.license;
            setLicenseMatches(null);
            if (lic) {
              openNewFormFromLicense(lic);
            } else {
              // Member QR path — no scanned name/DOB to prefill; blank form.
              resetForm();
              setForm({ mode: "new" });
            }
          }}
          onCancel={() => setLicenseMatches(null)}
        />
      )}

      {/* Sign-time guardian resolution: who signs for this minor? Three ways in —
          an adult already here, a brand-new adult, or an existing account. The
          adult added here is SIGNER-ONLY until they tap "Join the fun". */}
      {guardianFlow &&
        !waiverFor &&
        (() => {
          const gfMinor = party.find((m) => m.id === guardianFlow.minorMemberId);
          const candidates = [...adults, ...guardians].filter(
            (a) => a.id !== guardianFlow.minorMemberId,
          );
          return (
            <div className="fixed inset-0 z-[77] overflow-y-auto bg-[#000418] p-[48px] md:flex md:items-center md:justify-center">
              <div className="mx-auto w-full max-w-[900px] space-y-[24px]">
                <div>
                  <div className="k-eyebrow">{t("party.guardian.eyebrow")}</div>
                  <h2 className="k-display mt-[8px] text-[44px]">
                    {t("party.guardian.heading", { name: gfMinor?.firstName ?? "" })}
                  </h2>
                  <p className="mt-[10px] text-[22px] leading-snug text-[#f0b341]/80">
                    {t("party.form.guardianLegalNote")}
                  </p>
                </div>

                {guardianFlow.stage === "choose" && (
                  <div className="space-y-[20px]">
                    {candidates.length > 0 && (
                      <div className="flex flex-wrap gap-[12px]">
                        {candidates.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            disabled={busy}
                            onClick={() => void chooseGuardian(a)}
                            className={`k-tap rounded-2xl border-2 px-[24px] py-[18px] text-[24px] font-bold ${
                              choosingGuardianId === a.id
                                ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                                : "border-white/15 text-white/60"
                            }`}
                          >
                            {choosingGuardianId === a.id
                              ? t("party.guardian.checking", {
                                  name: formatPersonName(a.firstName),
                                })
                              : formatPersonName(a.firstName)}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        resetGuardianForm();
                        setGuardianFlow({ ...guardianFlow, stage: "new-form" });
                      }}
                      className="k-btn-primary k-tap h-[80px] w-full text-[26px]"
                    >
                      {t("party.guardian.addNewAdult")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setGuardianFlow({ ...guardianFlow, stage: "lookup" })}
                      className="k-tap w-full rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                    >
                      {t("party.guardian.findAccount")}
                    </button>
                  </div>
                )}

                {guardianFlow.stage === "new-form" && (
                  <div className="space-y-[20px]">
                    <div className="grid grid-cols-2 gap-[16px]">
                      <input
                        type="text"
                        value={gFirst}
                        onChange={(e) => setGFirst(e.target.value)}
                        placeholder={t("party.form.firstName")}
                        className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                      />
                      <input
                        type="text"
                        value={gLast}
                        onChange={(e) => setGLast(e.target.value)}
                        placeholder={t("party.form.lastName")}
                        className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                      />
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={gDob}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
                        const parts = [
                          digits.slice(0, 2),
                          digits.slice(2, 4),
                          digits.slice(4, 8),
                        ].filter(Boolean);
                        setGDob(parts.join("/"));
                      }}
                      placeholder={t("party.form.birthday")}
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    <input
                      type="tel"
                      inputMode="tel"
                      value={gPhone}
                      onChange={(e) => setGPhone(e.target.value)}
                      placeholder={t("party.form.mobilePhone")}
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    <input
                      type="email"
                      inputMode="email"
                      value={gEmail}
                      onChange={(e) => setGEmail(e.target.value)}
                      placeholder={t("party.form.emailOptional")}
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    {gError && <p className="text-[24px] text-red-300">{gError}</p>}
                    <div className="flex gap-[16px]">
                      <button
                        type="button"
                        onClick={() => setGuardianFlow({ ...guardianFlow, stage: "choose" })}
                        className="k-tap rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                      >
                        {t("party.form.cancel")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void submitGuardianNew()}
                        className="k-btn-primary k-tap h-[80px] flex-1 text-[28px]"
                      >
                        {busy ? t("party.form.settingUp") : t("party.guardian.continueToSign")}
                      </button>
                    </div>
                  </div>
                )}

                {guardianFlow.stage === "lookup" && (
                  <ReturningRacerLookup
                    wide
                    onVerified={(person) => void handleGuardianVerified(person)}
                    onSwitchToNew={() => {
                      resetGuardianForm();
                      setGuardianFlow({ ...guardianFlow, stage: "new-form" });
                    }}
                  />
                )}

                {guardianFlow.stage === "choose" && gError && (
                  <p className="text-[24px] text-red-300">{gError}</p>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setGuardianFlow(null);
                    resetGuardianForm();
                  }}
                  className="k-tap w-full rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                >
                  {t("party.waiver.cancelLater")}
                </button>
              </div>
            </div>
          );
        })()}

      {/* the REAL waiver: photo first (required adults / optional minors), then
          Pandora template + touch signature → signWaiverDigital. One overlay =
          "the same page" (owner 2026-07-18); no camera configured → straight to
          the signature (front desk photographs at check-in). */}
      {waiverFor &&
        (() => {
          const signer = party.find((p) => p.id === waiverFor.memberId);
          const needPhoto =
            photoStep !== "off" && hasCameraResolved && photoDoneFor !== waiverFor.memberId;
          const photoArgs = {
            memberName: signer?.firstName ?? t("party.guest"),
            isMinor: !!signer?.isMinor,
            onCaptured: (pngBase64: string) => {
              // Fire-and-forget: the route persists to Neon FIRST and the sweep
              // retries Pandora — never hold the waiver on network.
              void fetch("/api/pandora/person-picture", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  personId: waiverFor.personId,
                  location: center === "naples" ? "naples" : brandLocation,
                  pngBase64,
                }),
              }).catch(() => {});
              setPhotoDoneFor(waiverFor.memberId);
            },
            onSkip: () => setPhotoDoneFor(waiverFor.memberId),
          };
          return (
            <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-[48px]">
              {needPhoto ? (
                renderPhoto ? (
                  renderPhoto(photoArgs)
                ) : (
                  <KioskWaiverPhoto {...photoArgs} />
                )
              ) : (
                <div className="mx-auto max-w-[900px]">
                  <WaiverSigning
                    personId={waiverFor.personId}
                    template={waiverFor.template}
                    signerPersonId={waiverFor.signerPersonId}
                    location={brandLocation}
                    heading={
                      isRace ? t("party.waiver.headingRace") : t("party.waiver.headingActivity")
                    }
                    subheading={
                      waiverFor.signerName
                        ? t("party.waiver.subheadingGuardian", {
                            signer: waiverFor.signerName,
                            minor: signer?.firstName ?? t("party.waiver.theMinor"),
                          })
                        : t("party.waiver.subheading")
                    }
                    onComplete={(waiverId) => {
                      // Guardian just signed their OWN waiver → audit it, mark it,
                      // and chain straight to the minor's (guardian as sigPersonID).
                      if (guardianChain && waiverFor.memberId === guardianChain.guardianId) {
                        // patchPerson, NOT onUpdateMember: a signer-only guardian
                        // lives in `guardians`, where onUpdateMember is a no-op —
                        // their card then demands the waiver they just signed.
                        patchPerson(guardianChain.guardianId, { waiverValid: true });
                        onWaiverSigned?.({
                          memberId: guardianChain.guardianId,
                          personId: waiverFor.personId,
                          firstName: guardianChain.guardianName,
                          waiverId,
                          templateContentId: waiverFor.template.contentID,
                        });
                        setWaiverFor({
                          memberId: guardianChain.minorMemberId,
                          personId: guardianChain.minorPersonId,
                          template: guardianChain.minorTemplate,
                          signerPersonId: guardianChain.guardianSid,
                          signerName: guardianChain.guardianName,
                        });
                        return;
                      }
                      // Sign-time chain: also record the resolved guardian on the
                      // minor (waiverCompletePatch) — peopleReady demands it, and
                      // without it the flow can never reach its done state.
                      onUpdateMember(
                        waiverFor.memberId,
                        waiverCompletePatch(waiverFor.memberId, guardianFlow),
                      );
                      onWaiverSigned?.({
                        memberId: waiverFor.memberId,
                        personId: waiverFor.personId,
                        firstName: signer?.firstName ?? "",
                        signerPersonId: waiverFor.signerPersonId,
                        waiverId,
                        templateContentId: waiverFor.template.contentID,
                      });
                      // Minor signed by a guardian → the guardian is recorded by the
                      // waiver's sigPersonID. Nothing else to write: re-creating the
                      // minor to attach guardianID duplicated the person (see the
                      // Strachan note above).
                      if (waiverFor.signerPersonId) setGuardianChain(null);
                      // Minor's waiver landed → guardian resolution is finished.
                      if (guardianFlow?.minorMemberId === waiverFor.memberId) {
                        setGuardianFlow(null);
                        resetGuardianForm();
                      }
                      setWaiverFor(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setWaiverFor(null)}
                    className="mt-[24px] w-full rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                  >
                    {t("party.waiver.cancelLater")}
                  </button>
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
