/**
 * The events sub's WIRE SHAPES — what `/api/admin/crm/events/**` and the four
 * `/api/admin/crm/leads/[id]/{event,notes/*,food-out,waivers}` handlers answer,
 * and what the Events board, the Notes tab and the Event tab render.
 *
 * CLIENT-SAFE: type-only imports from `core`, no Node, no Neon, no transport.
 * A `"use client"` component imports THIS file (and `./projection`,
 * `./notes/sections`, `./queries`) by path — never `~/features/crm/events`,
 * whose barrel drags the Office transport into the browser bundle (§5.7b, the
 * `ioredis → dns/fs/net/tls` build failure on feat/crm-availability).
 *
 * Ids are strings on the wire, always (17-digit BMI project ids).
 */

import type { ApiOk } from "../core/contracts";
import type { CentreCode, ChipKind, GfStatus } from "../core/types";

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export const EVENTS_VIEWS = ["day", "week"] as const;
export type EventsView = (typeof EVENTS_VIEWS)[number];

/** Days a week band spans (the prototype's Wed → Tue strip, `date` + 6). */
export const EVENTS_WEEK_DAYS = 7;

/**
 * The row's money pill (`crm-events.js:246`), in the prototype's own order:
 * a settled contract is PAID, a signed one DEPOSIT, one still out UNSIGNED,
 * anything else its own GF chip, and an event with no contract at all says so.
 */
export type EventPillKind = "paid" | "deposit" | "unsigned" | "gf" | "none";

export interface EventPill {
  kind: EventPillKind;
  label: string;
  /** The `.chip[data-kind]` hue; null for the outlined `.chip-bmi` shape. */
  chip: ChipKind | null;
  /** Set only when `kind === "gf"` — the tooltip comes from GF_STATUS_META. */
  gfStatus: GfStatus | null;
}

/** The contract columns the board and the Event tab read. */
export interface EventContractView {
  shortId: string | null;
  status: GfStatus;
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  balanceCents: number;
  collectedCents: number;
  depositPaidAt: string | null;
  signedAt: string | null;
  sentAt: string | null;
  balancePaidAt: string | null;
  dayofOrderId: string | null;
  giftCardGan: string | null;
  postPaid: boolean;
}

/** The CRM lead a BMI project is joined to, when one exists. */
export interface EventLeadLink {
  publicId: string;
  id: string;
  status: string;
  repName: string | null;
  repSlug: string | null;
  guestPhone: string | null;
}

export interface EventFoodOut {
  time: string | null;
  source: "ai" | "manual" | null;
  confidence: string | null;
  reasoning: string | null;
  updatedAt: string | null;
}

export const EMPTY_FOOD_OUT: EventFoodOut = {
  time: null,
  source: null,
  confidence: null,
  reasoning: null,
  updatedAt: null,
};

/** One `.row.evrow` — BMI truth first, contract and CRM state layered on. */
export interface EventRowView {
  projectId: string;
  /** BMI project number ("H2879"); "—" is the component's job, not ours. */
  number: string;
  title: string;
  personName: string;
  /** The reservation start, ISO. */
  when: string;
  persons: number;
  /** Signed waivers on file; null when BMI did not report a capacity row. */
  registered: number | null;
  stateName: string;
  stateId: string | null;
  responsible: string;
  centre: CentreCode;
  /** BMI balance in DOLLARS, exactly as Office reports it. */
  balance: number;
  totalCents: number;
  collectedCents: number;
  foodOut: EventFoodOut;
  lead: EventLeadLink | null;
  contract: EventContractView | null;
  pill: EventPill;
  cancelled: boolean;
}

export interface EventDayBand {
  /** YYYY-MM-DD in ET. */
  date: string;
  isToday: boolean;
  events: EventRowView[];
  persons: number;
  totalCents: number;
  collectedCents: number;
  /** BMI could not be read for this day — the band says so rather than "no group events". */
  error: string | null;
}

export type EventsBoardResponse = ApiOk<{
  centre: CentreCode;
  view: EventsView;
  /** The first day of the band (the URL's `date`, or ET-today). */
  date: string;
  /** ET-today, so the board can mark it without a second clock. */
  today: string;
  includeCancelled: boolean;
  days: EventDayBand[];
}>;

// ---------------------------------------------------------------------------
// Event detail (the deal's Event tab, and an event with no lead row)
// ---------------------------------------------------------------------------

export interface EventScheduleRow {
  id: string;
  start: string;
  stop: string;
  resource: string;
  products: string;
  persons: number;
}

export interface EventProductRow {
  id: string;
  productId: string;
  name: string;
  nameOverride: string | null;
  quantity: number;
  totalPriceCents: number;
}

export interface EventPersonRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
}

