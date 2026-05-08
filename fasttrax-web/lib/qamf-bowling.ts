import { qamfAuthedFetch } from "@/lib/qamf-bowling-auth";

/**
 * Typed client for the QubicaAMF Internal API (Bowling Reservations).
 *   https://api.qubicaamf.com/bowling-reservations
 *
 * "Internal" = QubicaAMF's operator-facing reservation management
 * REST API. Distinct from the legacy /api/qamf bowler proxy
 * (qcloud.qubicaamf.com/bowler) used by /hp/book/bowling — that's
 * the public widget; this is the new direct-booking surface.
 *
 * Everything here flows through `/api/qamf-internal/*` proxies on
 * our side and speaks the new REST API.
 *
 * Auth (per QubicaAMF Overview + Guidelines V1.4):
 *   1. Bearer JWT from /oauth2/token (lib/qamf-bowling-auth.ts)
 *   2. `api-version: 2025-12-01.1.0` — pinned per spec.
 *
 * Required env vars:
 *   QAMF_BOWLING_CLIENT_ID       (handled by qamf-bowling-auth)
 *   QAMF_BOWLING_CLIENT_SECRET   (handled by qamf-bowling-auth)
 *
 * Note on 401s:
 * If every endpoint returns 401 even with a valid Bearer token, the
 * cause is QubicaAMF provisioning, not anything we send. The
 * Overview PDF requires:
 *   - Active "CMP – Business Preferred" subscription
 *   - "Bowling Reservation APIs" service added to the subscription
 *   - Conqueror X >= 15.6.0 on each managed center
 * If any of these are missing, our token mints fine (sub: BMA) but
 * downstream calls reject with 401. Coordinate with QubicaAMF to
 * verify subscription state — there is no code path around it.
 */

const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VERSION = "2025-12-01.1.0";

/* ------------------------------------------------------------------ */
/*  Types — minimal projection of the spec; expand as needed          */
/* ------------------------------------------------------------------ */

export type LaneStatus = "None" | "Open" | "Closed" | "Error";
export type BookedLaneStatus =
  | "None" | "Canceled" | "Temporary" | "Confirmed"
  | "Ready" | "Running" | "Completed";
export type ReservationStatus = "Temporary" | "Confirmed" | "Arrived" | "Completed";
export type Service = "PlayNow" | "BookForLater";
export type OpenType = "None" | "Time" | "Game" | "Unlimited";

export interface Lane {
  LaneNumber: number;
  Status: LaneStatus;
  ClosedAt?: string;
  Reservation?: { Id: string } | null;
}

export interface Player {
  Name?: string;
  ShoeSize?: string | null;
  ActivateBumpers?: boolean;
  Id?: string | null;
}

export interface BookedLane {
  Id: string;
  Status: BookedLaneStatus;
  LaneNumber: number;
  StartTime: string;
  EndTime: string;
  Players?: Player[];
}

export interface Guest {
  Name?: string | null;
  PhoneNumber?: string | null;
  Email?: string | null;
}

export interface Reservation {
  Id: string;
  Source?: string;
  CreatedAt?: string;
  BookedAt?: string;
  ExpiresAt?: string | null;
  Title?: string | null;
  Notes?: string | null;
  Status: ReservationStatus | BookedLaneStatus;
  Customer?: { ExternalId?: string; Guest?: Guest };
  WebOffer?: {
    Id: number;
    Options?: { Game?: { Id: number }[]; Unlimited?: { Id: number }[]; Time?: { Id: number }[] };
    Services?: Service[];
  };
  TotalPlayers?: number;
  GamesPerPlayer?: number;
  Lanes?: BookedLane[];
}

