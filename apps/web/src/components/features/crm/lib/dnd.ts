"use client";

import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type MouseSensorOptions,
  type ScreenReaderInstructions,
  type SensorDescriptor,
  type SensorOptions,
  type TouchSensorOptions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";

/**
 * The CRM's drag, on dnd-kit — one set of sensors, one collision rule and one
 * set of announcements, shared by the pipeline board and the lead queue.
 *
 * This replaces ~175 lines of hand-rolled pointer capture (`use-board-drag.ts`)
 * and its bespoke ghost (`DragLayer.tsx`). dnd-kit is a BEHAVIOUR library — it
 * ships no styled components and no CSS, so it does not breach the
 * no-component-kits rule; the CRM's own `crm.css` still draws everything. The
 * sibling Team Member Portal already depends on it, so this is the pattern next
 * door rather than a new one.
 *
 * Drag is NEVER the only way to do anything here: every card keeps its
 * "Change status" / "Assign" button, and the keyboard path below is a genuine
 * second way in, not a consolation prize.
 */

/** How far a MOUSE must travel before a press is a drag and not a click. */
export const DRAG_DISTANCE_PX = 6;

/**
 * How long a FINGER must rest on a card before it is a drag.
 *
 * A distance constraint cannot work on touch: the columns scroll vertically and
 * the board scrolls horizontally, so the first few pixels of travel are far more
 * likely to be a scroll than a drag. A short hold is unambiguous, and until it
 * elapses the browser scrolls exactly as it always did.
 */
export const DRAG_HOLD_MS = 200;

/** How far a resting finger may wander during that hold and still be a drag. */
export const DRAG_HOLD_TOLERANCE_PX = 8;

/** Marks the one control inside a card whose job IS to start the drag. */
export const DRAG_HANDLE_SELECTOR = "[data-crm-drag-handle]";

const CONTROL_SELECTOR = "button, a, input, select, textarea, [role='button']";

/**
 * True when a press landed on a control inside the card — the Call/Text/Email
 * rail, the title, "Change status", "Assign". Those keep their click; only the
 * card body starts a drag. The drag handle is exempt: it is a `<button>` that
 * exists to be grabbed.
 *
 * Exported for its own test: this predicate is the whole reason the rail stays
 * clickable, and it is the first thing to break if the card markup changes.
 */
export function startsOnControl(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest(DRAG_HANDLE_SELECTOR)) return false;
  return !!el.closest(CONTROL_SELECTOR);
}

/** Primary button only, and never from a control inside the card. */
export class CrmMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: "onMouseDown" as const,
      handler: ({ nativeEvent }: ReactMouseEvent, { onActivation }: MouseSensorOptions) => {
        if (nativeEvent.button !== 0) return false;
        if (startsOnControl(nativeEvent.target)) return false;
        onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];
}

/** One finger only, and never from a control inside the card. */
export class CrmTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: ({ nativeEvent }: ReactTouchEvent, { onActivation }: TouchSensorOptions) => {
        if (nativeEvent.touches.length > 1) return false;
        if (startsOnControl(nativeEvent.target)) return false;
        onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];
}

/** A rectangle reduced to the only axis a column board moves along. */
export interface HopRect {
  left: number;
  width: number;
}

/**
 * How far left or right a keyboard drag jumps: to the centre of the NEAREST
 * column in the pressed direction, or null when there is none (or the key is
 * not a horizontal arrow).
 *
 * dnd-kit's stock coordinate getter nudges 25px per key press. On a board of
 * 272px columns that is eleven presses to cross one gutter, which is not a
 * keyboard path, it is a punishment. Both boards here are columns side by side,
 * so one hop = one column.
 */
export function hopDelta(code: string, from: HopRect, targets: readonly HopRect[]): number | null {
  const direction = code === "ArrowRight" ? 1 : code === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return null;
  const centre = from.left + from.width / 2;
  let best: number | null = null;
  for (const target of targets) {
    const delta = target.left + target.width / 2 - centre;
    // Anything within a pixel of where we already are is the column we are on.
    if (delta * direction <= 1) continue;
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  return best;
}

/** Left / right arrows hop between drop columns; everything else is dnd-kit's. */
export const columnHopCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const { collisionRect, droppableContainers, droppableRects } = context;
  if (!collisionRect) return undefined;
  const targets: HopRect[] = [];
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (rect) targets.push(rect);
  }
  const delta = hopDelta(event.code, collisionRect, targets);
  if (delta === null) return undefined;
  event.preventDefault();
  return { x: currentCoordinates.x + delta, y: currentCoordinates.y };
};

/**
 * Where a card lands.
 *
 * With a pointer it is whatever column is literally UNDER the finger and
 * nothing else — the same promise the hand-rolled `elementFromPoint` made, and
 * the reason a card dropped on the un-droppable "Booked" column does nothing
 * instead of squirting sideways into the nearest column that would take it.
 * `closestCenter` is the fallback for a KEYBOARD drag only, which has no
 * pointer to be under anything.
 */
export const crmCollisionDetection: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  if (under.length > 0) return under;
  return args.pointerCoordinates ? [] : closestCenter(args);
};

const MOUSE_OPTIONS: MouseSensorOptions = {
  activationConstraint: { distance: DRAG_DISTANCE_PX },
};
const TOUCH_OPTIONS: TouchSensorOptions = {
  activationConstraint: { delay: DRAG_HOLD_MS, tolerance: DRAG_HOLD_TOLERANCE_PX },
};
const KEYBOARD_OPTIONS = { coordinateGetter: columnHopCoordinates };

/** Mouse, touch and keyboard — the three ways a planner reaches a card. */
export function useCrmDragSensors(): SensorDescriptor<SensorOptions>[] {
  return useSensors(
    useSensor(CrmMouseSensor, MOUSE_OPTIONS),
    useSensor(CrmTouchSensor, TOUCH_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );
}

/** What a screen reader is told the FIRST time it lands on a drag handle. */
export function dragInstructions(target: string): ScreenReaderInstructions {
  return {
    draggable:
      `Press space or enter to pick this card up. Use the left and right arrow keys to move it ` +
      `between ${target}, then space or enter to drop it, or escape to cancel. ` +
      `You never have to drag: every card has a button that does the same thing.`,
  };
}

/**
 * The running commentary, in the CRM's own words rather than dnd-kit's
 * "Draggable item 3 was moved over droppable area 7".
 *
 * `label` turns any id in flight — a lead, a column, a rep — into the name a
 * person would use for it.
 */
export function crmAnnouncements(label: (id: UniqueIdentifier) => string): Announcements {
  return {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${label(active.id)} is over ${label(over.id)}.`
        : `${label(active.id)} is not over anywhere it can be dropped.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${label(active.id)} on ${label(over.id)}.`
        : `Put ${label(active.id)} back — it was not over anywhere it can be dropped.`,
    onDragCancel: ({ active }) => `Cancelled. ${label(active.id)} is back where it was.`,
  };
}
