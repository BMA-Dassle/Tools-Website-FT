"use client";

/**
 * Kiosk race party step — the web RacePartyStep REUSED WHOLESALE (returning
 * lookup + linked family, party counters, membership tiers), plus the kiosk
 * account gate underneath (owner rule 2026-07-17): NEW racers must have a
 * REAL racer account + signed waiver before the party step advances — the
 * healthnet machinery (pandoraOnboardGuest → Pandora person + waiver check
 * → age-appropriate template → WaiverSigning touch signature).
 *
 * Returning racers verified through the lookup already carry bmiPersonId +
 * their stored waiverValid, so they pass the gate untouched (Express Lane
 * parity). Web behavior is unchanged — this step exists only in the kiosk
 * registry.
 */
import { useState } from "react";
import type { PartyMember, RaceItem, StepDef } from "~/features/booking";
import { RacePartyStep } from "~/components/features/booking/steps/race/RacePartyStep";
import WaiverSigning from "@/components/pandora/WaiverSigning";
import type { PandoraWaiverTemplate } from "@/lib/pandora";
import { pandoraOnboardGuest } from "@/lib/pandora";

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

/** A member passes the kiosk gate with a Pandora person + valid waiver. */
function needsAccount(m: PartyMember): boolean {
  return !m.bmiPersonId || !m.waiverValid;
}

const KioskRacePartyStepComponent: StepDef<RaceItem>["Component"] = (props) => {
  const { session, dispatch, setBusy } = props;
  const brandLocation = session.entryBrand === "headpinz" ? "headpinz" : "fasttrax";

  const [dobPromptFor, setDobPromptFor] = useState<PartyMember | null>(null);
  const [dob, setDob] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [waiverFor, setWaiverFor] = useState<{
    memberId: string;
    personId: string;
    template: PandoraWaiverTemplate;
  } | null>(null);

  const pending = session.party.filter(needsAccount);

  const onboardMember = async (member: PartyMember, dobMmDdYyyy: string) => {
    const age = ageFromDob(dobMmDdYyyy);
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
          firstName: member.firstName,
          lastName: member.lastName ?? "",
          email: session.contact.email ?? "",
          phone: session.contact.phone ?? "",
          birthdate: toIsoDob(dobMmDdYyyy),
        },
        brandLocation,
      );
      dispatch({
        type: "updatePartyMember",
        id: member.id,
        patch: { bmiPersonId: result.personId, waiverValid: result.waiverValid },
      });
      setDobPromptFor(null);
      setDob("");
      if (!result.waiverValid && result.template) {
        setWaiverFor({ memberId: member.id, personId: result.personId, template: result.template });
      }
    } catch (err) {
      setFormError(
        err instanceof Error
          ? `Couldn't set up that racer: ${err.message}`
          : "Couldn't set up that racer. Please try again or see the front desk.",
      );
    } finally {
      setOnboarding(false);
      setBusy?.(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* The full web party step: new/returning modes, lookup + linked family */}
      <RacePartyStep.Component {...props} />

      {/* Kiosk account gate — every racer needs an account + waiver here */}
      {pending.length > 0 && (
        <div className="space-y-3 rounded-2xl border border-amber-500/35 bg-amber-500/5 p-5">
          <div className="font-heading text-lg font-extrabold italic text-amber-200">
            Racer accounts &amp; waivers — set up right here
          </div>
          <p className="text-sm text-white/55">
            On the kiosk every racer gets their account and waiver now, so check-in is the Express
            Lane, not a line.
          </p>
          {pending.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-heading truncate text-lg font-extrabold italic">
                  {m.firstName} {m.lastName ?? ""}
                  {m.category === "junior" && (
                    <span className="ml-2 text-sm font-bold not-italic text-[#46d68c]">junior</span>
                  )}
                </div>
                <div className="text-xs uppercase tracking-widest text-amber-300/80">
                  {m.bmiPersonId ? "Waiver needed" : "Account + waiver needed"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDob("");
                  setFormError(null);
                  setDobPromptFor(m);
                }}
                className="shrink-0 rounded-xl border-2 border-amber-500/50 px-4 py-2 text-sm font-bold text-amber-200"
              >
                Set up
              </button>
            </div>
          ))}
        </div>
      )}

      {/* One-time DOB prompt (drives the age-appropriate waiver template) */}
      {dobPromptFor && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-[#000418]/95 p-6 backdrop-blur">
          <div className="w-full max-w-lg space-y-4 rounded-3xl border border-white/10 bg-[#0d1a36] p-8">
            <div className="font-heading text-2xl font-extrabold italic">
              {dobPromptFor.firstName}&rsquo;s birthday
            </div>
            <p className="text-sm text-white/55">
              Goes on the racer license — and picks the right waiver.
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
                }}
                className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={onboarding}
                onClick={() => void onboardMember(dobPromptFor, dob)}
                className="flex-1 rounded-xl bg-[#00E2E5] px-5 py-3 text-sm font-bold text-[#04252b] disabled:opacity-40"
              >
                {onboarding ? "Setting up…" : "Continue to waiver"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The REAL waiver sheet — Pandora template + touch signature */}
      {waiverFor && (
        <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-6">
          <div className="mx-auto max-w-2xl">
            <WaiverSigning
              personId={waiverFor.personId}
              template={waiverFor.template}
              location={brandLocation}
              heading="Racing Waiver"
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
              Cancel — sign later
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const KioskRacePartyStep: StepDef<RaceItem> = {
  id: "race-party", // web id preserved: KioskFlow's height-confirm intercept keys on it
  title: "Party",
  Component: KioskRacePartyStepComponent,
  isVisible: RacePartyStep.isVisible,
  canAdvance: (item, session) => {
    // Web rules first (party size, combo minimums)…
    const base = RacePartyStep.canAdvance(item, session);
    if (base !== true) return base;
    // …then the kiosk gate: every racer has an account + signed waiver.
    const missing = session.party.find(needsAccount);
    if (missing) {
      return {
        reason: `${missing.firstName} still needs ${missing.bmiPersonId ? "a signed waiver" : "an account + waiver"} — tap Set up below.`,
      };
    }
    return true;
  },
};
