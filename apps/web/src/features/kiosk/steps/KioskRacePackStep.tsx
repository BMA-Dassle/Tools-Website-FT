"use client";

/**
 * Kiosk race packs — assign a prepaid race pack to specific people (owner
 * 2026-07-18: "add race packs with the ability to put them on certain people,
 * new and returning"). Every party member already has a real bmiPersonId by
 * this step (the people step onboards everyone), so a pack can attach to anyone.
 *
 * This step ONLY records the per-person assignment (member.pendingPacks). The
 * charge + Pandora grant + the owner's "fund today" credit sequencing are the
 * MONEY path and are wired separately, flag-gated + live-smoked (H3074 rule) —
 * see tasks/kiosk-race-packs.md. The whole step is gated by kioskPacksEnabled()
 * (default OFF), so nothing here is reachable until that work ships.
 *
 * One pack → one person (owner decision): a pack's credits are non-transferable;
 * a person may hold more than one pack (toggle several) but a pack is never split.
 */
import type { PartyMember, RaceItem, StepDef } from "~/features/booking";
import { RACE_PACKS } from "~/features/booking/data/packs";
import { kioskPacksEnabled } from "../flags";

const KioskRacePackStepComponent: StepDef<RaceItem>["Component"] = ({ session, dispatch }) => {
  const party = session.party;

  const toggle = (m: PartyMember, slug: string) => {
    const cur = m.pendingPacks ?? [];
    const next = cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug];
    dispatch({ type: "updatePartyMember", id: m.id, patch: { pendingPacks: next } });
  };

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">
        Optional — bank race credits for anyone in your group. Packs are per racer.
      </p>

      <div className="space-y-[20px]">
        {party.map((m) => {
          const picks = new Set(m.pendingPacks ?? []);
          return (
            <div key={m.id} className="k-glass p-[28px]">
              <div className="k-display mb-[16px] text-[34px]">
                {m.firstName} {m.lastName ?? ""}
              </div>
              <div className="grid grid-cols-3 gap-[14px]">
                {RACE_PACKS.map((p) => {
                  const on = picks.has(p.slug);
                  return (
                    <button
                      key={p.slug}
                      type="button"
                      onClick={() => toggle(m, p.slug)}
                      aria-pressed={on}
                      className={`rounded-2xl border-2 px-[18px] py-[18px] text-center ${
                        on
                          ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                          : "border-white/10 bg-white/[0.02] text-white/60"
                      }`}
                    >
                      <div className="k-display text-[30px] leading-none">
                        {p.raceCount}
                        <span className="text-[18px]"> races</span>
                      </div>
                      <div className="mt-[6px] text-[19px] uppercase tracking-widest text-white/45">
                        {p.dayType}
                      </div>
                      <div className="mt-[6px] text-[22px] font-bold tabular-nums">
                        ${p.price.toFixed(0)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const KioskRacePackStep: StepDef<RaceItem> = {
  id: "kiosk-race-pack",
  title: "Race packs",
  Component: KioskRacePackStepComponent,
  // Flag-gated (default OFF) until the pack charge/grant money path ships + is
  // live-smoked. Hidden = no packs assigned = zero money impact.
  isVisible: () => kioskPacksEnabled(),
  canAdvance: () => true, // packs are optional
};
