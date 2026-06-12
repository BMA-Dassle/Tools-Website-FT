import { enabledCombos } from "~/features/combos";

import ComboSpecialCard from "./ComboSpecialCard";

/**
 * Grid of enabled combo-specials cards. Renders nothing when no combo is
 * enabled (flag off) so the surfaces degrade cleanly. The surface supplies
 * the section wrapper / heading; `gridClassName` overrides the default
 * 1/2/3-column grid where the host layout is narrower (e.g. pricing's
 * right column).
 */
export default function ComboSpecials({
  gridClassName = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6",
}: {
  gridClassName?: string;
}) {
  const combos = enabledCombos();
  if (combos.length === 0) return null;

  // A LONE premium combo renders as one centered hero tile — inside the
  // 3-column grid its col-span-2 left an empty third column, which read as
  // off-center on desktop. Still ~double a standard card's width.
  if (combos.length === 1 && combos[0].premium) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <ComboSpecialCard combo={combos[0]} />
      </div>
    );
  }

  return (
    <div className={gridClassName}>
      {combos.map((combo) => (
        <ComboSpecialCard key={combo.id} combo={combo} />
      ))}
    </div>
  );
}
