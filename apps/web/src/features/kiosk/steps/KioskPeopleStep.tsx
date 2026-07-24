"use client";

/**
 * Unified kiosk people list — the ONE identity method for BOTH racing and
 * waiver-gated attractions (owner 2026-07-18: "why the different sign-ins?").
 *
 * The roster IS session.party, so it is SESSION-SCOPED: sign in / set someone
 * up once and they carry across every activity in the transaction — a later
 * activity never re-prompts a person who's already set up (owner rule). Racing
 * and attractions share this exact screen; the only difference is racing races
 * the whole party while an attraction toggles who's in that one activity.
 *
 * Every participant needs a real account + a signed waiver captured right here
 * (owner rule — all activities except bowling & duckpin). Business rules baked
 * into the list:
 *   - NEW racers are Starter-only (badge); RETURNING racers show their earned
 *     tier + credits. New and returning can mix in ONE transaction — the
 *     downstream product/heat steps already span tiers for a mixed party and
 *     Starter-gate the new racers at heat selection.
 *   - one person is the MAIN contact for the reservation (tap to set).
 *   - a MINOR (age < 18) can register FIRST — no adult required up front. A
 *     guardian is only involved when the minor's waiver actually needs signing
 *     (first-timer or expired); the adult signs it as sigPersonID and can be a
 *     party adult, a NEW adult, or an existing account found via lookup. A
 *     signer-only guardian lives in session.guardians — NEVER in the purchase
 *     (owner 2026-07-18: the parent may just be paying for the kids) — with a
 *     "Join the fun" escape hatch onto the roster.
 */
