"use client";

import type { PartyMember, RaceItem, StepDef } from "~/features/booking";
import { newPartyMember } from "~/features/booking";

/**
 * Race step — build the party roster.
 *
 * Writes to SESSION.party (not the active RaceItem) via dispatch. The
 * step's "Add me" button copies the billing customer's contact info
 * (collected at the checkout step in commit 10) into the party with
 * `isBillingCustomer: true`. Without contact, that quick-add is hidden.
 *
 * Each member carries: firstName, optional lastName, isNewRacer (drives
 * Starter-only filter + license fee), category (adult/junior — drives
 * race product eligibility).
 *
 * canAdvance requires at least one member because heat assignments
 * downstream need someone to assign to.
 */

const RacePartyStepComponent: StepDef<RaceItem>["Component"] = ({ session, dispatch }) => {
  const billingFirstName = session.contact.firstName?.trim();
  const billingLastName = session.contact.lastName?.trim();
  const billingAlreadyAdded = session.party.some((m) => m.isBillingCustomer);

  const addBlankMember = () => {
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
        isNewRacer: true,
        category: "adult",
        isBillingCustomer: true,
      }),
    });
  };

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
                onUpdate={(patch) => dispatch({ type: "updatePartyMember", id: member.id, patch })}
                onRemove={() => dispatch({ type: "removePartyMember", id: member.id })}
              />
            ))}
          </ul>
        )}

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
            onClick={addBlankMember}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            + Add party member
          </button>
        </div>

        <p className="pt-3 text-xs text-white/40">
          Raced with us before? Returning-racer lookup is coming in the next update — for now
          everyone is treated as new. Your account&apos;s race tier will unlock additional product
          options once we wire the BMI verification flow.
        </p>
      </div>
    </div>
  );
};

function PartyMemberRow({
  member,
  onUpdate,
  onRemove,
}: {
  member: PartyMember;
  onUpdate: (patch: Partial<PartyMember>) => void;
  onRemove: () => void;
}) {
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[8rem]">
          <span className="block text-xs uppercase tracking-wider text-white/40">First name</span>
          <input
            type="text"
            value={member.firstName}
            onChange={(e) => onUpdate({ firstName: e.target.value })}
            className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-[#00E2E5]/60 focus:bg-white/10 focus:outline-none"
            placeholder="Alex"
          />
        </label>
        <label className="flex-1 min-w-[8rem]">
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

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <CategoryToggle
          value={member.category ?? "adult"}
          onChange={(category) => onUpdate({ category })}
        />
        {member.isBillingCustomer && (
          <span className="rounded-full bg-[#00E2E5]/15 px-2 py-0.5 text-xs font-semibold text-[#00E2E5]">
            Paying
          </span>
        )}
        {member.bmiPersonId && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400">
            ✓ Returning racer
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
