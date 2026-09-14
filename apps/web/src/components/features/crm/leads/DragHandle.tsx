"use client";

import type { DraggableAttributes } from "@dnd-kit/core";
import { IconGripVertical } from "@tabler/icons-react";
import { ICON } from "../primitives/icon-props";

/**
 * The grab bar on a card.
 *
 * A mouse or a finger can take hold of the card ANYWHERE — that is what the
 * sensors in `lib/dnd.ts` are for — so this exists for two other reasons:
 *
 *   • it is dnd-kit's ACTIVATOR node, which is what makes the keyboard path
 *     real. Space or enter on it picks the card up, the arrow keys move it,
 *     space or enter drops it, escape cancels — and dnd-kit returns focus here
 *     afterwards. (The keyboard sensor refuses any key press whose target is
 *     not the activator, so pressing enter on the card's title still opens the
 *     deal rather than starting a drag.)
 *   • it SAYS the card is draggable. The old board's only clue was a sentence
 *     in the toolbar.
 *
 * It carries dnd-kit's `attributes` (role, tabindex, `aria-roledescription`,
 * and the `aria-describedby` that points at the instructions) — the listeners
 * stay on the card wrapper, where the pointer gestures need them.
 */
export interface DragHandleProps {
  attributes: DraggableAttributes;
  setRef: (element: HTMLElement | null) => void;
  /** "Move Osborn party to another column" — spoken, so name the thing moved. */
  label: string;
  disabled?: boolean;
}

export function DragHandle({ attributes, setRef, label, disabled }: DragHandleProps) {
  return (
    <button
      type="button"
      ref={setRef}
      {...attributes}
      data-crm-drag-handle=""
      className="btn btn-ghost btn-sm"
      style={{ padding: "2px 4px", cursor: disabled ? "default" : "grab" }}
      aria-label={label}
      title="Drag me, or press space and use the arrow keys"
      disabled={disabled}
    >
      <IconGripVertical {...ICON} />
    </button>
  );
}