export interface NewReservationInput {
  BookedAt: string;          // ISO 8601 with offset
  Title: string;
  Notes?: string;
  Customer?: {
    ExternalId?: string;
    Guest: { Name: string; PhoneNumber: string; Email: string };
  };
  WebOffer: {
    Id: number;
    Options: {
      Game?: { Id: number }[];
      Unlimited?: { Id: number }[];
      Time?: { Id: number }[];
    };
    Services: Service[];
  };
  TotalPlayers: number;
  Lanes?: Array<{
    LaneNumber: number;
    Players?: Array<{ Name: string; ShoeSize?: string | null; ActivateBumpers: boolean }>;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Internal request helper                                           */
/* ------------------------------------------------------------------ */

function commonHeaders(token: string, subscriptionKey: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "api-version": API_VERSION,
    "content-type": "application/json",
  };
  if (subscriptionKey) h["Ocp-Apim-Subscription-Key"] = subscriptionKey;
  return h;
}

async function call<T>(opts: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  errLabel: string;
  centerId?: number;
}): Promise<T> {
  const res = await qamfAuthedFetch(
    (token, subKey) =>
      fetch(`${BASE}${opts.path}`, {
        method: opts.method,
        headers: commonHeaders(token, subKey),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      }),
    opts.errLabel,
    opts.centerId,
  );
  // Some endpoints return 200 with empty body (PATCH status, DELETE)
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/*  Public API methods                                                */
/* ------------------------------------------------------------------ */

/** GET /centers/{centerId}/lanes — current lane status snapshot */
export async function listLanes(centerId: number): Promise<Lane[]> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/lanes`,
    errLabel: `listLanes(${centerId})`,
    centerId,
  });
}

/** GET /centers/{centerId}/weboffers — every configured web offer */
export interface WebOfferDetail {
  Id: string | number;
  IsEnabled: boolean | string;
  Title: string;
  Description: string;
  ImageUrl?: string;
  OpenType: OpenType;
  Options: {
    Game?: { Id: string | number; GamesPerPlayer?: number }[];
    Time?: { Id: string | number; Minutes?: number }[];
    Unlimited?: { Id: string | number }[];
  };
  Services: Service[];
}
export async function listWebOffers(centerId: number): Promise<WebOfferDetail[]> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/weboffers`,
    errLabel: `listWebOffers(${centerId})`,
    centerId,
  });
}

/** GET /centers/{centerId}/weboffers/{id} — single web-offer detail */
export async function getWebOffer(centerId: number, id: number): Promise<WebOfferDetail> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/weboffers/${id}`,
    errLabel: `getWebOffer(${centerId},${id})`,
    centerId,
  });
}

/** POST /centers/{centerId}/reservations/availability/search — what
 *  web offers cover the given window + headcount? */
export interface AvailabilityFilter {
  BookedAtRange: { StartAt: string; EndAt: string };
  TotalPlayers: number;
  /** WebOffer is required by QAMF. Must include both Id and Services. */
  WebOffer: { Id?: number; Services: Service[] };
}
export interface AvailabilityResponse {
  Availabilities: Array<{
    TotalPlayers: number;
    BookedAt: string;
    WebOffer: WebOfferDetail;
  }>;
}
export async function searchAvailability(
  centerId: number,
  filter: AvailabilityFilter,
): Promise<AvailabilityResponse> {
  return call({
    method: "POST",
    path: `/centers/${centerId}/reservations/availability/search`,
    body: { Filter: filter },
    errLabel: `searchAvailability(${centerId})`,
    centerId,
  });
}

/** POST /centers/{centerId}/reservations — create a temporary
 *  reservation. Returns the new Reservation with `Id` (Xnnn). */
export async function createReservation(
  centerId: number,
  input: NewReservationInput,
): Promise<Reservation> {
  return call({
    method: "POST",
    path: `/centers/${centerId}/reservations`,
    body: input,
    errLabel: `createReservation(${centerId})`,
    centerId,
  });
}

/** GET /centers/{centerId}/reservations/{reservationId} */
export async function getReservation(
  centerId: number,
  reservationId: string,
): Promise<Reservation> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/reservations/${reservationId}`,
    errLabel: `getReservation(${centerId},${reservationId})`,
    centerId,
  });
}