export interface EventDetailView {
  projectId: string;
  number: string;
  name: string;
  when: string | null;
  centre: CentreCode;
  stateName: string;
  kindName: string;
  responsible: string;
  persons: number;
  registered: number | null;
  balanceCents: number;
  createdAt: string | null;
  schedules: EventScheduleRow[];
  products: EventProductRow[];
  people: EventPersonRow[];
  contact: EventPersonRow | null;
  foodOut: EventFoodOut;
  /** Racing / laser tag / gel blaster on the event — the waiver card's gate. */
  waiversRequired: boolean;
  contract: EventContractView | null;
}

export type EventDetailResponse = ApiOk<{ event: EventDetailView }>;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * A parsed slice of the BMI private memo. Three writers share that one field
 * (R6) and each keeps its own section: the website's contract rail
 * (`── FastTrax Web ──`), the food-out sync (`----- Portal Staff -----`), and
 * whatever staff typed into Office by hand.
 */
export type PrivateSectionKey = "staff" | "web" | "portal";

export interface PrivateNoteSection {
  key: PrivateSectionKey;
  label: string;
  /** The literal marker the section is recognised by; null for free text. */
  marker: string | null;
  text: string;
}

export interface CrmNoteView {
  id: string;
  actorEmail: string | null;
  body: string;
  occurredAt: string;
}

export type NotesResponse = ApiOk<{
  projectId: string;
  centre: CentreCode;
  publicNotes: string;
  privateMemo: string;
  sections: PrivateNoteSection[];
  foodOut: EventFoodOut;
  crmNotes: CrmNoteView[];
  /** False when the director has paused BMI writes for this tenant (R4). */
  writesEnabled: boolean;
}>;

export type NotesPreviewResponse = ApiOk<{
  original: string;
  cleaned: string;
  changed: boolean;
  /** False when the AI gateway key is absent — the text is returned untouched. */
  available: boolean;
}>;

export type NotesPublicSaveResponse = ApiOk<{
  publicNotes: string;
  /** True when the AI clean-up changed the text before it was written. */
  cleaned: boolean;
  /** The re-read proved the write landed (R5: never trust a 200). */
  verified: boolean;
}>;

export type NotesPrivateResponse = ApiOk<{
  appended: boolean;
  sections: PrivateNoteSection[];
  privateMemo: string;
}>;

export type FoodOutResponse = ApiOk<{ foodOut: EventFoodOut }>;

export type WaiversResponse = ApiOk<{
  sent: boolean;
  organizerUrl: string | null;
  signUrl: string | null;
  /** Why nothing was sent: `no_contract`, `no_waiver_products`, `no_links`. */
  reason: string | null;
}>;

/** The eight food-out presets on the sheet (`crm-events.js:144`, verbatim). */
export const FOOD_OUT_PRESETS: readonly string[] = [
  "4:30 PM",
  "4:45 PM",
  "5:00 PM",
  "5:30 PM",
  "6:00 PM",
  "6:30 PM",
  "7:00 PM",
  "8:30 PM",
];

/** The prototype's own words, kept verbatim so the screens never invent copy. */
export const EVENTS_COPY = {
  boardFoot:
    "Rows open the same deal drawer as the pipeline, on the Event tab. Cancelled events are hidden (toggle in filters). Past events left unpaid turn red.",
  publicNotesHelp:
    "Shown on the contract Review step, the confirmation page, and in guest emails. Changing notes after signing updates the guest page without a re-sign.",
  publicNotesCaption: "BMI Office public notes · replace-only",
  privateNotesCaption: "BMI private log · append-only",
  privateComposerPlaceholder:
    "Add a private note — appended to the BMI project, never shown to the guest…",
  threeWriters:
    "Three writers share this field in BMI: the CRM (this log), the website's contract rail (the FastTrax Web block with contract and waiver links), and the food-out line. Each keeps its own section so none can erase another.",
  crmNotesStayHere:
    "CRM timeline notes (the Note button above) stay in the CRM only and are not written to BMI.",
  whereGoesPublic:
    "Contract page · confirmation page · guest emails · kitchen food-out (AI reads it)",
  whereGoesPrivate: "BMI Office · this CRM · Daily Events board. Never the guest.",
  foodOutHelp:
    "Pulled from the notes by AI; edit to override. Synced to the kitchen board and BMI.",
  cleanupHelp:
    "Fixes spelling, punctuation and capitalisation only. Never changes names, times, headcounts or instructions. If unsure it leaves your text alone.",
  waiverHelp:
    "Racing, laser tag and gel blaster need signed waivers. Automatic 7-day and 2-day reminders go to the host.",
  attendeesFoot: "Attendees appear here as waivers are signed.",
} as const;

export const EVENT_TEST_IDS = {
  board: "crm-events-board",
  band: (date: string) => "crm-events-band-" + date,
  row: (projectId: string) => "crm-event-" + projectId,
  createLeadSheet: "crm-create-lead-from-event",
  notesTab: "crm-deal-tab-notes",
  publicNotes: "crm-public-notes",
  privateLog: "crm-private-log",
  section: (key: PrivateSectionKey) => "crm-private-section-" + key,
  foodOutSheet: "crm-food-out-sheet",
  eventTab: "crm-deal-tab-event",
} as const;
