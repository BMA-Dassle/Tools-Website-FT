"use client";

import { useState } from "react";
import type { KbfItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";

const KbfBowlersStepComponent: StepDef<KbfItem>["Component"] = ({ item, session, onChange }) => {
  const [guestAdults, setGuestAdults] = useState(0);

  // The roster was captured at verify time across every pass and lives
  // in session state — there is no members endpoint to fetch from.
  const members = session.kbfIdentity?.members ?? [];

  const selected = new Set(item.bowlers);
  const kids = members.filter((m) => m.relation === "kid");
  const familyAdults = members.filter((m) => m.relation === "family");
  const selectedKids = kids.filter((m) => selected.has(m.id));

  function toggleMember(id: number) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
      const member = members.find((m) => m.id === id);
      if (member?.relation === "kid") {
        const remainingKids = kids.filter((k) => next.has(k.id));
        if (remainingKids.length === 0) {
          familyAdults.forEach((a) => next.delete(a.id));
          setGuestAdults(0);
        }
      }
    } else {
      next.add(id);
    }
    updateBowlers(next);
  }

  function updateGuestAdults(count: number) {
    const clamped = Math.max(0, Math.min(6, count));
    setGuestAdults(clamped);
    updateBowlers(selected, clamped);
  }

  function updateBowlers(sel: Set<number>, guests?: number) {
    const bowlerIds = Array.from(sel);
    const paidAdults =
      bowlerIds.filter((id) => {
        const m = members.find((mm) => mm.id === id);
        return m && m.relation !== "kid" && m.relation !== "family";
      }).length + (guests ?? guestAdults);

    const playerCount = bowlerIds.length + (guests ?? guestAdults);
    const laneCount = Math.max(1, Math.ceil(playerCount / 6));

    onChange({
      bowlers: bowlerIds,
      paidAdults,
      laneCount,
    });
  }

  const totalBowlers = selected.size + guestAdults;

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Who&apos;s Bowling?
        </h2>
        <p className="mt-1 text-sm text-white/40">Select the members from your pass</p>
      </div>

      {/* Kids */}
      {kids.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">Kids (free)</h3>
          {kids.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => toggleMember(m.id)}
              className="flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all"
              style={{
                borderColor: selected.has(m.id) ? CORAL : "rgba(255,255,255,0.1)",
                backgroundColor: selected.has(m.id)
                  ? "rgba(253,91,86,0.08)"
                  : "rgba(255,255,255,0.02)",
              }}
            >
              <div
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold"
                style={{
                  borderColor: selected.has(m.id) ? CORAL : "rgba(255,255,255,0.2)",
                  backgroundColor: selected.has(m.id) ? CORAL : "transparent",
                  color: selected.has(m.id) ? "#0a1628" : "transparent",
                }}
              >
                &#10003;
              </div>
              <span className="text-sm text-white">
                {m.firstName} {m.lastName}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Family adults */}
      {familyAdults.length > 0 && selectedKids.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">
            Family Adults (free)
          </h3>
          {familyAdults.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => toggleMember(m.id)}
              className="flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all"
              style={{
                borderColor: selected.has(m.id) ? CORAL : "rgba(255,255,255,0.1)",
                backgroundColor: selected.has(m.id)
                  ? "rgba(253,91,86,0.08)"
                  : "rgba(255,255,255,0.02)",
              }}
            >
              <div
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold"
                style={{
                  borderColor: selected.has(m.id) ? CORAL : "rgba(255,255,255,0.2)",
                  backgroundColor: selected.has(m.id) ? CORAL : "transparent",
                  color: selected.has(m.id) ? "#0a1628" : "transparent",
                }}
              >
                &#10003;
              </div>
              <span className="text-sm text-white">
                {m.firstName} {m.lastName}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Guest adults (paid) */}
      {selectedKids.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-white/40">
            Additional Adults (paid)
          </h3>
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <span className="text-sm text-white/60">Guest adults</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => updateGuestAdults(guestAdults - 1)}
                disabled={guestAdults === 0}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 text-lg text-white disabled:opacity-30"
              >
                &minus;
              </button>
              <span className="w-4 text-center text-sm font-bold text-white">{guestAdults}</span>
              <button
                type="button"
                onClick={() => updateGuestAdults(guestAdults + 1)}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 text-lg text-white"
              >
                +
              </button>
            </div>
          </div>
        </div>
      )}

      {totalBowlers > 0 && (
        <p className="text-center text-sm text-white/50">
          {totalBowlers} bowler{totalBowlers !== 1 ? "s" : ""}
          {guestAdults > 0 && ` (${guestAdults} paid)`}
        </p>
      )}
    </div>
  );
};

const KbfBowlersStep: StepDef<KbfItem> = {
  id: "kbf-bowlers",
  title: "Bowlers",
  Component: KbfBowlersStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.bowlers.length > 0 ? true : { reason: "Select at least one bowler" }),
};

export default KbfBowlersStep;
