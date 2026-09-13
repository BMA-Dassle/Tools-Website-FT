import type {
  EventDetailResponse,
  EventsBoardResponse,
  FoodOutResponse,
  NotesPreviewResponse,
  NotesPrivateResponse,
  NotesPublicSaveResponse,
  NotesResponse,
  WaiversResponse,
} from "~/features/crm/events/contracts";
import type { ApiOk } from "~/features/crm/core/contracts";
import type { LeadView } from "~/features/crm/leads/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * Fetchers for the Events board and the deal's Notes / Event tabs. The KEYS
 * live in `~/features/crm/events/queries` (pure, imported by path — never the
 * sub's server barrel, which would drag the Office transport into the bundle).
 */

export type CreateLeadFromEventResponse = ApiOk<{ lead: LeadView; created: boolean }>;

function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface BoardParams {
  centre: string;
  view: string;
  date: string;
  includeCancelled: boolean;
}

export const fetchEventsBoard = (f: CrmFetch, p: BoardParams) =>
  f<EventsBoardResponse>(
    `/events${qs({
      centre: p.centre,
      view: p.view,
      date: p.date,
      cancelled: p.includeCancelled ? "1" : null,
    })}`,
  );

/** An event with no CRM lead — read straight off the BMI project. */
export const fetchEventByProject = (f: CrmFetch, projectId: string, centre: string) =>
  f<EventDetailResponse>(`/events/${encodeURIComponent(projectId)}${qs({ centre })}`);

export const fetchLeadEvent = (f: CrmFetch, publicId: string) =>
  f<EventDetailResponse>(`/leads/${encodeURIComponent(publicId)}/event`);

export const fetchNotes = (f: CrmFetch, publicId: string) =>
  f<NotesResponse>(`/leads/${encodeURIComponent(publicId)}/notes/public`);

export const previewPublicNotes = (f: CrmFetch, publicId: string, notes: string) =>
  f<NotesPreviewResponse>(`/leads/${encodeURIComponent(publicId)}/notes/public`, {
    body: { notes, preview: true },
  });

export const savePublicNotes = (f: CrmFetch, publicId: string, notes: string, clean: boolean) =>
  f<NotesPublicSaveResponse>(`/leads/${encodeURIComponent(publicId)}/notes/public`, {
    body: { notes, clean },
  });

export const appendPrivateNote = (f: CrmFetch, publicId: string, note: string) =>
  f<NotesPrivateResponse>(`/leads/${encodeURIComponent(publicId)}/notes/private`, {
    body: { note },
  });

export const saveFoodOut = (f: CrmFetch, publicId: string, foodOutTime: string | null) =>
  f<FoodOutResponse>(`/leads/${encodeURIComponent(publicId)}/food-out`, { body: { foodOutTime } });

export const sendWaiverLinks = (f: CrmFetch, publicId: string) =>
  f<WaiversResponse>(`/leads/${encodeURIComponent(publicId)}/waivers`, { body: {} });

/**
 * "Create lead from event" — the events sub's OWN route, not `POST /leads`:
 * that one mints, and this booking already exists in BMI.
 */
export const createLeadFromEventRow = (
  f: CrmFetch,
  projectId: string,
  body: Record<string, unknown>,
) => f<CreateLeadFromEventResponse>(`/events/${encodeURIComponent(projectId)}/lead`, { body });
