/**
 * `~/features/crm/events` — the Events board, the deal's Event tab and the two
 * BMI note rails (B6). SERVER-SIDE BARREL: it re-exports the Office and Neon
 * services, so a `"use client"` component must import `./contracts`,
 * `./projection`, `./queries` and `./notes/sections` BY PATH and never this
 * file (§5.7b — one barrel export drags `ioredis` into the browser bundle and
 * the Turbopack build dies on `dns` / `fs` / `net` / `tls`).
 */

export * from "./contracts";
export * from "./schemas";
export { eventsKeys, EVENTS_POLL_MS, type EventsKey } from "./queries";
export {
  bandTotals,
  contractView,
  dayRange,
  eventPill,
  isCancelledState,
  isPastUnpaid,
  makeBand,
  mergeEventRows,
  stepDate,
  NO_CONTRACT_PILL,
  type BoardQuote,
  type BoardReservation,
  type MergeInput,
} from "./projection";
export {
  defaultBoardDeps,
  eventsBoard,
  leadLink,
  resolveBoardDate,
  type BoardDeps,
  type EventsBoardBody,
  type EventsBoardInput,
} from "./service/board";
export {
  defaultEventDetailDeps,
  eventDetail,
  foodOutView,
  projectEventDetail,
  type EventDetailDeps,
} from "./service/event-detail";
export { eventsHttpError, withEventsErrors } from "./service/errors";
export {
  createLeadFromEvent,
  defaultCreateFromEventDeps,
  type CreateFromEventDeps,
  type CreateFromEventInput,
  type CreateFromEventResult,
} from "./service/create-from-event";
export {
  leadEventTarget,
  LeadNotFoundError,
  NoBmiProjectError,
  type LeadEventTarget,
} from "./service/target";
export {
  appendPrivateNote,
  defaultNotesDeps,
  previewPublicNotes,
  privateNoteLine,
  readNotes,
  saveFoodOut,
  savePublicNotes,
  sendWaiverLinks,
  BmiWritesPausedError,
  CRM_NOTES_SESSION_TAG,
  type AppendPrivateInput,
  type AppendPrivateResult,
  type NotesBody,
  type NotesDeps,
  type NotesTarget,
  type PreviewResult,
  type SaveFoodOutInput,
  type SavePublicInput,
  type SavePublicResult,
  type WaiverSendResult,
} from "./notes/service";
export {
  foodOutFromMemo,
  parsePrivateMemo,
  sectionsCoverMemo,
  SECTION_LABEL,
  PORTAL_SECTION_MARKER,
  WEB_SECTION_END,
  WEB_SECTION_START,
} from "./notes/sections";
