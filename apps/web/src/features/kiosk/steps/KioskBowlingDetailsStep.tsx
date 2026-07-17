"use client";

/**
 * Kiosk bowler roster — REQUIRED on the kiosk (owner 2026-07-17): every
 * bowler's name, shoe size, and bumpers choice is collected in-flow, so the
 * lane is fully set up the moment the reservation lands (web collects these
 * post-booking, optionally). Writes BowlingCommon.players; the reserve paths
 * push real names/sizes/bumpers to QAMF and persist the roster to Neon.
 *
 * Shoe-size vocabulary mirrors the confirmation editor's ranges
 * (Toddler/Kids/Mens/Womens) in a touch-friendly chip rail. "Own shoes"
 * records null size explicitly — sizes are only required for renters, but
 * the CHOICE is required for everyone.
 */
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";

type RosterPlayer = { name: string; shoeSize: string | null; bumpers: boolean | null };
type BowlItem = BowlingItem | KbfItem;

const SHOE_SIZES: string[] = [
  ...["8T", "9T", "10T", "11T", "12T", "13T"].map((s) => `Toddler ${s.replace("T", "")}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `Kids ${n}`),
  ...[5, 6, 7, 8, 9, 10, 11].map((n) => `Womens ${n}`),
  ...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => `Mens ${n}`),
];

/** "Own shoes" sentinel — an explicit answer that isn't a rental size.
 *  Encoded as "" in players.shoeSize; the reserve mappings normalize "" → null
 *  so Neon/QAMF only ever see a real size or nothing. */
const OWN_SHOES = "";

function playerCountOf(item: BowlItem): number {
  return item.kind === "bowling" ? item.playerCount : item.bowlers.length + item.paidAdults;
}

/**
 * Roster encoding: shoeSize null = UNANSWERED, "" = explicit "own shoes"
 * (normalized to null at the reserve mappings), "Mens 9" = rental size.
 * bumpers null = unanswered.
 */
function rosterOf(item: BowlItem): RosterPlayer[] {
  const count = playerCountOf(item);
  const existing = item.players ?? [];
  return Array.from({ length: count }, (_, i) => ({
    name: existing[i]?.name ?? "",
    shoeSize: existing[i] ? existing[i].shoeSize : null,
    bumpers: existing[i] ? existing[i].bumpers : null,
  }));
}

function playerComplete(p: RosterPlayer): boolean {
  return p.name.trim().length > 0 && p.shoeSize !== null && p.bumpers !== null;
}

const KioskBowlingDetailsStepComponent: StepDef<BowlItem>["Component"] = ({ item, onChange }) => {
  const roster = rosterOf(item);
  const update = (index: number, patch: Partial<RosterPlayer>) => {
    const next = roster.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange({ players: next } as Partial<BowlItem>);
  };

  const readyCount = roster.filter(playerComplete).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-display text-2xl uppercase tracking-widest text-white">
            Who&rsquo;s bowling?
          </h3>
          <p className="mt-1 text-sm text-white/50">
            Names, shoes and bumpers — so your lane is ready the moment you are
          </p>
        </div>
        <span className="font-heading shrink-0 text-sm font-bold uppercase tracking-widest text-[#00e2e5] tabular-nums">
          {readyCount} of {roster.length} ready
        </span>
      </div>

      <div className="space-y-5">
        {roster.map((p, i) => {
          const complete = playerComplete(p);
          return (
            <div
              key={i}
              className={`rounded-2xl border bg-white/[0.03] p-5 ${
                complete ? "border-[#46d68c]/40" : "border-white/10"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="font-heading text-lg font-extrabold italic">Bowler {i + 1}</span>
                {complete && (
                  <span className="text-xs font-semibold uppercase tracking-widest text-[#46d68c]">
                    Ready
                  </span>
                )}
              </div>

              <label
                htmlFor={`kiosk-bowler-name-${i}`}
                className="mb-1 block text-xs font-semibold uppercase tracking-widest text-white/40"
              >
                Name
              </label>
              <input
                id={`kiosk-bowler-name-${i}`}
                type="text"
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder={`Bowler ${i + 1}`}
                autoComplete="off"
                className="mb-4 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />

              <span className="mb-1 block text-xs font-semibold uppercase tracking-widest text-white/40">
                Shoe size
              </span>
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => update(i, { shoeSize: OWN_SHOES })}
                  className={`shrink-0 rounded-xl border-2 px-4 py-3 text-sm font-semibold ${
                    p.shoeSize === OWN_SHOES
                      ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                      : "border-white/10 text-white/50"
                  }`}
                >
                  Own shoes
                </button>
                {SHOE_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => update(i, { shoeSize: size })}
                    className={`shrink-0 rounded-xl border-2 px-4 py-3 text-sm font-semibold tabular-nums ${
                      p.shoeSize === size
                        ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                        : "border-white/10 text-white/50"
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-4">
                <span className="text-xs font-semibold uppercase tracking-widest text-white/40">
                  Bumpers
                </span>
                <div className="inline-flex overflow-hidden rounded-xl border-2 border-white/15">
                  {([true, false] as const).map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      onClick={() => update(i, { bumpers: v })}
                      className={`px-6 py-2.5 text-sm font-bold ${
                        p.bumpers === v ? "bg-[#00E2E5] text-[#04252b]" : "text-white/55"
                      }`}
                    >
                      {v ? "Yes" : "No"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const KioskBowlingDetailsStep: StepDef<BowlItem> = {
  id: "kiosk-bowling-details",
  title: "Bowlers",
  Component: KioskBowlingDetailsStepComponent,
  isVisible: () => true,
  canAdvance: (item) => {
    const roster = rosterOf(item);
    if (roster.length === 0) return { reason: "Add at least one bowler first." };
    const incomplete = roster.findIndex((p) => !playerComplete(p));
    if (incomplete >= 0) {
      return {
        reason: `Bowler ${incomplete + 1} still needs a name, shoe choice, and bumpers answer.`,
      };
    }
    return true;
  },
};

export { OWN_SHOES };
