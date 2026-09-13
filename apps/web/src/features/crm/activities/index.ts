/**
 * `~/features/crm/activities` — DDL in PR1; B3 added the row writer
 * (`recordActivity`) and one lead's keyset timeline; B4 adds the merged
 * timeline and touch counting.
 *
 * `service/actions.ts` (note · snooze · call disposition) is deliberately NOT
 * exported here: it calls `transition()`, which imports this sub back, and
 * `data/activities-db.ts` already imports `~/features/crm/leads`. Exporting it
 * would close a cycle through three barrels — and drag `lib/bmi-office-actions`
 * and ioredis into the import graph of every module that records an activity.
 * The one route that needs those three actions imports
 * `~/features/crm/activities/service/actions` by path; the reasoning is
 * written out in full in `statuses/index.ts`.
 *
 * Client components import `./contracts` and `./queries` by PATH, never this
 * barrel (§5.7b).
 */
export { ensureActivitiesSchema } from "./data/activities-db";
export { recordActivity, type NewActivity } from "./service/record";
export {
  decodeTimelineCursor,
  listLeadTimeline,
  mapActivityRow,
  type ActivityRowRaw,
  type TimelinePage,
} from "./service/lead-timeline";
export {
  buildTimeline,
  externalIdentity,
  getActivity,
  mergeTimeline,
  sortTimeline,
  touchesFrom,
} from "./service/timeline";
export {
  countTouches,
  countTouchesToday,
  emptyTouchCounts,
  isNewTouch,
  touchChannelOf,
  touchDayEt,
  touchKey,
  type TouchLike,
} from "./service/touches";
export * from "./contracts";
export * from "./schemas";
export { activitiesKeys, type ActivitiesKey } from "./queries";