import { useEffect, useRef, useState } from "react";
import type { AttractionItem, PartyMember, RaceItem, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import { tierFromMemberships } from "~/features/booking/service/race-products";
import { getComboSpecial, comboMinHeadcount } from "~/features/combos/combo-specials";
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
import { isMegaTuesdayToday } from "../assets";
import { kioskHasCamera, kioskId } from "../config";
import { KioskWaiverPhoto } from "../components/KioskWaiverPhoto";
import { formatPersonName, normalizeEmail } from "~/lib/helpers/name-format";
import { kioskMobileJoinEnabled } from "../flags";
import { useMobileJoin } from "../hooks/useMobileJoin";
import { useLicenseScan, type AamvaLicense, type MemberQr } from "../qr-scanner";
import {
  fetchLicenseMatches,
  fetchMemberMatches,
  personDataFromMatch,
  prewarmLicenseLookup,
} from "../license/lookup-client";
import type { LicenseMatch } from "../license/types";
import { LicenseMatchPicker } from "../components/LicenseMatchPicker";
import { ageFromIso } from "../join/phone/join-helpers";
import { mergeJoinedGuests } from "../join/merge";
import { KioskSignInBoxes } from "../components/KioskSignInBoxes";

/** Waiver-gated attraction slugs (duckpin is exempt — uses the party-count step). */
const WAIVER_SLUGS = new Set(["gel-blaster", "laser-tag", "shuffly"]);

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

/** Bare 10 digits from any US phone formatting (strips a leading 1). */
function tenDigitsOf(phone: string | undefined): string {
  let d = (phone ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

/** A participant still needs setup when they lack an account or a valid waiver. */
function needsSetup(m: PartyMember): boolean {
  return !m.bmiPersonId || !m.waiverValid;
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

const PeopleStepComponent: StepDef<RaceItem | AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const isRace = item.kind === "race";
  const party = session.party;
  // CENTER FIRST: the Naples kiosk registers people, fetches waiver templates,
  // and checks waiver validity at the NAPLES Pandora location. Brand alone maps
  // "headpinz" to HP Fort Myers — Naples guests were being registered/signed
  // against Fort Myers (same misroute class as the 7/20 attraction-BMI bug).
  const brandLocation =
    session.center === "naples"
      ? "naples"
      : session.entryBrand === "headpinz"
        ? "headpinz"
        : "fasttrax";
  const attractionItem = item as AttractionItem;

  // Racing races the whole party; an attraction toggles who's in THIS one.
  const included = new Set(
    isRace ? party.map((m) => m.id) : (attractionItem.participants ?? party.map((m) => m.id)),
  );

  const [form, setForm] = useState<FormState>(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusyLocal] = useState(false);
  // ONE-TIME split-payment heads-up (owner 2026-07-20): kiosk checkout is one
  // payment for the whole group. The first time a guest grows an ATTRACTION
  // party past 3, intercept the add with a warning — Continue runs the
  // intercepted action, Never mind drops it. Once per visit to this step
  // (ref-gated), racing exempt.
  const splitWarnedRef = useRef(false);
  const [splitWarn, setSplitWarn] = useState<(() => void) | null>(null);
  const guardAdd = (action: () => void) => {
    if (!isRace && party.length >= 3 && !splitWarnedRef.current) {
      splitWarnedRef.current = true;
      setSplitWarn(() => action);
      return;
    }
    action();
  };
  const [waiverFor, setWaiverFor] = useState<{
    memberId: string;
    personId: string;
    template: PandoraWaiverTemplate;
    /** Guardian signing a MINOR's waiver: the guardian's SHORT Pandora id +
     *  display name (rides Pandora's sigPersonID). Absent = self-sign. */
    signerPersonId?: string;
    signerName?: string;
  } | null>(null);
  // Guardian resolution for a minor whose waiver needs signing (owner
  // 2026-07-18): the minor registers FIRST, then this flow finds the adult who
  // signs — a party adult, a NEW adult, or an existing account via lookup. The
  // adult signs their OWN waiver first if it isn't current, then the minor's.
  // Cleared on cancel (minor stays "needs setup") and on minor-waiver success.
  const [guardianFlow, setGuardianFlow] = useState<{
    minorMemberId: string;
    /** SHORT Pandora id resolved at onboard (17-digit Office fallback only in
     *  the no-dedup-identity branch — pre-existing sign limitation). */
    minorPersonId: string;
    minorTemplate: PandoraWaiverTemplate;
    /** Resolved guardian — a party member id OR a session.guardians entry id. */
    guardianId?: string;
    stage: "choose" | "new-form" | "lookup";
  } | null>(null);
  // Guardian "Add a new adult" form fields — separate from the player form so
  // the two can never contaminate each other.
  const [gFirst, setGFirst] = useState("");
  const [gLast, setGLast] = useState("");
  const [gDob, setGDob] = useState("");
  const [gPhone, setGPhone] = useState("");
  const [gEmail, setGEmail] = useState("");
  const [gError, setGError] = useState<string | null>(null);
  // Which guardian chip is mid-verification — the tap kicks off 1-3 Pandora
  // calls before anything else changes on screen, so the tapped chip must
  // light up + spin immediately or the tap reads as dead (owner 2026-07-21).
  const [choosingGuardianId, setChoosingGuardianId] = useState<string | null>(null);
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

  const adults = party.filter((m) => !m.isMinor);
  // Signer-only guardians — NOT in the party, so purchase paths (products,
  // heats, charges, BMI bill registration) never see them by construction.
  const guardians = session.guardians ?? [];
  const setBusyAll = (b: boolean) => setBusyLocal(b);

  /** Look a person up across BOTH rosters (party + signer-only guardians). */
  const findPerson = (id: string): PartyMember | undefined =>
    party.find((p) => p.id === id) ?? guardians.find((g) => g.id === id);

  /** Patch a person wherever they live (party or guardians). */
  const patchPerson = (id: string, patch: Partial<PartyMember>) => {
    if (party.some((p) => p.id === id)) dispatch({ type: "updatePartyMember", id, patch });
    else dispatch({ type: "updateGuardian", id, patch });
  };

  /** The SHORT Pandora id Pandora's waiver-sign accepts (the 17-digit Office id
   *  500s). New-created persons' bmiPersonId IS the short id; a returning-lookup
   *  id is 17-digit and needs the upsert-create resolve first. */
  const shortPandoraId = (m: PartyMember): string | null =>
    m.pandoraPersonId ?? (m.bmiPersonId && m.bmiPersonId.length <= 12 ? m.bmiPersonId : null);

  // The MAIN (billing contact) always renders first (owner 2026-07-18). Stable
  // sort — everyone else keeps add order.
  const orderedParty = [...party].sort(
    (a, b) => Number(!!b.isBillingCustomer) - Number(!!a.isBillingCustomer),
  );

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
        guardianFlow !== null ||
        // License scan mid-flight / match picker open — same "mid-task" rule.
        licenseBusy ||
        licenseMatches !== null,
    );
    return () => setBusy?.(false);
  }, [lookupOpen, form, busy, setBusy, checkingIds, guardianFlow, licenseBusy, licenseMatches]);

  const setIncluded = (ids: Set<string>) => {
    if (isRace) return;
    onChange({
      participants: Array.from(ids),
      qty: Math.max(ids.size, 1),
    } as Partial<AttractionItem>);
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
    dispatch({
      type: "setContact",
      patch: {
        firstName: m.firstName,
        lastName: m.lastName ?? "",
        ...(m.phone ? { phone: m.phone } : {}),
        ...(m.email ? { email: m.email } : {}),
        // OTP-proven phone rides along (or explicitly clears a stale flag when
        // the new main's phone isn't proven) — kiosk rewards redemption keys
        // on this to skip its SMS verify.
        phoneVerified: !!(m.phone && m.phoneVerified),
      },
    });
  };

  const markMain = (id: string) => {
    party.forEach((m) => {
      const shouldBe = m.id === id;
      if (!!m.isBillingCustomer !== shouldBe) {
        dispatch({ type: "updatePartyMember", id: m.id, patch: { isBillingCustomer: shouldBe } });
      }
    });
    const m = party.find((x) => x.id === id);
    if (m) setContactFrom(m);
  };

  const removeMember = (id: string) => {
    // Guardians ARE removable (owner 2026-07-19, reversing 2026-07-18): a minor
    // whose waiver is already signed keeps it (Pandora holds the sigPersonID);
    // an unsigned minor simply re-enters guardian resolution at sign time. Just
    // un-link any minors pointing at them (and drop them from the attraction set).
    party.forEach((m) => {
      if (m.guardianMemberId === id) {
        dispatch({ type: "updatePartyMember", id: m.id, patch: { guardianMemberId: undefined } });
      }
    });
    dispatch({ type: "removePartyMember", id });
    if (!isRace) {
      const next = new Set(included);
      next.delete(id);
      setIncluded(next);
    }
  };

  // Mobile join (flag-gated): a QR panel below the entry buttons lets adults
  // sign in / register + sign the waiver on their OWN phone; the 3s poll
  // merges finished guests straight into the roster. The hook stays mounted
  // while local overlays (form/lookup/waiver) are open — only leaving the
  // step (or KioskFlow's explicit closes) ends the join session. Phone joins
  // bypass guardAdd on purpose — the phone page shows its own split-payment
  // warning before anyone signs in.
  const mobileJoin = useMobileJoin({
    enabled: kioskMobileJoinEnabled() && !!kioskCfg,
    itemId: item.id,
    kioskId: kioskCfg ? kioskId(kioskCfg) : null,
    center: kioskCfg?.center ?? null,
    brand: kioskCfg?.brand ?? null,
    stepKind: isRace ? "race" : "attraction",
    onGuests: (guests) => {
      const { toAdd, promoteGuardians, alreadyPresent } = mergeJoinedGuests(
        party,
        guardians,
        guests,
      );
      // Owner 2026-07-20: a phone joiner landing on a main-less roster IS the
      // group's main person — "first person added becomes main" applies no
      // matter which surface added them (the race-today pack hand-off set
      // this precedent 2026-07-19). Contact seeds from what the phone gave
      // us; the contact step fills any missing email.
      let hasMain = party.some((m) => m.isBillingCustomer);
      const asMainIfFirst = (member: PartyMember): PartyMember => {
        if (hasMain) return member;
        hasMain = true;
        const main = { ...member, isBillingCustomer: true };
        setContactFrom(main);
        return main;
      };
      for (const member of toAdd) {
        dispatch({ type: "addPartyMember", member: asMainIfFirst(member) });
      }
      // A guardian who joined from their phone steps onto the roster — the
      // joinGuardian mechanics (same object id keeps wards' refs valid).
      for (const g of promoteGuardians) {
        dispatch({ type: "addPartyMember", member: asMainIfFirst({ ...g, waiverValid: true }) });
        dispatch({ type: "removeGuardian", id: g.id });
      }
      // Someone already on the roster re-verified by phone — silent success:
      // waiver now signed + the short Pandora id (never touch bmiPersonId) +
      // the OTP-proven phone (feeds the rewards verify-skip when they're main).
      for (const hit of alreadyPresent) {
        dispatch({
          type: "updatePartyMember",
          id: hit.memberId,
          patch: {
            waiverValid: true,
            ...(hit.pandoraPersonId ? { pandoraPersonId: hit.pandoraPersonId } : {}),
            ...(hit.phone && hit.phoneVerified ? { phone: hit.phone, phoneVerified: true } : {}),
          },
        });
        // The re-verified member may already BE the session contact — refresh
        // its proven flag too (phones match ⇒ safe to upgrade).
        const m = party.find((p) => p.id === hit.memberId);
        if (
          hit.phone &&
          hit.phoneVerified &&
          m?.isBillingCustomer &&
          tenDigitsOf(session.contact.phone) === tenDigitsOf(hit.phone)
        ) {
          dispatch({ type: "setContact", patch: { phoneVerified: true } });
        }
      }
      if (!isRace) {
        const newIds = [...toAdd, ...promoteGuardians].map((m) => m.id);
        if (newIds.length) setIncluded(new Set([...included, ...newIds]));
      }
    },
  });

  const resetForm = () => {
    setForm(null);
    setFirstName("");
    setLastName("");
    setDob("");
    setPhone("");
    setEmail("");
    setFormError(null);
  };

  const resetGuardianForm = () => {
    setGFirst("");
    setGLast("");
    setGDob("");
    setGPhone("");
    setGEmail("");
    setGError(null);
  };

  const isMainDefault = party.length === 0; // first person added becomes main

  /** Add a brand-NEW person (name + DOB + mobile [+ guardian if minor]) → onboard → waiver. */
  const submitNew = async () => {
    const age = ageFromDob(dob);
    const isMain = party.length === 0;
    if (!firstName.trim() || !lastName.trim()) {
      setFormError("Enter a first and last name.");
      return;
    }
    if (age === null) {
      setFormError("Enter the birthday as MM/DD/YYYY.");
      return;
    }
    // HARD racing age floor (venue rule: juniors are ages 7–13). The safety
    // modal only ATTESTS this — but the kiosk collects a real DOB, so enforce
    // it at capture instead of letting a family book a 5-year-old and get
    // turned away at the track (owner 2026-07-18 age-check ask).
    if (isRace && age < 7) {
      setFormError(
        `${formatPersonName(firstName) || "This racer"} is under 7 — too young to race. Kids under 7 are welcome trackside, or check out Duckpin bowling.`,
      );
      return;
    }
    // Every new player gives a mobile number (owner rule); the main person also
    // gives an email so their contact is complete and no YOUR INFO step is needed.
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setFormError("Enter a mobile phone number.");
      return;
    }
    if (isMain && !email.includes("@")) {
      setFormError("The main person needs an email for the confirmation.");
      return;
    }
    // Minors register FIRST — no adult precondition (owner 2026-07-18). The
    // upsert-style create + waiver check below is what tells us whether a
    // guardian is even needed: a returning minor with a current waiver resolves
    // to their existing person and needs no guardian at all. (Minor routing
    // uses the REFRESHED age below, not the typed one.)
    setBusyAll(true);
    setFormError(null);
    try {
      // Normalized person data (owner 2026-07-19: Title Case names, lowercase
      // email) — what we store locally AND what Pandora/BMI receives.
      const cleanFirst = formatPersonName(firstName);
      const cleanLast = formatPersonName(lastName);
      const cleanEmail = normalizeEmail(email);
      const result = await pandoraOnboardGuest(
        {
          firstName: cleanFirst,
          lastName: cleanLast,
          email: cleanEmail || session.contact.email || "",
          phone: phone.trim(),
          birthdate: toIsoDob(dob),
        },
        brandLocation,
      );
      // Refreshed age: the upsert may have resolved an EXISTING BMI record —
      // its birthdate (returned by the waiver check) beats a kiosk typo, so
      // minor/guardian routing uses it (2026-07-23 adult-waiver-on-a-17yo bug).
      const rAge = ageFromIso(result.birthdate) ?? age;
      const rMinor = rAge < 18;
      const member = newPartyMember({
        firstName: cleanFirst,
        lastName: cleanLast,
        isNewRacer: true, // new person → Starter-only for racing
        category: rAge < 13 ? "junior" : "adult",
        isMinor: rMinor,
        bmiPersonId: result.personId,
        waiverValid: result.waiverValid,
        isBillingCustomer: isMain, // first person is main by default
        phone: phone.trim(),
        email: cleanEmail || undefined,
        dobIso: result.birthdate,
      });
      dispatch({ type: "addPartyMember", member });
      if (isMain) setContactFrom(member); // main person → booking contact
      if (!isRace) setIncluded(new Set([...included, member.id]));
      resetForm();
      if (!result.waiverValid && result.template) {
        if (rMinor) {
          // A minor never signs their own waiver — resolve a guardian first.
          setGuardianFlow({
            minorMemberId: member.id,
            minorPersonId: result.personId,
            minorTemplate: result.template,
            stage: "choose",
          });
        } else {
          setWaiverFor({
            memberId: member.id,
            personId: result.personId,
            template: result.template,
          });
        }
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? `Couldn't set that person up: ${err.message}`
          : "Couldn't set that person up. Please try again or see the front desk.",
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** Finish setup for an EXISTING roster member (needs account and/or waiver). */
  const submitSetup = async (member: PartyMember) => {
    const age = ageFromDob(dob);
    if (age === null) {
      setFormError("Enter the birthday as MM/DD/YYYY.");
      return;
    }
    // Same hard racing floor as submitNew — a "Set up" on an existing roster
    // member is still the moment we learn their real DOB.
    if (isRace && age < 7) {
      setFormError(
        `${member.firstName} is under 7 — too young to race. Kids under 7 are welcome trackside, or check out Duckpin bowling.`,
      );
      return;
    }
    // A minor needing a signature gets a guardian AFTER onboarding — the
    // waiver check below decides whether one is needed at all (owner 2026-07-18).
    const minor = age < 18;
    setBusyAll(true);
    setFormError(null);
    // Route an unsigned minor into the guardian flow instead of the signature
    // pad — a minor never signs their own waiver. `asMinor` comes from the
    // REFRESHED age when the onboard resolved an existing BMI record.
    const openWaiverOrGuardian = (
      personId: string,
      template: PandoraWaiverTemplate,
      asMinor: boolean,
    ) => {
      if (asMinor) {
        setGuardianFlow({
          minorMemberId: member.id,
          minorPersonId: personId,
          minorTemplate: template,
          stage: "choose",
        });
      } else {
        setWaiverFor({ memberId: member.id, personId, template });
      }
    };
    try {
      if (!member.bmiPersonId) {
        const result = await pandoraOnboardGuest(
          {
            firstName: formatPersonName(member.firstName),
            lastName: formatPersonName(member.lastName ?? ""),
            email: normalizeEmail(session.contact.email ?? ""),
            phone: session.contact.phone ?? "",
            birthdate: toIsoDob(dob),
          },
          brandLocation,
        );
        const rAge = ageFromIso(result.birthdate) ?? age;
        const rMinor = rAge < 18;
        dispatch({
          type: "updatePartyMember",
          id: member.id,
          patch: {
            bmiPersonId: result.personId,
            waiverValid: result.waiverValid,
            isMinor: rMinor,
            category: rAge < 13 ? "junior" : "adult",
            dobIso: result.birthdate,
          },
        });
        resetForm();
        if (!result.waiverValid && result.template) {
          openWaiverOrGuardian(result.personId, result.template, rMinor);
        }
      } else {
        // Account exists (returning racer) — but the lookup's id is the
        // 17-digit OFFICE id, which Pandora's waiver-sign endpoint REJECTS
        // (live 2026-07-18: sign 500s; the "second time worked" because the
        // upsert-style Pandora create resolved the same human to their SHORT
        // id). Resolve the short id via that same upsert (known person → same
        // personId, never a duplicate) using the member's OWN phone/email as
        // the dedup identity, then sign against it. It also returns the REAL
        // waiver status — a regular with a current waiver skips signing.
        const dedupPhone = member.phone?.trim() ?? "";
        const dedupEmail = member.email?.trim() ?? "";
        if (dedupPhone || dedupEmail) {
          const result = await pandoraOnboardGuest(
            {
              firstName: formatPersonName(member.firstName),
              lastName: formatPersonName(member.lastName ?? ""),
              email: dedupEmail,
              phone: dedupPhone,
              birthdate: toIsoDob(dob),
            },
            brandLocation,
          );
          // Returning racer: the BMI record's birthdate (refreshed by the
          // onboard) is authoritative over what was typed at the kiosk.
          const rAge = ageFromIso(result.birthdate) ?? age;
          const rMinor = rAge < 18;
          dispatch({
            type: "updatePartyMember",
            id: member.id,
            patch: {
              pandoraPersonId: result.personId,
              waiverValid: result.waiverValid,
              isMinor: rMinor,
              category: rAge < 13 ? "junior" : "adult",
              dobIso: result.birthdate,
            },
          });
          resetForm();
          if (!result.waiverValid && result.template) {
            openWaiverOrGuardian(result.personId, result.template, rMinor);
          }
        } else {
          // No phone/email on file to dedup against — DON'T upsert (risk of a
          // duplicate person). Old path; the front desk can sign at check-in.
          // For a minor this keeps the 17-digit Office id (pre-existing sign
          // limitation — Pandora may 500; front desk is the fallback).
          const template = await pandoraFetchWaiverTemplate(age, brandLocation);
          dispatch({
            type: "updatePartyMember",
            id: member.id,
            patch: {
              isMinor: minor,
              category: age < 13 ? "junior" : "adult",
              dobIso: toIsoDob(dob),
            },
          });
          resetForm();
          openWaiverOrGuardian(member.bmiPersonId, template, minor);
        }
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? `Couldn't finish setup: ${err.message}`
          : "Couldn't finish setup. Please try again or see the front desk.",
      );
    } finally {
      setBusyAll(false);
    }
  };

  /* ── guardian resolution (minor waiver signing) ─────────────────────────── */

  /** Guardian resolved (short id + own-waiver status known): sign their OWN
   *  waiver first if it isn't current, otherwise go straight to the minor's
   *  waiver with the guardian as sigPersonID. */
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
      // Own waiver first (owner rule) — the sign-complete handler chains to the
      // minor's waiver.
      setWaiverFor({ memberId: g.id, personId: sid, template: ownTemplate });
    }
  };

  /** Tap on an adult already here (party adult or a prior guardian chip):
   *  resolve their SHORT Pandora id (upsert on their own phone/email if needed)
   *  and re-check their waiver authoritatively before they sign for the minor. */
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
        if (!gPhoneTrim && !gEmailTrim) {
          throw new Error(`We can't verify ${g.firstName} here — use "Find their account".`);
        }
        const { personId } = await pandoraCreatePerson({
          firstName: g.firstName,
          lastName: g.lastName ?? "",
          email: gEmailTrim,
          phone: gPhoneTrim,
          birthdate: g.dobIso,
          location: brandLocation,
        });
        patchPerson(g.id, { pandoraPersonId: personId });
        sid = personId;
      }
      const status = await pandoraCheckWaiver(sid, brandLocation);
      // MEMBERSHIP REFRESH: the waiver check just returned the BMI record's
      // birthdate — use it when the roster entry has no DOB locally, instead of
      // assuming adult. (2026-07-23: a 17-year-old signed an ADULT waiver as a
      // "guardian" because unknown ages defaulted to 35 here.)
      const gDobIso = g.dobIso ?? (status.birthdate ? String(status.birthdate).slice(0, 10) : null);
      const gAge = ageFromIso(gDobIso);
      if (gAge !== null && gAge < 18) {
        throw new Error(`${g.firstName} is under 18 — a guardian must be an adult.`);
      }
      if (!g.dobIso && gDobIso) patchPerson(g.id, { dobIso: gDobIso });
      let ownTemplate: PandoraWaiverTemplate | null = null;
      if (!status.valid) {
        // Truly unknown age (no DOB locally OR in BMI) still gets the adult
        // template — the <18 gate above can't fire without a birthdate.
        ownTemplate = await pandoraFetchWaiverTemplate(gAge ?? 35, brandLocation);
      }
      if (status.valid !== !!g.waiverValid) patchPerson(g.id, { waiverValid: status.valid });
      proceedWithGuardian(g, sid, status.valid, ownTemplate, gf);
    } catch (err) {
      setGError(
        err instanceof Error
          ? err.message
          : "Couldn't verify that adult. Please try again or see the front desk.",
      );
    } finally {
      setBusyAll(false);
      setChoosingGuardianId(null);
    }
  };

  /** "Add a new adult" — create + waiver-check the guardian, then chain. They
   *  are a signer-only guardian (session.guardians), NOT part of the purchase. */
  const submitGuardianNew = async () => {
    const gf = guardianFlow;
    if (!gf) return;
    const gAge = ageFromDob(gDob);
    if (!gFirst.trim() || !gLast.trim()) {
      setGError("Enter the adult's first and last name.");
      return;
    }
    if (gAge === null) {
      setGError("Enter the birthday as MM/DD/YYYY.");
      return;
    }
    if (gAge < 18) {
      setGError("A guardian must be 18 or older.");
      return;
    }
    if (gPhone.replace(/\D/g, "").length < 10) {
      setGError("Enter a mobile phone number.");
      return;
    }
    setBusyAll(true);
    setGError(null);
    try {
      const gCleanFirst = formatPersonName(gFirst);
      const gCleanLast = formatPersonName(gLast);
      const gCleanEmail = normalizeEmail(gEmail);
      const result = await pandoraOnboardGuest(
        {
          firstName: gCleanFirst,
          lastName: gCleanLast,
          email: gCleanEmail || "",
          phone: gPhone.trim(),
          birthdate: toIsoDob(gDob),
        },
        brandLocation,
      );
      // The upsert may resolve to an EXISTING BMI record — re-gate on ITS
      // birthdate, so a typed adult DOB can't smuggle a known minor in as
      // the guardian.
      const rAge = ageFromIso(result.birthdate) ?? gAge;
      if (rAge < 18) {
        setGError("A guardian must be 18 or older.");
        return;
      }
      const g = newPartyMember({
        firstName: gCleanFirst,
        lastName: gCleanLast,
        isNewRacer: true,
        category: "adult",
        bmiPersonId: result.personId, // short id — created via Pandora
        waiverValid: result.waiverValid,
        phone: gPhone.trim(),
        email: gCleanEmail || undefined,
        dobIso: result.birthdate,
      });
      dispatch({ type: "addGuardian", member: g });
      resetGuardianForm();
      proceedWithGuardian(g, result.personId, result.waiverValid, result.template, gf);
    } catch (err) {
      setGError(
        err instanceof Error
          ? `Couldn't set the guardian up: ${err.message}`
          : "Couldn't set the guardian up. Please try again or see the front desk.",
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** "Find their account" — OTP-verified existing adult becomes the signer.
   *  Resolve their SHORT id via the upsert (same pattern as submitSetup) and
   *  get authoritative waiver status; own waiver first if lapsed (owner rule). */
  const handleGuardianVerified = async (person: PersonData) => {
    const gf = guardianFlow;
    if (!gf) return;
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const bdIso = person.birthDate ? String(person.birthDate).slice(0, 10) : undefined;
    const bdYears = ageFromIso(bdIso);
    if (bdYears !== null && bdYears < 18) {
      setGError("That account belongs to a minor — a guardian must be an adult.");
      return;
    }
    // Already on the roster (party adult or a prior guardian chip)? Reuse that
    // entry instead of adding a duplicate person. Known minors never qualify —
    // an Office record with no birthdate could slip past the age check above.
    const existing = [...party, ...guardians].find(
      (m) =>
        !m.isMinor && (m.bmiPersonId === person.personId || m.pandoraPersonId === person.personId),
    );
    if (existing) {
      void chooseGuardian(existing);
      return;
    }
    if (party.some((m) => m.isMinor && m.bmiPersonId === person.personId)) {
      setGError("That account belongs to a minor — a guardian must be an adult.");
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
      // MEMBERSHIP REFRESH: an Office record can come back from the lookup with
      // NO birthdate — the age gate above can't fire, and this path used to
      // default the template age to 35 (2026-07-23: a 17-year-old signed an
      // ADULT waiver). Pull the BMI record's birthdate before trusting "adult".
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
        if (!refreshedIso && status.birthdate) {
          refreshedIso = String(status.birthdate).slice(0, 10);
        }
      } else if (!refreshedIso) {
        // No dedup identity to upsert on — best-effort refresh by the lookup id.
        const probe = await pandoraCheckWaiver(person.personId, brandLocation).catch(() => null);
        if (probe?.birthdate) refreshedIso = String(probe.birthdate).slice(0, 10);
      }
      const refreshedAge = ageFromIso(refreshedIso);
      if (refreshedAge !== null && refreshedAge < 18) {
        setGError("That account belongs to a minor — a guardian must be an adult.");
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
          email: normalizeEmail(person.email ?? "") || undefined,
          dobIso: refreshedIso ?? undefined,
        }),
        ...(sid ? { pandoraPersonId: sid } : {}),
      };
      dispatch({ type: "addGuardian", member: g });
      // No phone/email to dedup against → last resort: sign with the Office id
      // (pre-existing Pandora limitation; may 500 — front desk fallback).
      proceedWithGuardian(g, sid ?? person.personId, ownValid, ownTemplate, gf);
    } catch (err) {
      setGError(
        err instanceof Error
          ? `Couldn't verify that account: ${err.message}`
          : "Couldn't verify that account. Please try again or see the front desk.",
      );
    } finally {
      setBusyAll(false);
    }
  };

  /** Best-effort BMI-level guardian link: re-run the upsert create for the
   *  minor with guardianID attached (known person → same id, never a
   *  duplicate). The waiver's sigPersonID records the guardian regardless, so
   *  a failure here is non-fatal — fire and forget. Skipped when the minor has
   *  no phone/email dedup identity (an upsert then risks a duplicate person). */
  const linkMinorToGuardian = (minorMemberId: string, guardianSid: string) => {
    const minor = party.find((m) => m.id === minorMemberId);
    if (!minor) return;
    const mPhone = minor.phone?.trim() ?? "";
    const mEmail = minor.email?.trim() ?? "";
    if (!mPhone && !mEmail) return;
    void pandoraCreatePerson({
      firstName: minor.firstName,
      lastName: minor.lastName ?? "",
      email: mEmail,
      phone: mPhone,
      birthdate: minor.dobIso,
      guardianID: guardianSid,
      location: brandLocation,
    }).catch(() => {});
  };

  /** "Join the fun" — the signer-only guardian decides to play after all.
   *  Same object (same id) moves into the party, so minors' guardianMemberId
   *  refs stay valid and the party removal guard covers them automatically. */
  const joinGuardian = (g: PartyMember) => {
    dispatch({ type: "addPartyMember", member: g });
    dispatch({ type: "removeGuardian", id: g.id });
    if (!isRace) setIncluded(new Set([...included, g.id]));
  };

  const removeGuardianEntry = (id: string) => {
    // Removable like party members (owner 2026-07-19) — un-link their minors
    // first; a signed waiver survives (sigPersonID is on the Pandora record).
    party.forEach((m) => {
      if (m.guardianMemberId === id) {
        dispatch({ type: "updatePartyMember", id: m.id, patch: { guardianMemberId: undefined } });
      }
    });
    dispatch({ type: "removeGuardian", id });
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
        dispatch({ type: "updatePartyMember", id: memberId, patch: { waiverValid: data.valid } });
      }
      // Backfill DOB → age bucket if the Office lookup didn't carry a birthday.
      if (data.birthdate) {
        const iso = String(data.birthdate).slice(0, 10);
        const yrs = Math.floor(
          (Date.now() - new Date(data.birthdate).getTime()) / (365.25 * 864e5),
        );
        dispatch({
          type: "updatePartyMember",
          id: memberId,
          patch: {
            dobIso: iso,
            isMinor: yrs < 18,
            category: yrs < 13 ? "junior" : "adult",
          },
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
              // Linked-family names come from the CRM (often ALL CAPS) — format
              // at collection so the suggestion chips AND addLinked stay clean.
              firstName: formatPersonName(first),
              lastName: formatPersonName(last),
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
    dispatch({ type: "addPartyMember", member });
    if (!isRace) setIncluded(new Set([...included, member.id]));
    setLinked((prev) => prev.filter((l) => l.id !== lp.id));
  };

  // `claimMain` defaults to the first-added-becomes-main rule; a batch add
  // passes it explicitly so only ONE member claims main (reading party.length
  // inside a loop is stale — every iteration would think it's first). `batchIds`
  // are the other accounts being added in the same batch, so linked-family
  // suggestions don't re-offer a sibling already selected.
  const handleVerified = (
    person: PersonData,
    claimMain: boolean = party.length === 0,
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
      // Office/Pandora records are often stored ALL CAPS — normalize what we
      // keep and display (owner 2026-07-19).
      firstName: formatPersonName(first || person.fullName),
      lastName: formatPersonName(rest.join(" ")) || undefined,
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
      email: normalizeEmail(person.email ?? "") || undefined,
    });
    dispatch({ type: "addPartyMember", member });
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
  // Only the first claims main (when the party is empty); each still gets its
  // own authoritative Pandora waiver check via handleVerified → importLinked.
  const handleVerifiedMultiple = (people: PersonData[]) => {
    if (people.length === 0) return;
    const canClaimMain = party.length === 0;
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
    setFormError(null);
  };

  /* ── driver's-license scan (hardware QR scanner) ─────────────────────────
     A scan carries the guest's name + DOB (aamva.ts extracts nothing else).
     Roster view → look their account up by last name + DOB (owner 2026-07-23:
     the physical ID is the identity proof) and sign them in; no account →
     the new-player form opens prefilled. With a form already open, the scan
     just fills it. (State lives up with the other state hooks — the setBusy
     effect reads it.) */
  const isoToMmDdYyyy = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
  };

  /** Fill the OPEN new-player form (keeps any phone/email already typed). */
  const fillNewForm = (lic: AamvaLicense) => {
    setFirstName(formatPersonName(lic.firstName));
    setLastName(formatPersonName(lic.lastName));
    setDob(isoToMmDdYyyy(lic.dobIso));
    setFormError(null);
  };

  const openNewFormFromLicense = (lic: AamvaLicense) => {
    guardAdd(() => {
      resetForm();
      setForm({ mode: "new" });
      fillNewForm(lic);
    });
  };

  /** Sign a matched account in through the SAME rail as the OTP lookup. */
  const signInLicenseMatch = (m: LicenseMatch) => {
    const already = party.find(
      (x) => x.bmiPersonId === m.personId || x.pandoraPersonId === m.personId,
    );
    if (already) {
      setScanNote(`${already.firstName} is already signed in.`);
      return;
    }
    // A signer-only guardian who scans their license wants to play — same
    // move as the "Join the fun" button (same object id keeps wards' refs).
    const g = guardians.find(
      (x) => x.bmiPersonId === m.personId || x.pandoraPersonId === m.personId,
    );
    if (g) {
      joinGuardian(g);
      setScanNote(null);
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
      const matches = await fetchLicenseMatches(lic, brandLocation);
      if (matches === null) {
        // Lookup unavailable — never block the guest; fall through to the form.
        setScanNote("We couldn't check for an account just now — let's set you up here.");
        openNewFormFromLicense(lic);
      } else if (matches.length === 0) {
        setScanNote(null);
        openNewFormFromLicense(lic);
      } else if (matches.length === 1) {
        signInLicenseMatch(matches[0]);
      } else {
        // Duplicates / twins — the guest picks (existing account selector).
        setLicenseMatches({ license: lic, matches });
      }
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleLicense = (lic: AamvaLicense) => {
    if (waiverFor || busy || licenseBusy || licenseMatches || splitWarn) return;
    if (guardianFlow) {
      // The scan is the ADULT's ID — prefill the "new adult" guardian form.
      // (A scanned minor is caught by the form's existing 18+ gate.)
      setGFirst(formatPersonName(lic.firstName));
      setGLast(formatPersonName(lic.lastName));
      setGDob(isoToMmDdYyyy(lic.dobIso));
      setGError(null);
      setGuardianFlow({ ...guardianFlow, stage: "new-form" });
      return;
    }
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
        setFormError(
          `That license doesn't look like ${form.member.firstName}'s — enter their birthday instead.`,
        );
      }
      return;
    }
    void runLicenseLookup(lic);
  };

  /** SMS-Timing member QR (the app's personal QR) — straight to lookup: the
   *  code IS the identity, so there's no form-prefill fallback (we know no
   *  name); a miss just points the guest at the normal sign-in. */
  const runMemberLookup = async (qr: MemberQr) => {
    setLicenseBusy(true);
    setScanNote(null);
    setLookupOpen(false);
    try {
      const matches = await fetchMemberMatches(qr);
      if (matches === null) {
        setScanNote("We couldn't check that code just now — sign in below instead.");
      } else if (matches.length === 0) {
        setScanNote("We couldn't find an account for that code — sign in below instead.");
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
    if (waiverFor || busy || licenseBusy || licenseMatches || splitWarn) return;
    if (guardianFlow || form) return; // mid-task — a sign-in QR doesn't apply
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
      prewarmLicenseLookup(brandLocation);
    }
  }, [kioskCfg, brandLocation]);

  const badgeFor = (m: PartyMember) => {
    if (isRace) {
      if (m.isNewRacer) return { label: "Starter only", cls: "text-[#00e2e5]" };
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
    !guardianFlow &&
    !licenseBusy &&
    !licenseMatches &&
    readyState !== true
      ? readyState.reason
      : null;

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">
        {party.length > 0
          ? "Your group is signed in — everyone here needs an account and a signed waiver."
          : "Add everyone playing. Each person gets an account and signs the waiver right here — so check-in is the Express Lane, not a line."}
      </p>

      {/* Mega Tuesday junior rule (owner 2026-07-21) — the kiosk books TODAY,
          so on Mega days first-time Juniors can't race at all. Racing only. */}
      {isRace && isMegaTuesdayToday() && (
        <div className="flex items-start gap-[18px] rounded-2xl border-2 border-[#e53935] bg-[#e53935]/12 px-[28px] py-[22px]">
          <span
            aria-hidden="true"
            className="mt-[4px] grid h-[36px] w-[36px] shrink-0 place-items-center rounded-full bg-[#e53935] text-[26px] font-black text-white"
          >
            !
          </span>
          <div>
            <div className="k-eyebrow text-[#ff5a52]">Mega Tuesday</div>
            <div className="mt-[4px] text-[28px] font-bold text-[#ff8a86]">
              First-time Junior racers can&rsquo;t race today — Juniors must qualify on a
              split-track (Blue/Red) day first.
            </div>
          </div>
        </div>
      )}

      {blockReason && (
        <div className="flex items-start gap-[18px] rounded-2xl border-2 border-[#f0b341]/60 bg-[#f0b341]/12 px-[28px] py-[22px]">
          <span
            aria-hidden="true"
            className="mt-[4px] grid h-[36px] w-[36px] shrink-0 place-items-center rounded-full bg-[#f0b341] text-[26px] font-black text-[#2a1c00]"
          >
            !
          </span>
          <div>
            <div className="k-eyebrow text-[#f0b341]">Before you continue</div>
            <div className="mt-[4px] text-[28px] font-bold text-[#f5d38a]">{blockReason}</div>
          </div>
        </div>
      )}

      {/* license-scan progress + outcome (hardware scanner kiosks only) */}
      {licenseBusy && (
        <div className="flex items-center gap-[16px] rounded-2xl border-2 border-[#00e2e5]/40 bg-[#00e2e5]/10 px-[28px] py-[22px]">
          <span className="h-[28px] w-[28px] shrink-0 animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
          <span className="text-[26px] font-bold text-[#7ff3f4]">
            Checking your license for an account…
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
          const guardian = m.guardianMemberId ? findPerson(m.guardianMemberId) : null;
          const ready = !needsSetup(m);
          const checking = !ready && checkingIds.has(m.id);
          return (
            <div
              key={m.id}
              className={`k-glass relative overflow-hidden p-[24px] ${
                !isRace && !isIn ? "opacity-55" : ""
              }`}
              style={{
                borderLeft: `8px solid ${ready ? "#46d68c" : checking ? "#00e2e5" : "#f0b341"}`,
              }}
            >
              <div className="flex items-center gap-[20px]">
                {!isRace && (
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    aria-pressed={isIn}
                    aria-label={
                      isIn
                        ? `Remove ${m.firstName} from this activity`
                        : `Add ${m.firstName} to this activity`
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
                    <span
                      className="k-display truncate text-[40px]"
                      // Names render as entered ("John Smith") — .k-display's
                      // design uppercase is for headings, not people
                      // (owner 2026-07-19: "stop the all caps").
                      style={{ textTransform: "none" }}
                    >
                      {m.firstName} {m.lastName ?? ""}
                    </span>
                    {m.isBillingCustomer && (
                      <span className="k-eyebrow rounded-full bg-[#00e2e5]/15 px-[14px] py-[4px] text-[18px] text-[#00e2e5]">
                        Main
                      </span>
                    )}
                    {m.isMinor && (
                      <span className="rounded-full bg-white/10 px-[14px] py-[4px] text-[20px] font-bold text-white/70">
                        Minor
                      </span>
                    )}
                    {badge && (
                      <span className={`text-[22px] font-bold ${badge.cls}`}>{badge.label}</span>
                    )}
                    {m.creditBalances && m.creditBalances.length > 0 && (
                      <span className="text-[22px] font-semibold text-[#46d68c]">
                        {m.creditBalances.reduce((s, c) => s + c.balance, 0)} credits
                      </span>
                    )}
                  </div>
                  <div className="mt-[8px] flex flex-wrap items-center gap-x-[24px] gap-y-[6px] text-[22px]">
                    {ready ? (
                      <span className="font-semibold text-[#46d68c]">
                        ✓ Account &amp; waiver ready
                      </span>
                    ) : checking ? (
                      <span className="flex items-center gap-[10px] font-semibold text-[#00e2e5]">
                        <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
                        Checking waiver…
                      </span>
                    ) : (
                      <span className="font-semibold text-[#f0b341]">
                        {m.bmiPersonId
                          ? m.isMinor
                            ? "Waiver needed — a parent/guardian signs"
                            : "Waiver needed"
                          : "Account + waiver needed"}
                      </span>
                    )}
                    {guardian && (
                      <span className="text-white/45">Guardian: {guardian.firstName}</span>
                    )}
                    {!m.isBillingCustomer && (
                      <button
                        type="button"
                        onClick={() => markMain(m.id)}
                        className="text-[#00e2e5]/80 underline-offset-4 hover:underline"
                      >
                        Make main
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
                      {m.bmiPersonId ? "Sign waiver" : "Set up"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeMember(m.id)}
                    aria-label={`Remove ${m.firstName}`}
                    className="text-[22px] text-white/40"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Signer-only guardians — signed for a minor, NOT in the purchase.
          "Join the fun" moves them onto the roster (same id, so minors'
          guardianMemberId refs stay valid). */}
      {guardians.length > 0 && (
        <div>
          <div className="k-eyebrow mb-[12px] text-white/40">Guardians — signed, not playing</div>
          <div className="flex flex-wrap gap-[12px]">
            {guardians.map((g) => {
              const wards = party
                .filter((m) => m.guardianMemberId === g.id)
                .map((m) => m.firstName);
              return (
                <div
                  key={g.id}
                  className="rounded-2xl border-2 border-dashed border-white/20 bg-white/[0.03] px-[24px] py-[16px]"
                >
                  <div className="text-[26px] font-bold text-white/85">
                    {g.firstName} {g.lastName ?? ""}
                  </div>
                  <div className="text-[20px] text-white/45">
                    {wards.length > 0
                      ? `Signed for ${wards.join(", ")}`
                      : g.waiverValid
                        ? "Waiver on file"
                        : "Needs own waiver"}
                  </div>
                  <div className="mt-[10px] flex items-center gap-[24px]">
                    <button
                      type="button"
                      onClick={() => joinGuardian(g)}
                      className="text-[22px] font-bold text-[#00e2e5]"
                    >
                      Join the fun
                    </button>
                    <button
                      type="button"
                      onClick={() => removeGuardianEntry(g.id)}
                      aria-label={`Remove ${g.firstName}`}
                      className="text-[20px] text-white/40"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* add / sign-in entry points */}
      {form === null && !lookupOpen && (
        <>
          <div className="grid grid-cols-2 gap-[16px]">
            <button
              type="button"
              onClick={() =>
                guardAdd(() => {
                  resetForm();
                  setForm({ mode: "new" });
                })
              }
              className="k-tap rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[28px] text-[28px] font-bold text-[#00e2e5]"
            >
              + Add a new player
            </button>
            <button
              type="button"
              onClick={() => guardAdd(() => setLookupOpen(true))}
              className="k-tap rounded-[28px] border-2 border-[#00e2e5]/45 bg-[#00e2e5]/10 px-[24px] py-[28px] text-[28px] font-bold text-white"
            >
              Sign in — find my people
            </button>
          </div>

          {/* Faster ways to sign in — phone QR + driver's-license + FastTrax
              license, side by side. The phone box hides while the join flag is
              off (snapshot stays idle) and the scan boxes show only while the
              COM scanner is listening; once someone's on the roster the trio
              folds into a slim bar. The session + poll keep running while a
              form/lookup overlay is open (the hook above stays mounted). */}
          <KioskSignInBoxes
            phone={mobileJoin}
            scanListening={licenseScan.listening}
            collapsed={party.length > 0}
          />
        </>
      )}

      {/* Linked family — OPT-IN suggestions (tap to add), never auto-added */}
      {linked.length > 0 && form === null && !lookupOpen && (
        <div>
          <div className="k-eyebrow mb-[12px] text-white/40">On this account — tap to add</div>
          <div className="flex flex-wrap gap-[12px]">
            {linked.map((lp) => {
              // Racing hard floor (7+): a linked kid under 7 can't be added to
              // a race party — show why instead of a dead tap.
              const tooYoung = isRace && lp.age !== null && lp.age < 7;
              return (
                <button
                  key={lp.id}
                  type="button"
                  onClick={tooYoung ? undefined : () => guardAdd(() => addLinked(lp))}
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
                    {lp.age !== null ? `Age ${lp.age}` : "Family"}
                    {tooYoung
                      ? " · under 7 — too young to race"
                      : lp.waiverValid
                        ? " · waiver on file"
                        : " · needs waiver"}
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
            {form.mode === "new" ? (
              "New player"
            ) : (
              <>
                Set up <span style={{ textTransform: "none" }}>{form.member.firstName}</span>
              </>
            )}
          </div>
          {form.mode === "new" && (
            <div className="grid grid-cols-2 gap-[16px]">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
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
            placeholder="Birthday MM/DD/YYYY"
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
                placeholder="Mobile phone"
                className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
              <input
                type="email"
                inputMode="email"
                data-osk-layout="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={isMainDefault ? "Email (for your confirmation)" : "Email (optional)"}
                className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
            </>
          )}
          {/* Scanner shortcut inside the form too. */}
          {licenseScan.listening && form.mode === "new" && (
            <p className="text-[20px] text-white/35">
              Tip: scan a driver&rsquo;s license / state ID to fill this in.
            </p>
          )}
          {/* Minor heads-up — the guardian is resolved AFTER onboarding, and
              only if the waiver actually needs signing. */}
          {ageFromDob(dob) !== null && (ageFromDob(dob) as number) < 18 && (
            <div className="rounded-2xl border border-white/12 bg-white/5 px-[20px] py-[16px] text-[22px] text-white/55">
              Under 18 — if their waiver needs signing, a parent or guardian signs it next. The
              adult doesn&apos;t have to play.
            </div>
          )}
          {formError && <p className="text-[24px] text-red-300">{formError}</p>}
          <div className="flex gap-[16px]">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                form.mode === "new" ? void submitNew() : void submitSetup(form.member)
              }
              className="k-btn-primary k-tap h-[80px] flex-1 text-[28px]"
            >
              {busy ? "Setting up…" : "Continue to waiver"}
            </button>
          </div>
        </div>
      )}

      {/* returning lookup */}
      {lookupOpen && (
        <div className="k-glass p-[28px]">
          <div className="mb-[16px] flex items-center justify-between">
            <div className="k-display text-[32px]">Sign in</div>
            <button
              type="button"
              onClick={() => setLookupOpen(false)}
              className="text-[24px] font-semibold text-white/50"
            >
              Close
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

      {/* Guardian resolution overlay — a minor's waiver needs signing and an
          adult must do it. Hidden while a waiver overlay is up (the two chain:
          own waiver → minor waiver); cancelling a waiver mid-chain lands back
          here with the flow intact, so resuming is one tap. */}
      {guardianFlow &&
        !waiverFor &&
        (() => {
          const minor = party.find((m) => m.id === guardianFlow.minorMemberId);
          // Prior guardians first (most likely signer for a second minor), then
          // party adults. The minor themselves can never appear (adults only).
          const candidates = [...guardians, ...adults];
          return (
            <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-[48px]">
              <div className="mx-auto max-w-[900px] space-y-[28px]">
                <div>
                  <div className="k-eyebrow text-[#00e2e5]">Parent / guardian needed</div>
                  <h2 className="k-display mt-[8px] text-[44px]">
                    {guardianFlow.stage !== "choose"
                      ? `A parent or guardian signs for ${minor?.firstName ?? "this minor"}`
                      : candidates.length > 0
                        ? `Select a guardian for ${minor?.firstName ?? "this minor"} — or add one below`
                        : `Add a guardian for ${minor?.firstName ?? "this minor"}`}
                  </h2>
                  <p className="mt-[10px] text-[24px] text-white/55">
                    {minor?.firstName ?? "They"} is under 18, so an adult signs the waiver. The
                    adult doesn&apos;t have to play — they won&apos;t be added to the purchase.
                  </p>
                </div>

                {guardianFlow.stage === "choose" && (
                  <>
                    {candidates.length > 0 && (
                      <div>
                        <div className="k-eyebrow mb-[12px] text-[#00e2e5]">
                          Tap a name to select
                        </div>
                        <div className="flex flex-wrap gap-[12px]">
                          {candidates.map((a) => {
                            const reachable =
                              !!shortPandoraId(a) || !!a.phone?.trim() || !!a.email?.trim();
                            const choosing = choosingGuardianId === a.id;
                            return (
                              <button
                                key={a.id}
                                type="button"
                                disabled={!reachable || busy}
                                onClick={() => void chooseGuardian(a)}
                                aria-pressed={choosing}
                                className={`k-tap rounded-2xl border-2 px-[24px] py-[16px] text-left ${
                                  choosing
                                    ? "border-[#00e2e5] bg-[#00e2e5]/15"
                                    : busy && reachable
                                      ? "border-[#00e2e5]/25 bg-[#00e2e5]/5 opacity-40"
                                      : reachable
                                        ? "border-[#00e2e5]/45 bg-[#00e2e5]/5"
                                        : "border-white/10 bg-white/[0.03] opacity-50"
                                }`}
                              >
                                <div className="text-[26px] font-bold text-white">
                                  {a.firstName} {a.lastName ?? ""}
                                </div>
                                {choosing ? (
                                  <div className="flex items-center gap-[10px] text-[20px] font-semibold text-[#00e2e5]">
                                    <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
                                    Checking their waiver…
                                  </div>
                                ) : (
                                  <div
                                    className={`text-[20px] ${reachable ? "text-[#00e2e5]/80" : "text-white/50"}`}
                                  >
                                    {!reachable
                                      ? "Can't verify here — use Find their account"
                                      : a.waiverValid
                                        ? "Waiver on file — tap to sign"
                                        : "Tap to sign — their own waiver first"}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-[16px]">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setGError(null);
                          setGuardianFlow({ ...guardianFlow, stage: "new-form" });
                        }}
                        className="k-tap rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[28px] text-[28px] font-bold text-[#00e2e5]"
                      >
                        + Add a new guardian
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setGError(null);
                          setGuardianFlow({ ...guardianFlow, stage: "lookup" });
                        }}
                        className="k-tap rounded-[28px] border-2 border-[#00e2e5]/45 bg-[#00e2e5]/10 px-[24px] py-[28px] text-[28px] font-bold text-white"
                      >
                        Find their account
                      </button>
                    </div>
                  </>
                )}

                {guardianFlow.stage === "new-form" && (
                  <div className="k-glass space-y-[20px] p-[28px]">
                    <div className="k-display text-[32px]">New adult — guardian</div>
                    <div className="grid grid-cols-2 gap-[16px]">
                      <input
                        type="text"
                        value={gFirst}
                        onChange={(e) => setGFirst(e.target.value)}
                        placeholder="First name"
                        className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                      />
                      <input
                        type="text"
                        value={gLast}
                        onChange={(e) => setGLast(e.target.value)}
                        placeholder="Last name"
                        className="rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                      />
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      data-osk-layout="numeric"
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
                      placeholder="Birthday MM/DD/YYYY"
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    <input
                      type="tel"
                      inputMode="tel"
                      data-osk-layout="phone"
                      value={gPhone}
                      onChange={(e) => setGPhone(e.target.value)}
                      placeholder="Mobile phone"
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    <input
                      type="email"
                      inputMode="email"
                      data-osk-layout="email"
                      value={gEmail}
                      onChange={(e) => setGEmail(e.target.value)}
                      placeholder="Email (optional)"
                      className="w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[20px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                    />
                    {gError && <p className="text-[24px] text-red-300">{gError}</p>}
                    <div className="flex gap-[16px]">
                      <button
                        type="button"
                        onClick={() => {
                          setGError(null);
                          setGuardianFlow({ ...guardianFlow, stage: "choose" });
                        }}
                        className="rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void submitGuardianNew()}
                        className="k-btn-primary k-tap h-[80px] flex-1 text-[28px]"
                      >
                        {busy ? "Setting up…" : "Continue to waiver"}
                      </button>
                    </div>
                  </div>
                )}

                {guardianFlow.stage === "lookup" && (
                  <div className="k-glass p-[28px]">
                    <div className="mb-[16px] flex items-center justify-between">
                      <div className="k-display text-[32px]">Find the guardian</div>
                      <button
                        type="button"
                        onClick={() => {
                          setGError(null);
                          setGuardianFlow({ ...guardianFlow, stage: "choose" });
                        }}
                        className="text-[24px] font-semibold text-white/50"
                      >
                        Back
                      </button>
                    </div>
                    <ReturningRacerLookup
                      onVerified={(p) => void handleGuardianVerified(p)}
                      onSwitchToNew={() => {
                        setGError(null);
                        setGuardianFlow({ ...guardianFlow, stage: "new-form" });
                      }}
                    />
                    {gError && <p className="mt-[16px] text-[24px] text-red-300">{gError}</p>}
                  </div>
                )}

                {guardianFlow.stage === "choose" && gError && (
                  <p className="text-[24px] text-red-300">{gError}</p>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setGuardianFlow(null);
                    setGError(null);
                    resetGuardianForm();
                  }}
                  className="w-full rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
                >
                  ← Back
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
          // The person whose waiver this IS (party member or signer-only
          // guardian) — drives the photo capture + minor/adult semantics. When
          // a guardian signs a MINOR's waiver, this is the minor; the guardian
          // rides along as signerPersonId/signerName.
          const signer = findPerson(waiverFor.memberId);
          const needPhoto = kioskHasCamera(kioskCfg) && photoDoneFor !== waiverFor.memberId;
          return (
            <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-[48px]">
              {needPhoto ? (
                <KioskWaiverPhoto
                  memberName={signer?.firstName ?? "Guest"}
                  isMinor={!!signer?.isMinor}
                  onCaptured={(pngBase64) => {
                    // Fire-and-forget: the route persists to Neon FIRST and the
                    // sweep retries Pandora — never hold the waiver on network.
                    void fetch("/api/pandora/person-picture", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        personId: waiverFor.personId,
                        location: brandLocation,
                        pngBase64,
                      }),
                    }).catch(() => {});
                    setPhotoDoneFor(waiverFor.memberId);
                  }}
                  onSkip={() => setPhotoDoneFor(waiverFor.memberId)}
                />
              ) : (
                // Center the signature UI vertically in the overlay — min-h-full
                // centers it when it fits and lets the overlay scroll if it's
                // ever taller (owner 2026-07-21: signature sat too high).
                <div className="mx-auto flex min-h-full max-w-[900px] flex-col justify-center">
                  <WaiverSigning
                    personId={waiverFor.personId}
                    template={waiverFor.template}
                    location={brandLocation}
                    signerPersonId={waiverFor.signerPersonId}
                    heading={isRace ? "Racing Waiver" : "Activity Waiver"}
                    subheading={
                      waiverFor.signerName
                        ? `${waiverFor.signerName} — sign below for ${signer?.firstName ?? "the minor"}. It stays on file for the whole visit.`
                        : "Read and sign below — it stays on file for your whole visit."
                    }
                    onComplete={() => {
                      const gf = guardianFlow;
                      // Guardian just signed their OWN waiver → mark it and
                      // chain straight to the minor's waiver (guardian signs).
                      if (gf && gf.guardianId && waiverFor.memberId === gf.guardianId) {
                        patchPerson(gf.guardianId, { waiverValid: true });
                        setWaiverFor({
                          memberId: gf.minorMemberId,
                          personId: gf.minorPersonId,
                          template: gf.minorTemplate,
                          // Their own waiver was signed against their short id.
                          signerPersonId: waiverFor.personId,
                          signerName: findPerson(gf.guardianId)?.firstName ?? "Guardian",
                        });
                        return;
                      }
                      const minorSigned = gf && waiverFor.memberId === gf.minorMemberId;
                      dispatch({
                        type: "updatePartyMember",
                        id: waiverFor.memberId,
                        patch: {
                          waiverValid: true,
                          ...(minorSigned && gf.guardianId
                            ? { guardianMemberId: gf.guardianId }
                            : {}),
                        },
                      });
                      if (minorSigned) {
                        // Best-effort BMI guardian link on the minor's person.
                        if (waiverFor.signerPersonId) {
                          linkMinorToGuardian(gf.minorMemberId, waiverFor.signerPersonId);
                        }
                        // Receipt goes to the guardian when the Main person is
                        // a minor (owner 2026-07-18) — contact is separate from
                        // the party, so this never adds them to the purchase.
                        const mainMember = party.find((m) => m.isBillingCustomer);
                        const g = gf.guardianId ? findPerson(gf.guardianId) : undefined;
                        if (mainMember?.isMinor && g) setContactFrom(g);
                        setGuardianFlow(null);
                      }
                      setWaiverFor(null);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })()}
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
              guardAdd(() => {
                resetForm();
                setForm({ mode: "new" });
              });
            }
          }}
          onCancel={() => setLicenseMatches(null)}
        />
      )}
      {splitWarn && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-[48px] backdrop-blur-sm">
          <div className="k-glass w-full max-w-[860px] space-y-[24px] p-[44px]">
            <div className="k-eyebrow text-[#f0b341]">Before you add more players</div>
            <div className="k-display text-[46px] leading-[1.05]">One payment covers everyone</div>
            <p className="text-[26px] leading-snug text-white/60">
              Payments can&rsquo;t be split at this kiosk — your whole group checks out together. To
              split payments, split your party between multiple kiosks.
            </p>
            <div className="flex flex-col gap-[16px] pt-[4px]">
              {/* Inline flex per the .kiosk-canvas cascade gotcha (see the
                  KioskFlow confirm sheet): k-btn-primary's flex:1 squashes its
                  height in a column layout. */}
              <button
                type="button"
                onClick={() => {
                  const go = splitWarn;
                  setSplitWarn(null);
                  go();
                }}
                className="k-btn-primary k-tap"
                style={{ flex: "0 0 auto" }}
              >
                Continue adding players
              </button>
              <button
                type="button"
                onClick={() => setSplitWarn(null)}
                className="k-tap rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
              >
                Never mind
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** canAdvance shared logic: at least one participant, everyone set up +
 *  waivered. `ids` = the participating member ids. A minor with a VALID waiver
 *  needs no guardian at all (owner 2026-07-18); one who needed signing was
 *  structurally signed BY a guardian (the guardian flow is the only path to a
 *  minor signature), so no separate guardian gate is needed here. Signer-only
 *  guardians live in session.guardians — never in `party`, never counted. */
function peopleReady(party: PartyMember[], ids: string[]): true | { reason: string } {
  if (ids.length === 0 || party.length === 0) {
    return { reason: "Add at least one player — everyone needs an account and waiver." };
  }
  const participating = party.filter((m) => ids.includes(m.id));
  const missing = participating.find((m) => needsSetup(m));
  if (missing) {
    return {
      reason: `${missing.firstName} still needs ${missing.bmiPersonId ? "a signed waiver" : "an account + waiver"} — tap ${missing.bmiPersonId ? "Sign waiver" : "Set up"}.`,
    };
  }
  return true;
}

/** Racing: the whole party races. id "race-party" preserved so KioskFlow's
 *  height-confirm intercept still fires. */
export const KioskRacePeopleStep: StepDef<RaceItem> = {
  id: "race-party",
  title: "Who's racing?",
  Component: PeopleStepComponent as StepDef<RaceItem>["Component"],
  isVisible: () => true,
  canAdvance: (_item, session) => {
    const base = peopleReady(
      session.party,
      session.party.map((m) => m.id),
    );
    if (base !== true) return base;
    // Combo minimum headcount (e.g. the Ultimate VIP is 2+ guests) — was not
    // enforced, so a 1-person combo could advance (owner bug).
    const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;
    if (combo) {
      const min = comboMinHeadcount(combo);
      if (session.party.length < min) {
        return {
          reason: `The ${combo.name} is for ${min}+ guests — add ${min - session.party.length} more.`,
        };
      }
    }
    return true;
  },
};

/** Waiver-gated attractions (gel/laser/shuf): toggle who's in this one. */
export const KioskAttractionPeopleStep: StepDef<AttractionItem> = {
  id: "kiosk-who",
  title: "Who's playing?",
  Component: PeopleStepComponent as StepDef<AttractionItem>["Component"],
  isVisible: (item) => WAIVER_SLUGS.has(item.slug ?? ""),
  canAdvance: (item, session) => {
    if (!WAIVER_SLUGS.has(item.slug ?? "")) return true;
    const ids = item.participants ?? session.party.map((m) => m.id);
    return peopleReady(session.party, ids);
  },
};
