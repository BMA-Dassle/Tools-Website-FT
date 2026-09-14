/**
 * Stepping from one deal to the next WITHOUT leaving the drawer.
 *
 * Owner, 2026-09-14: "When I open an event from the pipeline I should be able
 * to hit right and left buttons to just keep going through each of them.
 * something in top right I'd assume." Closing and re-opening was the only way
 * to reach the next card, which makes working a column a click-per-deal chore.
 *
 * THE SCREEN OWNS THE ORDER, NOT THIS FILE AND NOT THE DRAWER. A rep working
 * the Contacted column expects "next" to mean the next card in that column —
 * not the next lead by id, and not something from a column they are not
 * looking at. So each screen passes the sequence it is actually displaying
 * (the pipeline's column order, the queue's oldest-first, the events board's
 * day order) and this only does the arithmetic. A drawer that derived its own
 * order would be right on one screen and wrong on the other three.
 *
 * NO WRAPPING. At the last card "next" is disabled, not a jump back to the
 * first: a rep stepping through a column needs to know when they have finished
 * it, and silently looping is how somebody works the same eight deals twice.
 */

export interface DealStep {
  /** The public id one step back, or null at the start. */
  prev: string | null;
  /** The public id one step on, or null at the end. */
  next: string | null;
  /** 1-based position for "3 of 18"; 0 when the deal is not in the list. */
  index: number;
  total: number;
}

const NOWHERE: DealStep = { prev: null, next: null, index: 0, total: 0 };

/**
 * Where `current` sits in `order`, and what is either side of it.
 *
 * A deal that is NOT in the list gets no neighbours rather than the first and
 * second — that happens for real (a rep changes a card's status from inside
 * the drawer and it leaves the column under them, or a filter drops it), and
 * guessing would step them somewhere they never asked to go. The buttons
 * disappear instead, which is honest.
 */
export function dealStep(order: readonly string[] | undefined, current: string): DealStep {
  if (!order || order.length === 0) return NOWHERE;
  // De-duplicated because a lead can legitimately appear twice in a screen's
  // raw list — the same deal in a column AND in a swimlane under it — and a
  // repeat would make "next" land on the card already open.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of order) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const at = ids.indexOf(current);
  if (at < 0) return { prev: null, next: null, index: 0, total: ids.length };
  return {
    prev: at > 0 ? ids[at - 1]! : null,
    next: at < ids.length - 1 ? ids[at + 1]! : null,
    index: at + 1,
    total: ids.length,
  };
}

/**
 * Flatten a board into the order a reader's eye takes: column by column, and
 * within a column, top to bottom.
 *
 * Swimlanes (`?by=rep`) are the reason this is not a one-liner — when they are
 * on, a column's cards are grouped per rep and the visual order is lane by
 * lane, so `leadIds` alone would step in an order nobody can see on screen.
 */
export interface SteppableColumn {
  leadIds: readonly string[];
  lanes: readonly { leadIds: readonly string[] }[] | null;
}

export function boardOrder(
  columns: readonly SteppableColumn[],
  publicIdOf: (leadId: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const col of columns) {
    const ids = col.lanes ? col.lanes.flatMap((l) => [...l.leadIds]) : col.leadIds;
    for (const leadId of ids) {
      const publicId = publicIdOf(leadId);
      if (publicId) out.push(publicId);
    }
  }
  return out;
}
