/**
 * `~/features/crm/activities` — DDL in PR1; B3 adds the row writer
 * (`recordActivity`) and one lead's keyset timeline; B4 adds
 * `service/timeline.ts` (the merged view) + `touches.ts`.
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
