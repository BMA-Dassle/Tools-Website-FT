"use client";

import { useEffect, useState } from "react";
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
}

const RacePartyStepComponent: StepDef<RaceItem>["Component"] = ({ session, dispatch }) => {
  const [experienceType, setExperienceType] = useState<"new" | "existing" | null>(null);
  const [verifiedPerson, setVerifiedPerson] = useState<PersonData | null>(null);
  const [linkedPersons, setLinkedPersons] = useState<LinkedPerson[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);

  const billingFirstName = session.contact.firstName?.trim();
  const billingLastName = session.contact.lastName?.trim();
  const billingAlreadyAdded = session.party.some((m) => m.isBillingCustomer);

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

    const age = person.birthDate
      ? Math.floor(
          (Date.now() - new Date(person.birthDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000),
        )
      : null;
    const category: "adult" | "junior" = age !== null && age < 13 ? "junior" : "adult";

    dispatch({
      type: "addPartyMember",
      member: newPartyMember({
        firstName: person.fullName.split(" ")[0] || person.fullName,
        lastName: person.fullName.split(" ").slice(1).join(" ") || undefined,
        bmiPersonId: person.personId,
        isNewRacer: false,
        category,
        isBillingCustomer: true,
      }),
    });

    dispatch({
      type: "setContact",
      patch: {
        firstName: person.fullName.split(" ")[0] || "",
        lastName: person.fullName.split(" ").slice(1).join(" ") || "",
        email: person.email || undefined,
        phone: person.phone || undefined,
      },
    });

    // Fetch linked family members from Pandora
    fetchLinkedPersons(person.personId);
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
            } satisfies LinkedPerson;
          } catch {
            return null;
          }
        }),
      );
      setLinkedPersons(details.filter((p): p is LinkedPerson => p !== null));
    } catch {
      /* non-fatal */
    } finally {
      setLinkedLoading(false);
    }
  }

  async function handleAddLinkedRacer(lp: LinkedPerson) {
    const age = lp.birthdate
      ? Math.floor((Date.now() - new Date(lp.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : null;
    const category: "adult" | "junior" = age !== null && age < 13 ? "junior" : "adult";

    // Look up BMI person details for this linked Pandora ID
    let bmiPersonId: string | undefined;
    try {
      const searchRes = await fetch(
        `/api/bmi-office?action=search&q=${encodeURIComponent(lp.id)}&max=5`,
      );
      const results = (await searchRes.json()) as Array<{ localId: string }>;
      if (results.length > 0) {
        const detailRes = await fetch(`/api/bmi-office?action=person&id=${results[0].localId}`);
        const p = await detailRes.json();
        bmiPersonId = String(p.id);
      }
    } catch {
      /* non-fatal — add without BMI ID */
    }

    dispatch({
      type: "addPartyMember",
      member: newPartyMember({
        firstName: lp.firstName,
        lastName: lp.lastName || undefined,
        bmiPersonId,
        isNewRacer: false,
        category,
      }),
    });
  }

  // ── Experience picker (first screen) ──────────────────────

  if (experienceType === null) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            Welcome to FastTrax
          </h3>
          <p className="mt-1 text-sm text-white/50">Have you raced with us before?</p>
        </div>
        <ExperiencePicker selected={null} onSelect={setExperienceType} />
      </div>
    );
  }

  // ── Returning racer lookup ────────────────────────────────

  if (experienceType === "existing" && !verifiedPerson) {
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
          onSwitchToNew={() => setExperienceType("new")}
        />
      </div>
    );
  }

  // ── Party roster ──────────────────────────────────────────

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

        {/* Add member buttons */}
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
                const age = lp.birthdate
                  ? Math.floor(
                      (Date.now() - new Date(lp.birthdate).getTime()) /
                        (365.25 * 24 * 60 * 60 * 1000),
                    )
                  : null;
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

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4">
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

export const RacePartyStep: StepDef<RaceItem> = {
  id: "race-party",
  title: "Party",
  Component: RacePartyStepComponent,
  isVisible: () => true,
  canAdvance: (_item, session) => {
    if (session.party.length === 0) {
      return { reason: "Add at least one party member." };
    }
    const missingName = session.party.some((m) => !m.firstName.trim());
    if (missingName) return { reason: "Every party member needs a first name." };
    return true;
  },
};
