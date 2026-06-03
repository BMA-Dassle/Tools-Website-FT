"use client";

import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";

type BowlingLikeItem = BowlingItem | KbfItem;

const ACTIVITIES = [
  { name: "Laser Tag", duration: "15 min session", color: "#8652FF" },
  { name: "Gel Blaster", duration: "15 min session", color: "#00E2E5" },
];

/**
 * Informational step — tells users they can add attractions from the cart.
 * Attractions are booked as separate cart items (same flow as racing add-ons)
 * rather than embedded in the bowling wizard.
 */
const BowlingAttractionsStepComponent: StepDef<BowlingLikeItem>["Component"] = () => {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Level Up Your Visit
        </h2>
        <p className="mt-1 text-sm text-white/40">
          Add laser tag or gel blaster to your bowling trip
        </p>
      </div>

      <div className="space-y-3">
        {ACTIVITIES.map((act) => (
          <div
            key={act.name}
            className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4"
          >
            <div
              className="h-12 w-1 flex-shrink-0 rounded-full"
              style={{ backgroundColor: act.color }}
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{act.name}</span>
                <span className="text-xs text-white/30">{act.duration}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 text-center">
        <p className="text-sm text-white/50">
          After completing your bowling setup, you can add activities from your cart.
        </p>
        <p className="mt-1 text-xs text-white/30">Activities can also be booked at the center.</p>
      </div>
    </div>
  );
};

const BowlingAttractionsStep: StepDef<BowlingItem> = {
  id: "bowling-attractions",
  title: "Add-ons",
  Component: BowlingAttractionsStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: () => true,
};

export default BowlingAttractionsStep;