/** DELETE /centers/{centerId}/reservations/{reservationId} */
export async function deleteReservation(
  centerId: number,
  reservationId: string,
): Promise<void> {
  await call({
    method: "DELETE",
    path: `/centers/${centerId}/reservations/${reservationId}`,
    errLabel: `deleteReservation(${centerId},${reservationId})`,
    centerId,
  });
}

/** PUT /centers/{centerId}/reservations/{reservationId}/customer */
export async function setReservationCustomer(
  centerId: number,
  reservationId: string,
  customer: { ExternalId?: string; Guest: { Name: string; PhoneNumber: string; Email: string } },
): Promise<void> {
  await call({
    method: "PUT",
    path: `/centers/${centerId}/reservations/${reservationId}/customer`,
    body: { Customer: customer },
    errLabel: `setReservationCustomer(${reservationId})`,
    centerId,
  });
}

/**
 * Confirm (or otherwise transition) a reservation status.
 *
 * PATCH /centers/{centerId}/reservations/{reservationId}/status
 *
 * IMPORTANT: QAMF requires a customer/person to be attached to the
 * reservation (via PUT /customer) BEFORE this call will succeed.
 * Without a person attached, QAMF accepts the PATCH with 2xx but does
 * not actually change the status.
 *
 * ALWAYS call setReservationCustomer before calling this function.
 * The caller is responsible for the prerequisite; this function trusts
 * that a 2xx response from PATCH means the transition took effect.
 *
 * Note: a verification GET was previously done here but caused false
 * negatives — QAMF propagates status changes asynchronously and the
 * GET would read stale "Temporary" state, causing spurious retries and
 * duplicate reservation creation. Removed 2026-05-08.
 */
export async function setReservationStatus(
  centerId: number,
  reservationId: string,
  status: ReservationStatus,
): Promise<boolean> {
  try {
    await call({
      method: "PATCH",
      path: `/centers/${centerId}/reservations/${reservationId}/status`,
      body: { Status: status },
      errLabel: `setReservationStatus(${reservationId},${status})`,
      centerId,
    });
    console.log(
      `[qamf-bowling] setReservationStatus(${reservationId}): PATCH accepted → "${status}"`,
    );
    return true;
  } catch (err) {
    console.error(
      `[qamf-bowling] setReservationStatus(${reservationId},${status}) PATCH failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** PATCH /centers/{centerId}/reservations/{reservationId}
 *  — updates mutable fields on a reservation (Title, Notes, Status, etc.).
 *  Used to rename the hold from "Hold (Np)" to "Guest Name (Np)" once
 *  the guest fills in their details. */
export async function patchReservation(
  centerId: number,
  reservationId: string,
  fields: { Title?: string; Notes?: string; Status?: ReservationStatus },
): Promise<void> {
  await call({
    method: "PATCH",
    path: `/centers/${centerId}/reservations/${reservationId}`,
    body: fields,
    errLabel: `patchReservation(${reservationId})`,
    centerId,
  });
}

/** PATCH /centers/{centerId}/reservations/{reservationId}/expiresAt
 *  — extends the temporary 10-min hold by another 10 min */
export async function extendReservation(
  centerId: number,
  reservationId: string,
): Promise<void> {
  await call({
    method: "PATCH",
    path: `/centers/${centerId}/reservations/${reservationId}/expiresAt`,
    errLabel: `extendReservation(${reservationId})`,
    centerId,
  });
}

/** PUT /centers/{centerId}/reservations/{reservationId}/lanes/{laneId}/players */
export async function setLanePlayers(
  centerId: number,
  reservationId: string,
  laneId: string,
  players: Array<{ Name: string; ShoeSize?: string; ActivateBumpers: boolean }>,
): Promise<void> {
  await call({
    method: "PUT",
    path: `/centers/${centerId}/reservations/${reservationId}/lanes/${laneId}/players`,
    body: { Players: players },
    errLabel: `setLanePlayers(${reservationId},${laneId})`,
    centerId,
  });
}
