import type { ReactNode } from "react";
import type { ChipKind } from "~/features/crm/core/types";

/**
 * `statusChip` / `bmiChip` / the bare `.chip` from crm-shared.js:202-204.
 *
 *   <Chip kind="won">Booked</Chip>                 → .chip[data-kind=won]
 *   <Chip kind="open" st="quote">Quote sent</Chip> → status hue by data-st
 *   <Chip bmi title="…">BMI · New Lead</Chip>       → .chip.chip-bmi (no dot)
 */
export interface ChipProps {
  kind?: ChipKind;
  /** Our status id — drives the per-status hue (`.chip[data-st]`). */
  st?: string;
  /** The outlined BMI chip. */
  bmi?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Chip({ kind, st, bmi = false, title, className, children }: ChipProps) {
  const cls = ["chip", bmi ? "chip-bmi" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} data-kind={kind} data-st={st} title={title}>
      {children}
    </span>
  );
}
