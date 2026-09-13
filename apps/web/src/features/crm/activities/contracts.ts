/**
 * The activities sub's WIRE SHAPES — what `/api/admin/crm/leads/[id]/activities`
 * answers and the deal Timeline renders.
 *
 * Kept beside the sub (the `leads/contracts.ts` precedent) rather than appended
 * to `core/contracts.ts`, so parallel Wave-B PRs never append to one file.
 *
 * CLIENT-SAFE: type-only imports from core, no Node, no Neon. Ids are strings.
 */

import type { ApiOk } from "../core/contracts";
import type { CrmActivity } from "../core/types";
import type { LeadView } from "../leads/contracts";

// ---------------------------------------------------------------------------
// Touch counting (crm-shared.js:418, verbatim)
//   "A touch counts once per lead per channel per day. Auto-replies and
//    delivery receipts never count."
// ---------------------------------------------------------------------------

/** The four channels the accountability rules count. */
export const TOUCH_CHANNELS = ["call", "sms", "email", "reachout"] as const;

export type TouchChannel = (typeof TOUCH_CHANNELS)[number];

/** The rule as the CRM states it on screen — the prototype's sentence, verbatim. */
export const TOUCH_RULE_COPY =
  "A touch counts once per lead per channel per day. Auto-replies and delivery receipts never count.";

/** How many distinct (lead, channel, ET day) touches a set of activities holds. */
export type TouchCounts = Record<TouchChannel, number>;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** GET /leads/[id]/activities?cursor=&limit= */
export type TimelineResponse = ApiOk<{
  activities: CrmActivity[];
  /** `<occurredAtIso>|<id>`; null at the end of the lead's history. */
  nextCursor: string | null;
  /** Touches made TODAY (ET) on this lead, one per channel at most. */
  touchesToday: TouchCounts;
}>;

/** POST /leads/[id]/activities — one of the three things a rep logs by hand. */
export type ActivityPostResponse = ApiOk<{
  activity: CrmActivity | null;
  /** The lead after the write (a snooze moves `nextAction`; a call may advance status). */
  lead: LeadView;
  /** False when this channel had already been touched today (the rule above). */
  countedAsTouch: boolean;
}>;

/** The dispositions the call sheet offers (crm-shared.js:255, verbatim). */
export const CALL_OUTCOMES = [
  "Reached",
  "Voicemail",
  "No answer",
  "Callback scheduled",
  "Wrong number",
  "Not interested",
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * The snooze presets (crm-shared.js:278) — the prototype's four buttons, and
 * its 9 AM landing.
 *
 * The LABELS are the prototype's, verbatim. The arithmetic is not: the
 * prototype hard-codes "Monday 9 AM" as `+2 days` because its frozen clock is
 * a Saturday. A real Monday is computed from the lead's own ET day, so the
 * button never snoozes to a Wednesday.
 */
export const SNOOZE_PRESET_IDS = ["tomorrow", "monday", "three-days", "next-week"] as const;

export type SnoozePresetId = (typeof SNOOZE_PRESET_IDS)[number];

export const SNOOZE_PRESETS: readonly { id: SnoozePresetId; label: string }[] = [
  { id: "tomorrow", label: "Tomorrow 9 AM" },
  { id: "monday", label: "Monday 9 AM" },
  { id: "three-days", label: "In 3 days" },
  { id: "next-week", label: "Next week" },
];

/** The ET hour a snooze lands on. */
export const SNOOZE_HOUR_ET = 9;

export const ACTIVITY_TEST_IDS = {
  timeline: "crm-timeline",
  timelineItem: (id: string) => "crm-timeline-" + id,
  timelineMore: "crm-timeline-more",
  noteSheet: "crm-note-sheet",
  snoozeSheet: "crm-snooze-sheet",
  callSheet: "crm-call-sheet",
} as const;
