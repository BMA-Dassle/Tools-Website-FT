/**
 * `~/features/crm/statuses` — our pipeline statuses and their BMI state map.
 * Transitions (`service/transition.ts`) arrive in B4 behind this same door.
 */
export {
  STATUS_ID_RE,
  archiveStatus,
  ensureStatusesSchema,
  getStatus,
  listStatuses,
  mapStatusRow,
  reorderStatuses,
  seedStatuses,
  upsertStatus,
  type StatusRowRaw,
} from "./data/statuses-db";
export {
  deleteStatusMap,
  ensureStatusMapSchema,
  getStatusMapping,
  listStatusMap,
  upsertStatusMap,
} from "./data/status-map-db";
export {
  STATUS_BMI_STATE_NAMES,
  UNPROPOSED_OFFICE_STATES,
  listOfficeStateNames,
  normalizeStateName,
  proposeStatusMap,
  stateNamesToList,
  type MetadataReader,
  type OfficeStatesResult,
} from "./service/bmi-states";
