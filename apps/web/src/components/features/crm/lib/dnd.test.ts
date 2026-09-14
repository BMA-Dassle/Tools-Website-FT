import type {
  Active,
  ClientRect,
  CollisionDetection,
  DroppableContainer,
  Over,
} from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import {
  DRAG_DISTANCE_PX,
  DRAG_HOLD_MS,
  crmAnnouncements,
  crmCollisionDetection,
  hopDelta,
  startsOnControl,
} from "./dnd";

/**
 * The pure pieces of the CRM's drag. dnd-kit owns the gesture itself — there is
 * nothing to test in a library — but these are OURS, and each is a promise the
 * board would otherwise break silently:
 *
 *   • `startsOnControl` is why the Call / Text / Email rail still clicks;
 *   • `crmCollisionDetection` is why a card dropped on the un-droppable
 *     "Booked" column does nothing instead of landing in its neighbour;
 *   • `hopDelta` is the keyboard path — one press, one column.
 */

/** A stand-in for `Element.closest`, matching the selectors this node "has". */
function elementMatching(...selectors: string[]): EventTarget {
  return { closest: (sel: string) => (selectors.includes(sel) ? {} : null) } as unknown as Element;
}

describe("startsOnControl", () => {
  const CONTROLS = "button, a, input, select, textarea, [role='button']";

  it("refuses a press that landed on a control inside the card", () => {
    expect(startsOnControl(elementMatching(CONTROLS))).toBe(true);
  });

  it("lets the card body through", () => {
    expect(startsOnControl(elementMatching())).toBe(false);
  });

  it("lets the drag HANDLE through, even though it is a button", () => {
    expect(startsOnControl(elementMatching(CONTROLS, "[data-crm-drag-handle]"))).toBe(false);
  });

  it("survives a target that is not an element at all", () => {
    expect(startsOnControl(null)).toBe(false);
    expect(startsOnControl({} as EventTarget)).toBe(false);
  });
});

describe("crmCollisionDetection", () => {
  const rect = (left: number): ClientRect => ({
    left,
    top: 0,
    width: 100,
    height: 400,
    right: left + 100,
    bottom: 400,
  });

  // Two droppable columns side by side; the card in flight sits over the left
  // one. A third, un-droppable column lives off to the right at x≈900 — it is
  // absent from `droppableContainers` exactly as a disabled droppable is.
  function args(pointerCoordinates: { x: number; y: number } | null) {
    return {
      active: { id: "lead-1", data: { current: undefined }, rect: { current: {} } },
      collisionRect: rect(0),
      droppableRects: new Map([
        ["quote", rect(0)],
        ["contract", rect(200)],
      ]),
      droppableContainers: [{ id: "quote" }, { id: "contract" }] as unknown as DroppableContainer[],
      pointerCoordinates,
    } as unknown as Parameters<CollisionDetection>[0];
  }

  it("with a pointer, returns only what is under it", () => {
    expect(crmCollisionDetection(args({ x: 50, y: 100 })).map((c) => c.id)).toEqual(["quote"]);
  });

  it("with a pointer over NOTHING droppable, returns nothing — it does not fall sideways", () => {
    // The whole point: the pointer is over the un-droppable "Booked" column.
    // The old board refused that drop; a bare `closestCenter` fallback would
    // have squirted the card into whichever neighbour happened to be nearest.
    expect(crmCollisionDetection(args({ x: 900, y: 100 }))).toEqual([]);
  });

  it("with NO pointer at all — a keyboard drag — falls back to the nearest centre", () => {
    expect(crmCollisionDetection(args(null))[0]?.id).toBe("quote");
  });
});

describe("hopDelta", () => {
  // Three 100-wide columns at 0, 200 and 400; centres 50, 250 and 450.
  const columns = [
    { left: 0, width: 100 },
    { left: 200, width: 100 },
    { left: 400, width: 100 },
  ];

  it("moves one column right, not 25 pixels", () => {
    expect(hopDelta("ArrowRight", { left: 0, width: 100 }, columns)).toBe(200);
  });

  it("moves one column left", () => {
    expect(hopDelta("ArrowLeft", { left: 400, width: 100 }, columns)).toBe(-200);
  });

  it("hops from the middle in both directions", () => {
    expect(hopDelta("ArrowRight", { left: 200, width: 100 }, columns)).toBe(200);
    expect(hopDelta("ArrowLeft", { left: 200, width: 100 }, columns)).toBe(-200);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(hopDelta("ArrowRight", { left: 400, width: 100 }, columns)).toBeNull();
    expect(hopDelta("ArrowLeft", { left: 0, width: 100 }, columns)).toBeNull();
  });

  it("ignores everything but the horizontal arrows — a column board has no up", () => {
    expect(hopDelta("ArrowUp", { left: 200, width: 100 }, columns)).toBeNull();
    expect(hopDelta("ArrowDown", { left: 200, width: 100 }, columns)).toBeNull();
    expect(hopDelta("Space", { left: 200, width: 100 }, columns)).toBeNull();
  });

  it("takes the NEAREST column in the pressed direction, not the first listed", () => {
    const shuffled = [columns[2]!, columns[0]!, columns[1]!];
    expect(hopDelta("ArrowRight", { left: 0, width: 100 }, shuffled)).toBe(200);
  });
});

describe("crmAnnouncements", () => {
  const say = crmAnnouncements((id) => (id === "lead-1" ? "Osborn party" : "Contract sent"));
  const active = { id: "lead-1" } as unknown as Active;
  const over = { id: "contract" } as unknown as Over;

  it("names the lead and the column, not dnd-kit's ids", () => {
    expect(say.onDragStart({ active })).toBe("Picked up Osborn party.");
    expect(say.onDragOver({ active, over })).toBe("Osborn party is over Contract sent.");
    expect(say.onDragEnd({ active, over })).toBe("Dropped Osborn party on Contract sent.");
  });

  it("says so when there is nowhere to drop", () => {
    expect(say.onDragOver({ active, over: null })).toContain("not over anywhere");
    expect(say.onDragEnd({ active, over: null })).toContain("Put Osborn party back");
    expect(say.onDragCancel({ active, over: null })).toContain("back where it was");
  });
});

describe("the activation constraints", () => {
  it("keeps a mouse click a click, and a finger's scroll a scroll", () => {
    // A mouse drags after TRAVEL; a finger drags after a HOLD, because the
    // first pixels of a finger's travel belong to the column's own scroll.
    expect(DRAG_DISTANCE_PX).toBeGreaterThan(0);
    expect(DRAG_HOLD_MS).toBeGreaterThanOrEqual(150);
  });
});
