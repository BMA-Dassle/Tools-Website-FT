"use client";

import { useState } from "react";
import type { PartyMember, RaceItem, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";
import { tierFromMemberships } from "~/features/booking/service/race-products";
import { ExperiencePicker } from "./ExperiencePicker";
import { ReturningRacerLookup, type PersonData } from "./ReturningRacerLookup";

const TIER_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pro: { bg: "bg-[#E53935]/15", text: "text-[#E53935]", label: "Pro" },
  intermediate: { bg: "bg-[#8652FF]/15", text: "text-[#8652FF]", label: "Intermediate" },
  starter: { bg: "bg-[#00E2E5]/15", text: "text-[#00E2E5]", label: "Starter" },
};

interface LinkedPerson {
  id: string;
  firstName: string;
  lastName: string;
  birthdate: string | null;
  waiverValid?: boolean;
}

/** Whole years from a birthDate ISO string; null when unknown. Module-scope
 *  so the age math (used by every add-racer handler + the linked-racer card)
 *  lives in one place and isn't re-derived inline. */
function ageFromBirthDate(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  return Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

const RacePartyStepComponent: StepDef<RaceItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  // The new/existing choice is its OWN step (RaceExperienceStep) and persists on
  // the item, so the Party step just reads it to decide which UI to show. The
  // wizard's Back button returns to that step natively.
  const experienceType = item.entryMode ?? null;
  const [verifiedPerson, setVerifiedPerson] = useState<PersonData | null>(null);
  const [linkedPersons, setLinkedPersons] = useState<LinkedPerson[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  // "Add existing racer" from the roster re-opens the lookup to add ANOTHER
  // returning account without disturbing the billing customer / contact.
  const [addingExisting, setAddingExisting] = useState(false);

  const billingFirstName = session.contact.firstName?.trim();
  const billingLastName = session.contact.lastName?.trim();
  const billingAlreadyAdded = session.party.some((m) => m.isBillingCustomer);

  // ── New-racer quantity helpers ─────────────────────────────
  const newAdults = session.party.filter(
    (m) => m.isNewRacer && (m.category ?? "adult") === "adult",
  );
  const newJuniors = session.party.filter((m) => m.isNewRacer && m.category === "junior");

  const setNewRacerCount = (category: "adult" | "junior", target: number) => {
    const current = category === "adult" ? newAdults : newJuniors;
    if (target > current.length) {
      for (let i = current.length; i < target; i++) {
        const label = category === "adult" ? `Adult ${i + 1}` : `Junior ${i + 1}`;
        dispatch({
          type: "addPartyMember",
          member: newPartyMember({ firstName: label, isNewRacer: true, category }),
        });
      }
    } else if (target < current.length) {
      for (let i = current.length - 1; i >= target; i--) {
        dispatch({ type: "removePartyMember", id: current[i].id });
      }
    }
  };

  // ── Returning-racer helpers ────────────────────────────────
  const addNewMember = () => {
    dispatch({
      type: "addPartyMember",
      member: newPartyMember({ firstName: "", isNewRacer: true, category: "adult" }),
    });
  };

  const addBillingCustomer = () => {
    if (!billingFirstName) return;
    dispatch({
      type: "addPartyMember",
      member: newPartyMember({
        firstName: billingFirstName,
        lastName: billingLastName,
        isNewRacer: experienceType !== "existing",
        category: "adult",
        isBillingCustomer: true,
      }),
    });
  };

  function handlePersonVerified(person: PersonData) {
    setVerifiedPerson(person);

    const age = ageFromBirthDate(person.birthDate);
    const category: "adult" | "junior" = age !== null && age < 13 ? "junior" : "adult";

    const member = newPartyMember({
      firstName: person.fullName.split(" ")[0] || person.fullName,
      lastName: person.fullName.split(" ").slice(1).join(" ") || undefined,
      bmiPersonId: person.personId,
      isNewRacer: false,
      category,
      isBillingCustomer: true,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
      creditBalances: person.creditBalances,
    });

    dispatch({ type: "addPartyMember", member });

    dispatch({
      type: "setContact",
      patch: {
        firstName: person.fullName.split(" ")[0] || "",
        lastName: person.fullName.split(" ").slice(1).join(" ") || "",
        email: person.email || undefined,
        phone: person.phone || undefined,
      },
    });

    // Fetch Pandora waiver status (non-blocking — badge appears when fetch completes)
    if (person.personId) {
      fetch(`/api/pandora?personId=${person.personId}&picture=false`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.valid === "boolean") {
            dispatch({
              type: "updatePartyMember",
              id: member.id,
              patch: { waiverValid: data.valid },
            });
          }
        })
        .catch(() => {});
    }

    // Fetch linked family members from Pandora
    fetchLinkedPersons(person.personId);
  }

  // Add ANOTHER returning racer from the roster's "Add existing racer" flow.
  // Unlike handlePersonVerified, this does NOT overwrite session.contact or
  // claim the billing customer — the first verified racer owns those.
  function handleAddExistingVerified(person: PersonData) {
    if (session.party.some((m) => m.bmiPersonId === person.personId)) {
      setAddingExisting(false);
      return;
    }
    const age = ageFromBirthDate(person.birthDate);
    const category: "adult" | "junior" = age !== null && age < 13 ? "junior" : "adult";

    const member = newPartyMember({
      firstName: person.fullName.split(" ")[0] || person.fullName,
      lastName: person.fullName.split(" ").slice(1).join(" ") || undefined,
      bmiPersonId: person.personId,
      isNewRacer: false,
      category,
      memberships: person.memberships,
      waiverValid: person.waiverValid,
      creditBalances: person.creditBalances,
    });
    dispatch({ type: "addPartyMember", member });

    if (person.personId) {
      fetch(`/api/pandora?personId=${person.personId}&picture=false`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && typeof data.valid === "boolean") {
            dispatch({
              type: "updatePartyMember",
              id: member.id,
              patch: { waiverValid: data.valid },
            });
          }
        })
        .catch(() => {});
      // Pull in this racer's linked family too, so the roster can offer them.
      fetchLinkedPersons(person.personId);
    }

    setAddingExisting(false);
  }

  async function fetchLinkedPersons(personId: string) {
    setLinkedLoading(true);
    try {
      const res = await fetch(`/api/pandora?personId=${personId}&picture=false`);
      if (!res.ok) return;
      const data = await res.json();
      const rawRelated: unknown[] = data.related || [];
      if (rawRelated.length === 0) return;
      // Pandora may return plain string IDs or objects with an id field
      const relatedIds: string[] = rawRelated
        .map((r) => (typeof r === "string" ? r : ((r as { id?: string })?.id ?? "")))
        .filter(Boolean);

      const details = await Promise.all(
        relatedIds.map(async (rid: string) => {
          try {
            const r = await fetch(`/api/pandora?personId=${rid}&picture=false`);
            if (!r.ok) return null;
            const p = await r.json();
            const first = p.firstName || "";
            const last = p.lastName || "";
            if (!first && !last) return null;
            return {
              id: rid,
              firstName: first,
              lastName: last,
              birthdate: p.birthdate || null,
              waiverValid: p.valid === true,
            } satisfies LinkedPerson;
          } catch {
            return null;
          }
        }),
      );
      setLinkedPersons(details.filter(Boolean) as LinkedPerson[]);
    } catch {
      /* non-fatal */
    } finally {
      setLinkedLoading(false);
    }
  }

  async function handleAddLinkedRacer(lp: LinkedPerson) {
    const age = ageFromBirthDate(lp.birthdate);
    const category: "adult" | "junior" = age !== null && age < 13 ? "junior" : "adult";

    // Look up BMI person details for this linked Pandora ID. The
    // memberships array gates tier filtering in filterProducts — pull
    // it here so Intermediate/Pro returning racers see their higher
    // tier products on the race step.
    let bmiPersonId: string | undefined;
    let memberships: string[] | undefined;
    try {
      const searchRes = await fetch(
        `/api/bmi-office?action=search&q=${encodeURIComponent(lp.id)}&max=5`,
      );
      const results = (await searchRes.json()) as Array<{ localId: string }>;
      if (results.length > 0) {
        const detailRes = await fetch(`/api/bmi-office?action=person&id=${results[0].localId}`);
        const p = (await detailRes.json()) as { id: string | number; memberships?: unknown[] };
        bmiPersonId = String(p.id);
        memberships = Array.isArray(p.memberships)
          ? p.memberships
              .map((m) =>
                typeof m === "string"
                  ? m
                  : typeof (m as { name?: string })?.name === "string"
                    ? (m as { name: string }).name
                    : "",
              )
              .filter(Boolean)
          : undefined;
      }
    } catch {
      /* non-fatal — add without BMI ID / memberships */
    }

    dispatch({
      type: "addPartyMember",
      member: newPartyMember({
        firstName: lp.firstName,
        lastName: lp.lastName || undefined,
        bmiPersonId,
        isNewRacer: false,
        category,
        memberships,
        waiverValid: lp.waiverValid,
      }),
    });
  }

  // ── Returning racer lookup ────────────────────────────────
  // Show lookup only when the customer chose "existing" and hasn't
  // verified anyone yet. After back-nav, `verifiedPerson` resets to
  // null but session.party survives — fall through to the roster if
  // any party member already has a bmiPersonId.
  const hasVerifiedMember = session.party.some((m) => m.bmiPersonId);

  if (experienceType === "existing" && !verifiedPerson && !hasVerifiedMember) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            Find Your Account
          </h3>
          <p className="mt-1 text-sm text-white/50">
            Log in to unlock your earned speeds and saved cards
          </p>
        </div>
        <ReturningRacerLookup
          onVerified={handlePersonVerified}
          onSwitchToNew={() => onChange({ entryMode: "new" })}
        />
      </div>
    );
  }

  // ── New racer: quantity picker (v1 parity) ─────────────────
  if (experienceType === "new") {
    const total = newAdults.length + newJuniors.length;
    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            How many racers?
          </h3>
          <p className="mx-auto max-w-md text-sm text-white/40">
            Tell us about your party so we can find the right races.
          </p>
        </div>

        <div className="mx-auto max-w-md space-y-3">
          <Counter
            label="Adults"
            description={'13+ years old and at least 59" (4\'11") tall'}
            value={newAdults.length}
            onChange={(n) => setNewRacerCount("adult", n)}
            min={0}
            max={10}
          />
          <Counter
            label="Juniors"
            description='7–13 years old and at least 49" tall'
            value={newJuniors.length}
            onChange={(n) => setNewRacerCount("junior", n)}
            min={0}
            max={10}
          />
        </div>

        {total === 0 && (
          <p className="text-center text-xs text-amber-400/70">
            Add at least one racer to continue.
          </p>
        )}

        {total > 0 && (
          <div className="mx-auto max-w-md rounded-xl border border-white/8 bg-white/3 p-3 text-center text-xs text-white/40">
            {total} racer{total !== 1 ? "s" : ""} total
            {newAdults.length > 0 &&
              newJuniors.length > 0 &&
              ` (${newAdults.length} adult${newAdults.length !== 1 ? "s" : ""}, ${newJuniors.length} junior${newJuniors.length !== 1 ? "s" : ""})`}
          </div>
        )}
      </div>
    );
  }

  // ── Add another existing racer (re-run lookup from the roster) ─
  if (addingExisting) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            Add a Returning Racer
          </h3>
          <p className="mt-1 text-sm text-white/50">
            Look them up to add their account and earned speeds
          </p>
        </div>
        <ReturningRacerLookup
          onVerified={handleAddExistingVerified}
          onSwitchToNew={() => {
            setAddingExisting(false);
            addNewMember();
          }}
        />
        <button
          type="button"
          onClick={() => setAddingExisting(false)}
          className="mx-auto block py-2 text-center text-xs text-white/30 transition-colors hover:text-white/50"
        >
          ← Back to party
        </button>
      </div>
    );
  }

  // ── Returning-racer party roster ──────────────────────────

  const alreadyAddedIds = new Set(session.party.map((m) => m.bmiPersonId).filter(Boolean));
  const availableLinked = linkedPersons.filter((lp) => !alreadyAddedIds.has(lp.id));

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-display text-2xl uppercase tracking-widest text-white">
          Who&apos;s Racing?
        </h3>
        <p className="mt-1 text-sm text-white/50">
          Add everyone in your party. You can assign them to heats next.
        </p>
      </div>

      {/* Express Lane banner */}
      {session.party.length > 0 &&
        session.party.some((m) => !m.isNewRacer) &&
        (() => {
          // A new racer must sign a waiver + pay the license at Guest Services,
          // so the WHOLE party can't skip it — a new racer downgrades full
          // eligibility to "some". Full eligibility requires every member to be
          // returning AND hold a valid waiver.
          const hasNewRacer = session.party.some((m) => m.isNewRacer);
          const returning = session.party.filter((m) => !m.isNewRacer);
          const allReturningValid =
            returning.length > 0 && returning.every((m) => m.waiverValid === true);
          const someValid = returning.some((m) => m.waiverValid === true);
          if (allReturningValid && !hasNewRacer) {
            return (
              <div className="mx-auto max-w-md rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-center">
                <div className="text-sm font-semibold text-emerald-400">
                  ⚡ Express Lane Eligible
                </div>
                <p className="mt-1 text-xs text-emerald-400/70">
                  All racers have valid waivers — skip Guest Services on race day!
                </p>
              </div>
            );
          }
          if (someValid) {
            return (
              <div className="mx-auto max-w-md rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-center">
                <div className="text-sm font-semibold text-amber-400">
                  ⚡ Some Racers Express Lane Eligible
                </div>
                <p className="mt-1 text-xs text-amber-400/70">
                  Racers with valid waivers can use Express Lane. Others will check in at Guest
                  Services.
                </p>
              </div>
            );
          }
          return null;
        })()}

      <div className="mx-auto max-w-md space-y-3">
        {session.party.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/3 p-6 text-center text-sm text-white/50">
            No party members yet. Add yourself or a friend below.
          </p>
        ) : (
          <ul className="space-y-3">
            {session.party.map((member) => (
              <PartyMemberRow
                key={member.id}
                member={member}
                verifiedPerson={
                  member.bmiPersonId && verifiedPerson?.personId === member.bmiPersonId
                    ? verifiedPerson
                    : null
                }
                onUpdate={(patch) => dispatch({ type: "updatePartyMember", id: member.id, patch })}
                onRemove={() => dispatch({ type: "removePartyMember", id: member.id })}
              />
            ))}
          </ul>
        )}

        {/* Add member buttons — existing (account lookup) vs brand-new racer. */}
        <div className="flex flex-wrap gap-2 pt-2">
          {billingFirstName && !billingAlreadyAdded && (
            <button
              type="button"
              onClick={addBillingCustomer}
              className="rounded-xl border border-[#00E2E5]/40 bg-[#00E2E5]/10 px-4 py-2 text-sm font-semibold text-[#00E2E5] transition-colors hover:border-[#00E2E5] hover:bg-[#00E2E5]/20"
            >
              + Add me ({billingFirstName})
            </button>
          )}
          <button
            type="button"
            onClick={() => setAddingExisting(true)}
            className="rounded-xl border border-[#00E2E5]/30 bg-[#00E2E5]/5 px-4 py-2 text-sm font-semibold text-[#00E2E5]/90 transition-colors hover:border-[#00E2E5]/60 hover:bg-[#00E2E5]/10"
          >
            + Add existing racer
          </button>
          <button
            type="button"
            onClick={addNewMember}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            + Add new racer
          </button>
        </div>

        {/* Linked family members from Pandora */}
        {linkedLoading && (
          <div className="flex items-center gap-2 pt-2 text-xs text-white/40">
            <div className="h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white/80" />
            Loading linked racers…
          </div>
        )}
        {availableLinked.length > 0 && (
          <div className="pt-2">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
              Linked Racers — tap to add
            </p>
            <div className="space-y-2">
              {availableLinked.map((lp) => {
                const displayName =
                  [lp.firstName, lp.lastName].filter(Boolean).join(" ") || "Unknown";
                const age = ageFromBirthDate(lp.birthdate);
                return (
                  <button
                    key={lp.id}
                    type="button"
                    onClick={() => handleAddLinkedRacer(lp)}
                    className="flex w-full items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-3 text-left transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/15"
                  >
                    <div>
                      <p className="text-sm font-semibold text-white">{displayName}</p>
                      <p className="text-xs text-white/40">
                        {age !== null ? `Age ${age}` : "Returning racer"}
                        {age !== null && age < 13 ? " · Junior" : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-bold text-emerald-400">+ Add</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function PartyMemberRow({
  member,
  verifiedPerson,
  onUpdate,
  onRemove,
}: {
  member: PartyMember;
  verifiedPerson: PersonData | null;
  onUpdate: (patch: Partial<PartyMember>) => void;
  onRemove: () => void;
}) {
  const tier = verifiedPerson
    ? tierFromMemberships(verifiedPerson.memberships).toLowerCase()
    : null;
  const tierInfo = tier ? TIER_BADGE[tier] : null;

  // Returning racers (verified from their BMI account, or added from linked
  // family) own their name upstream — show it locked, not editable.
  const isReturning = !!member.bmiPersonId;

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4">
      {isReturning ? (
        <div className="min-w-32">
          <span className="block text-xs uppercase tracking-wider text-white/40">Racer</span>
          <p className="mt-1 w-full rounded-lg border border-white/10 bg-white/3 px-3 py-2 text-sm text-white/80">
            {[member.firstName, member.lastName].filter(Boolean).join(" ") || member.firstName}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-32 flex-1">
            <span className="block text-xs uppercase tracking-wider text-white/40">First name</span>
            <input
              type="text"
              value={member.firstName}
              onChange={(e) => onUpdate({ firstName: e.target.value })}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-[#00E2E5]/60 focus:bg-white/10 focus:outline-none"
              placeholder="Alex"
            />
          </label>
          <label className="min-w-32 flex-1">
            <span className="block text-xs uppercase tracking-wider text-white/40">Last name</span>
            <input
              type="text"
              value={member.lastName ?? ""}
              onChange={(e) => onUpdate({ lastName: e.target.value || undefined })}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-[#00E2E5]/60 focus:bg-white/10 focus:outline-none"
              placeholder="Trepasso"
            />
          </label>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <CategoryToggle
          value={member.category ?? "adult"}
          onChange={(category) => onUpdate({ category })}
        />
        {member.isNewRacer && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-400">
            New
          </span>
        )}
        {member.isBillingCustomer && (
          <span className="rounded-full bg-[#00E2E5]/15 px-2 py-0.5 text-xs font-semibold text-[#00E2E5]">
            Paying
          </span>
        )}
        {member.bmiPersonId && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">
            ✓ Returning
          </span>
        )}
        {tierInfo && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tierInfo.bg} ${tierInfo.text}`}
          >
            {tierInfo.label}
          </span>
        )}
        {verifiedPerson?.waiverValid && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">
            Express Lane
          </span>
        )}
        {verifiedPerson?.creditBalances && verifiedPerson.creditBalances.length > 0 && (
          <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-400">
            {verifiedPerson.creditBalances.map((c) => `${c.balance} ${c.kind}`).join(", ")}
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto rounded-lg border border-red-500/20 px-3 py-1 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function Counter({
  label,
  description,
  value,
  onChange,
  min = 0,
  max = 10,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white">{label}</p>
        <p className="mt-0.5 text-xs text-white/40">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 text-lg font-bold text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
        >
          −
        </button>
        <span className="w-6 text-center text-xl font-bold tabular-nums text-white">{value}</span>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 text-lg font-bold text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
        >
          +
        </button>
      </div>
    </div>
  );
}

function CategoryToggle({
  value,
  onChange,
}: {
  value: "adult" | "junior";
  onChange: (v: "adult" | "junior") => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-white/5 p-1">
      {(["adult", "junior"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={
            "rounded-md px-3 py-1 text-xs font-semibold transition-colors " +
            (value === opt ? "bg-[#00E2E5] text-[#000418]" : "text-white/40 hover:text-white/70")
          }
        >
          {opt[0].toUpperCase() + opt.slice(1)}
        </button>
      ))}
    </div>
  );
}

// First race step — the new-vs-returning choice. Its OWN step so the wizard's
// Back/Next navigate it natively (it shows in the breadcrumb); the choice
// persists on item.entryMode and the Party step reads it.
const RaceExperienceStepComponent: StepDef<RaceItem>["Component"] = ({ item, onChange }) => (
  <ExperiencePicker
    selected={item.entryMode ?? null}
    onSelect={(mode) => onChange({ entryMode: mode })}
  />
);

export const RaceExperienceStep: StepDef<RaceItem> = {
  id: "race-experience",
  title: "Racer",
  Component: RaceExperienceStepComponent,
  isVisible: () => true,
  canAdvance: (item) =>
    item.entryMode ? true : { reason: "Choose new or returning racer to continue." },
};

export const RacePartyStep: StepDef<RaceItem> = {
  id: "race-party",
  title: "Party",
  Component: RacePartyStepComponent,
  isVisible: () => true,
  canAdvance: (_item, session) => {
    if (session.party.length === 0) {
      return { reason: "Add at least one racer to continue." };
    }
    const missingName = session.party.some((m) => !m.isNewRacer && !m.firstName.trim());
    if (missingName) return { reason: "Every party member needs a first name." };
    return true;
  },
};
