"use client";

/**
 * Kiosk "Who's playing?" — the session party + waiver gate for
 * waiver-required attractions (gel blaster, laser tag, shuffleboard —
 * everything except bowling & duckpin, owner rule 2026-07-17).
 *
 * The roster IS session.party — the same members racing registers — so a
 * group that raced first sees everyone already signed in with waivers on
 * file, and a later activity is one toggle per person. Three entry paths:
 *   - toggle an existing member in/out of THIS attraction,
 *   - "Add a new player" → real Pandora onboarding (pandoraOnboardGuest,
 *     same machinery as the healthnet event flow) + the REAL WaiverSigning
 *     touch-signature sheet when their waiver isn't on file,
 *   - "Sign in — find my people" → the proven ReturningRacerLookup
 *     (phone/email + SMS code), adding the verified account with its
 *     stored waiver status.
 *
 * canAdvance enforces the owner rule: at least one participant, and every
 * participant has a signed waiver. item.qty tracks the selection.
 */
import { useState } from "react";
import type { AttractionItem, PartyMember, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import WaiverSigning from "@/components/pandora/WaiverSigning";
import type { PandoraWaiverTemplate } from "@/lib/pandora";
import { pandoraOnboardGuest } from "@/lib/pandora";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";

/** Waiver-gated attraction slugs (duckpin is exempt). */
const WAIVER_SLUGS = new Set(["gel-blaster", "laser-tag", "shuffly"]);

function participantsOf(item: AttractionItem, party: PartyMember[]): string[] {
  // Default: everyone currently in the session party is in, until toggled.
  return item.participants ?? party.map((m) => m.id);
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

const KioskWhoStepComponent: StepDef<AttractionItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const party = session.party;
  const included = new Set(participantsOf(item, party));
  const brandLocation = session.entryBrand === "headpinz" ? "headpinz" : "fasttrax";

  const [adding, setAdding] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [waiverFor, setWaiverFor] = useState<{
    memberId: string;
    personId: string;
    template: PandoraWaiverTemplate;
  } | null>(null);
  /** Member id → DOB prompt (racing new-racers have no Pandora person yet). */
  const [dobPromptFor, setDobPromptFor] = useState<PartyMember | null>(null);

  const setIncluded = (ids: Set<string>) => {
    onChange({ participants: Array.from(ids), qty: Math.max(ids.size, 1) });
  };

  const toggle = (id: string) => {
    const next = new Set(included);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setIncluded(next);
  };

  /** Create the Pandora person (real onboarding) then open the waiver sheet. */
  const onboardAndSign = async (args: {
    memberId: string | null;
    firstName: string;
    lastName: string;
    dobMmDdYyyy: string;
  }) => {
    const age = ageFromDob(args.dobMmDdYyyy);
    if (age === null) {
      setFormError("Enter the birthday as MM/DD/YYYY.");
      return;
    }
    setOnboarding(true);
    setFormError(null);
    setBusy?.(true);
    try {
      const result = await pandoraOnboardGuest(
        {
          firstName: args.firstName.trim(),
          lastName: args.lastName.trim(),
          email: session.contact.email ?? "",
          phone: session.contact.phone ?? "",
          birthdate: toIsoDob(args.dobMmDdYyyy),
        },
        brandLocation,
      );
      let memberId = args.memberId;
      if (memberId) {
        dispatch({
          type: "updatePartyMember",
          id: memberId,
          patch: { bmiPersonId: result.personId, waiverValid: result.waiverValid },
        });
      } else {
        const member = newPartyMember({
          firstName: args.firstName.trim(),
          lastName: args.lastName.trim(),
          isNewRacer: true,
          category: age < 16 ? "junior" : "adult",
          bmiPersonId: result.personId,
          waiverValid: result.waiverValid,
        });
        dispatch({ type: "addPartyMember", member });
        memberId = member.id;
        setIncluded(new Set([...included, member.id]));
      }
      setAdding(false);
      setDobPromptFor(null);
      setFirstName("");
      setLastName("");
      setDob("");
      if (!result.waiverValid && result.template) {
        setWaiverFor({ memberId, personId: result.personId, template: result.template });
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? `Couldn't set that player up: ${err.message}`
          : "Couldn't set that player up. Please try again or see the front desk.",
      );
    } finally {
      setOnboarding(false);
      setBusy?.(false);
    }
  };

  const handleVerified = (person: PersonData) => {
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const member = newPartyMember({
      firstName: first || person.fullName,
      lastName: rest.join(" ") || undefined,
      isNewRacer: false,
      category: "adult",
      bmiPersonId: person.personId,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
    });
    dispatch({ type: "addPartyMember", member });
    setIncluded(new Set([...included, member.id]));
    setLookupOpen(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">
          Who&rsquo;s playing?
        </h3>
        <p className="mt-1 text-sm text-white/50">
          {party.length > 0
            ? "Your group is signed in — tap who's joining this one. Everyone playing needs a waiver on file."
            : "Everyone participating signs the activity waiver right here."}
        </p>
      </div>

      <div className="space-y-3">
        {party.map((m) => {
          const isIn = included.has(m.id);
          return (
            <div
              key={m.id}
              className={`flex items-center gap-4 rounded-2xl border bg-white/[0.03] px-5 py-4 ${
                isIn ? "border-[#00E2E5]/50" : "border-white/10"
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(m.id)}
                aria-pressed={isIn}
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 text-xl font-bold ${
                  isIn
                    ? "border-[#00E2E5] bg-[#00E2E5] text-[#04252b]"
                    : "border-white/20 text-transparent"
                }`}
              >
                ✓
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-heading truncate text-xl font-extrabold italic">
                  {m.firstName} {m.lastName ?? ""}
                  {m.category === "junior" && (
                    <span className="ml-2 text-sm font-bold not-italic text-[#46d68c]">junior</span>
                  )}
                </div>
              </div>
              {m.waiverValid ? (
                <span className="shrink-0 text-xs font-semibold uppercase tracking-widest text-[#46d68c]">
                  Waiver on file
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (m.bmiPersonId) {
                      // Person exists — fetch happens inside onboard flow only
                      // for NEW persons; existing persons need the template:
                      // route through the DOB-less quick path by prompting DOB
                      // (template is age-based).
                      setDobPromptFor(m);
                    } else {
                      setDobPromptFor(m);
                    }
                  }}
                  className="shrink-0 rounded-xl border-2 border-amber-500/50 px-4 py-2 text-sm font-bold text-amber-300"
                >
                  Sign waiver
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!adding && !lookupOpen && (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-2xl border-2 border-dashed border-[#00E2E5]/40 px-5 py-5 text-base font-bold text-[#00E2E5]"
          >
            + Add a new player
          </button>
          <button
            type="button"
            onClick={() => setLookupOpen(true)}
            className="rounded-2xl border-2 border-[#00E2E5]/45 bg-[#00E2E5]/10 px-5 py-5 text-base font-bold text-white"
          >
            Sign in — find my people
          </button>
        </div>
      )}

      {adding && (
        <div className="space-y-4 rounded-2xl border border-white/15 bg-white/[0.03] p-5">
          <div className="font-heading text-lg font-extrabold italic">New player</div>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
            />
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
            />
          </div>
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
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
          />
          {formError && <p className="text-sm text-red-300">{formError}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setFormError(null);
              }}
              className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={onboarding || !firstName.trim() || !lastName.trim()}
              onClick={() =>
                void onboardAndSign({ memberId: null, firstName, lastName, dobMmDdYyyy: dob })
              }
              className="flex-1 rounded-xl bg-[#00E2E5] px-5 py-3 text-sm font-bold text-[#04252b] disabled:opacity-40"
            >
              {onboarding ? "Setting up…" : "Add & sign waiver"}
            </button>
          </div>
        </div>
      )}

      {lookupOpen && (
        <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-heading text-lg font-extrabold italic">Sign in</div>
            <button
              type="button"
              onClick={() => setLookupOpen(false)}
              className="text-sm font-semibold text-white/50"
            >
              Close
            </button>
          </div>
          <ReturningRacerLookup
            onVerified={handleVerified}
            onSwitchToNew={() => {
              setLookupOpen(false);
              setAdding(true);
            }}
          />
        </div>
      )}

      {/* DOB prompt for an existing member who needs a waiver (racing
          new-racers have no Pandora person yet; the template is age-based). */}
      {dobPromptFor && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-[#000418]/95 p-6 backdrop-blur">
          <div className="w-full max-w-lg space-y-4 rounded-3xl border border-white/10 bg-[#0d1a36] p-8">
            <div className="font-heading text-2xl font-extrabold italic">
              {dobPromptFor.firstName}&rsquo;s birthday
            </div>
            <p className="text-sm text-white/55">
              We need it once to put the right waiver on file.
            </p>
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
              placeholder="MM/DD/YYYY"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
            />
            {formError && <p className="text-sm text-red-300">{formError}</p>}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setDobPromptFor(null);
                  setFormError(null);
                  setDob("");
                }}
                className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={onboarding}
                onClick={() =>
                  void onboardAndSign({
                    memberId: dobPromptFor.id,
                    firstName: dobPromptFor.firstName,
                    lastName: dobPromptFor.lastName ?? "",
                    dobMmDdYyyy: dob,
                  })
                }
                className="flex-1 rounded-xl bg-[#00E2E5] px-5 py-3 text-sm font-bold text-[#04252b] disabled:opacity-40"
              >
                {onboarding ? "Setting up…" : "Continue to waiver"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The REAL waiver: Pandora template + touch signature → signWaiverDigital */}
      {waiverFor && (
        <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-6">
          <div className="mx-auto max-w-2xl">
            <WaiverSigning
              personId={waiverFor.personId}
              template={waiverFor.template}
              location={brandLocation}
              heading="Activity Waiver"
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
              className="mt-4 w-full rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/60"
            >
              Cancel — remove this player
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const KioskWhoStep: StepDef<AttractionItem> = {
  id: "kiosk-who",
  title: "Players",
  Component: KioskWhoStepComponent,
  // Waiver-gated attractions only (duckpin exempt).
  isVisible: (item) => WAIVER_SLUGS.has(item.slug ?? ""),
  canAdvance: (item, session) => {
    if (!WAIVER_SLUGS.has(item.slug ?? "")) return true;
    const ids = item.participants ?? session.party.map((m) => m.id);
    if (ids.length === 0 || session.party.length === 0) {
      return { reason: "Add at least one player — everyone needs a waiver on file." };
    }
    const missing = session.party.filter((m) => ids.includes(m.id) && !m.waiverValid);
    if (missing.length > 0) {
      return { reason: `${missing[0].firstName} still needs to sign the waiver.` };
    }
    return true;
  },
};
