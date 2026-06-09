"use client";

import type { BowlingItem, StepDef } from "~/features/booking";

// 24 bowlers = 4 lanes (6/lane) — the online self-service ceiling. Bigger
// parties are handled as Group Events (deposits, lane blocking, staff coord).
const MAX_PLAYERS = 24;
const MIN_PLAYERS = 1;
const PLAYERS_PER_LANE = 6;

const BowlingPlayersStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const count = item.playerCount;
  const laneCount = Math.max(1, Math.ceil(count / PLAYERS_PER_LANE));

  function setCount(n: number) {
    const clamped = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
    onChange({
      playerCount: clamped,
      laneCount: Math.max(1, Math.ceil(clamped / PLAYERS_PER_LANE)),
    });
  }

  return (
    <div className="mx-auto max-w-md space-y-8">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          How Many Bowlers?
        </h2>
        <p className="mt-1 text-sm text-white/40">
          Up to {PLAYERS_PER_LANE} per lane. We&apos;ll assign lanes automatically.
        </p>
      </div>

      <div className="flex items-center justify-center gap-6">
        <button
          type="button"
          onClick={() => setCount(count - 1)}
          disabled={count <= MIN_PLAYERS}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-white/15 text-2xl font-bold text-white transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-30"
        >
          &minus;
        </button>
        <div className="text-center">
          <span className="font-display text-5xl text-white">{count}</span>
          <p className="mt-1 text-xs text-white/40">bowler{count !== 1 ? "s" : ""}</p>
        </div>
        <button
          type="button"
          onClick={() => setCount(count + 1)}
          disabled={count >= MAX_PLAYERS}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-white/15 text-2xl font-bold text-white transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-30"
        >
          +
        </button>
      </div>

      {laneCount > 1 && (
        <p className="text-center text-sm text-white/50">
          {laneCount} lanes &middot; {PLAYERS_PER_LANE} bowlers per lane
        </p>
      )}
    </div>
  );
};

const BowlingPlayersStep: StepDef<BowlingItem> = {
  id: "bowling-players",
  title: "Bowlers",
  Component: BowlingPlayersStepComponent,
  isVisible: () => true,
  canAdvance: (item) =>
    item.playerCount >= MIN_PLAYERS ? true : { reason: "Select at least 1 bowler" },
};

export default BowlingPlayersStep;
