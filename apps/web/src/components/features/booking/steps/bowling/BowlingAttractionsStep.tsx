"use client";

import { useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";

type BowlingLikeItem = BowlingItem | KbfItem;

const ATTRACTIONS = [
  { slug: "laser-tag", name: "Laser Tag", color: "#ef4444" },
  { slug: "gel-blaster", name: "Gel Blaster", color: "#22c55e" },
];

const BowlingAttractionsStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  onChange,
}) => {
  const [skipped, setSkipped] = useState(false);
  const addons = item.attractionAddons;

  if (skipped || addons.length > 0) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-4">
        {addons.length > 0 && (
          <div className="space-y-2">
            {addons.map((a, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold text-white">{a.name}</p>
                  <p className="text-xs text-white/40">
                    {a.quantity} &times; ${a.pricePerPerson.toFixed(2)} &middot; {a.timeLabel}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onChange({
                      attractionAddons: addons.filter((_, j) => j !== i),
                    } as Partial<BowlingLikeItem>);
                  }}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-center text-xs text-white/30">
          Add-ons can also be booked at the center.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Level Up Your Visit
        </h2>
        <p className="mt-1 text-sm text-white/40">
          Add laser tag or gel blaster to your bowling session
        </p>
      </div>

      <div className="space-y-3">
        {ATTRACTIONS.map((attr) => (
          <div key={attr.slug} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">{attr.name}</h3>
                <p className="text-xs text-white/40">Book a session alongside your bowling</p>
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                style={{ backgroundColor: `${attr.color}20`, color: attr.color }}
              >
                Coming soon
              </span>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setSkipped(true)}
        className="mx-auto block text-sm text-white/40 transition-colors hover:text-white/70"
      >
        Skip — I&apos;ll just bowl
      </button>
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
