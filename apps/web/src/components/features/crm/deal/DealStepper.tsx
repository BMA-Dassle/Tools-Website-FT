"use client";

import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useEffect } from "react";
import { dealStep } from "~/features/crm/deals/stepper";
import { ICON } from "../primitives/icon-props";

/**
 * "3 of 18" with an arrow either side, in the drawer header.
 *
 * Owner, 2026-09-14: "I should be able to hit right and left buttons to just
 * keep going through each of them. something in top right I'd assume."
 *
 * The COUNT is not decoration. Without it an arrow that stops working is
 * indistinguishable from an arrow that is broken; with it, "18 of 18" explains
 * itself. It is also the only feedback that the order being stepped is the
 * column, not the whole board.
 *
 * Renders NOTHING when there is nowhere to step — one deal, or a deal that has
 * left the list. An always-present pair of dead arrows trains people to ignore
 * them.
 */
export interface DealStepperProps {
  /** The public ids the SCREEN is showing, in the order it shows them. */
  order?: readonly string[];
  current: string;
  onStep: (publicId: string) => void;
}

export function DealStepper({ order, current, onStep }: DealStepperProps) {
  const { prev, next, index, total } = dealStep(order, current);

  /**
   * Left / right arrow keys, because stepping a column of eighteen with a
   * mouse is the chore this was meant to remove.
   *
   * NOT while typing. A rep writing a note uses the arrow keys to move the
   * caret, and stealing them would throw the deal away mid-sentence — so any
   * input, textarea, select or contenteditable keeps its keys. Modifier
   * combinations are left alone too: browser history is ⌥←.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) {
          return;
        }
      }
      const to = e.key === "ArrowLeft" ? prev : next;
      if (!to) return;
      e.preventDefault();
      onStep(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onStep]);

  if (!index || total < 2) return null;

  return (
    <span className="deal-step" data-testid="crm-deal-stepper">
      <button
        type="button"
        className="btn btn-sm btn-icon btn-ghost"
        onClick={() => prev && onStep(prev)}
        disabled={!prev}
        aria-label="Previous deal"
        title="Previous deal (←)"
      >
        <IconChevronLeft {...ICON} />
      </button>
      <span className="deal-step-n" aria-live="polite">
        {index} of {total}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-icon btn-ghost"
        onClick={() => next && onStep(next)}
        disabled={!next}
        aria-label="Next deal"
        title="Next deal (→)"
      >
        <IconChevronRight {...ICON} />
      </button>
    </span>
  );
}
