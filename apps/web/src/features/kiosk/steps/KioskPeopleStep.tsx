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
 *   - a MINOR (age < 18) needs a registered ADULT guardian picked from the
 *     roster; the guardian's person id rides Pandora onboarding.
 */
import { useState } from "react";
import type { AttractionItem, PartyMember, RaceItem, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import { tierFromMemberships } from "~/features/booking/service/race-products";
import { getComboSpecial, comboMinHeadcount } from "~/features/combos/combo-specials";
import WaiverSigning from "@/components/pandora/WaiverSigning";
import {
  pandoraOnboardGuest,
  pandoraFetchWaiverTemplate,
  type PandoraWaiverTemplate,
} from "@/lib/pandora";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";

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
  const brandLocation = session.entryBrand === "headpinz" ? "headpinz" : "fasttrax";
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
  const [guardianId, setGuardianId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusyLocal] = useState(false);
  const [waiverFor, setWaiverFor] = useState<{
    memberId: string;
    personId: string;
    template: PandoraWaiverTemplate;
  } | null>(null);
  // Linked family are OPT-IN suggestions — tap to add, never auto-pulled in.
  const [linked, setLinked] = useState<LinkedSuggestion[]>([]);

  const adults = party.filter((m) => !m.isMinor);
  const setBusyAll = (b: boolean) => {
    setBusyLocal(b);
    setBusy?.(b);
  };

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
    // Also drop this person as anyone's guardian, and from the attraction set.
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
    const minor = age < 18;
    if (minor && adults.length === 0) {
      setFormError("Add an adult to the group first — a minor needs a guardian.");
      return;
    }
    if (minor && !guardianId) {
      setFormError("Pick this minor's guardian.");
      return;
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
          email: email.trim() || session.contact.email || "",
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
      dispatch({ type: "addPartyMember", member });
      if (isMain) setContactFrom(member); // main person → booking contact
      if (!isRace) setIncluded(new Set([...included, member.id]));
      resetForm();
      if (!result.waiverValid && result.template) {
        setWaiverFor({ memberId: member.id, personId: result.personId, template: result.template });
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
    const minor = age < 18;
    const gid = member.guardianMemberId || guardianId;
    if (minor && adults.filter((a) => a.id !== member.id).length === 0) {
      setFormError("Add an adult to the group first — a minor needs a guardian.");
      return;
    }
    if (minor && !gid) {
      setFormError("Pick this minor's guardian.");
      return;
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
            email: session.contact.email ?? "",
            phone: session.contact.phone ?? "",
            birthdate: toIsoDob(dob),
            guardianID: guardianPersonId,
          },
          brandLocation,
        );
        dispatch({
          type: "updatePartyMember",
          id: member.id,
          patch: {
            bmiPersonId: result.personId,
            waiverValid: result.waiverValid,
            isMinor: minor,
            category: age < 13 ? "junior" : "adult",
            guardianMemberId: minor ? gid : undefined,
          },
        });
        resetForm();
        if (!result.waiverValid && result.template) {
          setWaiverFor({
            memberId: member.id,
            personId: result.personId,
            template: result.template,
          });
        }
      } else {
        // Account exists — just capture the waiver (no duplicate Pandora person).
        const template = await pandoraFetchWaiverTemplate(age, brandLocation);
        dispatch({
          type: "updatePartyMember",
          id: member.id,
          patch: {
            isMinor: minor,
            category: age < 13 ? "junior" : "adult",
            guardianMemberId: minor ? gid : undefined,
          },
        });
        resetForm();
        setWaiverFor({ memberId: member.id, personId: member.bmiPersonId, template });
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

  /** Fetch the verified account's LINKED family as OPT-IN suggestions — they are
   *  NOT added to the party (racing races the whole party, so auto-adding pulled
   *  everyone into the race — owner bug). The guest taps a suggestion to add. */
  const importLinked = async (personId: string, alreadyIds: Set<string>) => {
    try {
      const res = await fetch(`/api/pandora?personId=${personId}&picture=false`);
      if (!res.ok) return;
      const data = await res.json();
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
    }
  };

  /** Add a linked-family suggestion to the party (opt-in tap). */
  const addLinked = (lp: LinkedSuggestion) => {
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

  const handleVerified = (person: PersonData) => {
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const isMain = party.length === 0;
    const member = newPartyMember({
      firstName: first || person.fullName,
      lastName: rest.join(" ") || undefined,
      isNewRacer: false,
      category: "adult",
      bmiPersonId: person.personId,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
      creditBalances: person.creditBalances,
      isBillingCustomer: isMain,
      phone: person.phone || undefined,
      email: person.email || undefined,
    });
    dispatch({ type: "addPartyMember", member });
    if (!isRace) setIncluded(new Set([...included, member.id]));
    if (isMain) setContactFrom(member); // main person → booking contact
    setLookupOpen(false);
    const alreadyIds = new Set(
      [person.personId, ...party.map((m) => m.bmiPersonId)].filter(Boolean) as string[],
    );
    void importLinked(person.personId, alreadyIds);
  };

  const openSetup = (member: PartyMember) => {
    setForm({ mode: "setup", member });
    setDob("");
    setGuardianId(member.guardianMemberId ?? "");
    setFormError(null);
  };

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

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">
        {party.length > 0
          ? "Your group is signed in — everyone here needs an account and a signed waiver."
          : "Add everyone playing. Each person gets an account and signs the waiver right here — so check-in is the Express Lane, not a line."}
      </p>

      {/* roster */}
      <div className="space-y-[16px]">
        {party.map((m) => {
          const isIn = included.has(m.id);
          const badge = badgeFor(m);
          const guardian = m.guardianMemberId
            ? party.find((g) => g.id === m.guardianMemberId)
            : null;
          const ready = !needsSetup(m);
          return (
            <div
              key={m.id}
              className={`k-glass relative overflow-hidden p-[24px] ${
                !isRace && !isIn ? "opacity-55" : ""
              }`}
              style={{
                borderLeft: `8px solid ${ready ? "#46d68c" : "#f0b341"}`,
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
                    <span className="k-display truncate text-[40px]">
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
                    ) : (
                      <span className="font-semibold text-[#f0b341]">
                        {m.bmiPersonId ? "Waiver needed" : "Account + waiver needed"}
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
                  {!ready && (
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
            + Add a new player
          </button>
          <button
            type="button"
            onClick={() => setLookupOpen(true)}
            className="k-tap rounded-[28px] border-2 border-[#00e2e5]/45 bg-[#00e2e5]/10 px-[24px] py-[28px] text-[28px] font-bold text-white"
          >
            Sign in — find my people
          </button>
        </div>
      )}

      {/* Linked family — OPT-IN suggestions (tap to add), never auto-added */}
      {linked.length > 0 && form === null && !lookupOpen && (
        <div>
          <div className="k-eyebrow mb-[12px] text-white/40">On this account — tap to add</div>
          <div className="flex flex-wrap gap-[12px]">
            {linked.map((lp) => (
              <button
                key={lp.id}
                type="button"
                onClick={() => addLinked(lp)}
                className="k-tap rounded-2xl border-2 border-[#46d68c]/40 bg-[#46d68c]/5 px-[24px] py-[16px] text-left"
              >
                <div className="text-[26px] font-bold text-white">
                  + {lp.firstName} {lp.lastName}
                </div>
                <div className="text-[20px] text-white/50">
                  {lp.age !== null ? `Age ${lp.age}` : "Family"}
                  {lp.waiverValid ? " · waiver on file" : " · needs waiver"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* person form (new OR setup) */}
      {form !== null && (
        <div className="k-glass space-y-[20px] p-[28px]">
          <div className="k-display text-[32px]">
            {form.mode === "new" ? "New player" : `Set up ${form.member.firstName}`}
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
          {/* Guardian picker appears once we know they're a minor */}
          {ageFromDob(dob) !== null && (ageFromDob(dob) as number) < 18 && (
            <div>
              <div className="mb-[10px] text-[22px] text-white/55">
                Responsible guardian (a registered adult):
              </div>
              {adults.filter((a) => form.mode !== "setup" || a.id !== form.member.id).length ===
              0 ? (
                <div className="rounded-2xl border border-[#f0b341]/40 bg-[#f0b341]/10 px-[20px] py-[16px] text-[22px] text-[#f0b341]">
                  Add an adult to the group first — a minor needs a guardian.
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
            onVerified={handleVerified}
            onSwitchToNew={() => {
              setLookupOpen(false);
              resetForm();
              setForm({ mode: "new" });
            }}
          />
        </div>
      )}

      {/* the REAL waiver: Pandora template + touch signature → signWaiverDigital */}
      {waiverFor && (
        <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-[48px]">
          <div className="mx-auto max-w-[900px]">
            <WaiverSigning
              personId={waiverFor.personId}
              template={waiverFor.template}
              location={brandLocation}
              heading={isRace ? "Racing Waiver" : "Activity Waiver"}
              subheading="Read and sign below — it stays on file for your whole visit."
              onComplete={() => {
                dispatch({
                  type: "updatePartyMember",
                  id: waiverFor.memberId,
                  patch: { waiverValid: true },
                });
                setWaiverFor(null);
              }}
            />
            <button
              type="button"
              onClick={() => setWaiverFor(null)}
              className="mt-[24px] w-full rounded-2xl border border-white/15 px-[28px] py-[18px] text-[24px] font-semibold text-white/60"
            >
              Cancel — sign later
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** canAdvance shared logic: at least one participant, everyone set up + waivered,
 *  every minor has a guardian. `ids` = the participating member ids. */
function peopleReady(party: PartyMember[], ids: string[]): true | { reason: string } {
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
