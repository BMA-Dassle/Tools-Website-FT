/**
 * THE FIRST-TOUCH HOOK, under the name the Wave-C briefs call it by.
 *
 * There is exactly ONE implementation and it lives in `./response-time.ts`,
 * next to the badge it feeds (`first_touch_at` and "waiting 18 min" are the
 * same fact seen twice). This module exists so a PR told to "call
 * `leads/service/touches.ts`" lands on that implementation instead of writing
 * a second one — a second writer of `crm_leads.first_touch_at` would race the
 * guarded UPDATE that makes the FIRST touch win.
 *
 * Cross-sub callers import `~/features/crm/leads` (the barrel, §3.2), never
 * this path; C1 / C2 / C3 hand their freshly written activity to
 * `noteOutboundTouch` rather than calling `recordFirstTouch` directly.
 */

export {
  noteOutboundTouch,
  recordFirstTouch,
  type RecordFirstTouchInput,
  type RecordFirstTouchResult,
} from "./response-time";
