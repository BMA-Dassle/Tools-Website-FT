import { qamfAuthedFetch } from "@/lib/qamf-bowling-auth";

/**
 * Typed client for QubicaAMF Bowling Reservations API.
 *   https://api.qubicaamf.com/bowling-reservations
 *
 * This is the v2 booking surface — distinct from the legacy
 * /api/qamf bowler proxy (qcloud.qubicaamf.com/bowler) used by
 * /hp/book/bowling. We don't touch the legacy path; everything
 * here flows through `/api/qamf-v2/*` proxies on our side and
 * speaks the new REST API.
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

function commonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "api-version": API_VERSION,
    "content-type": "application/json",
  };
}

async function call<T>(opts: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  errLabel: string;
}): Promise<T> {
  const res = await qamfAuthedFetch(
    (token) =>
      fetch(`${BASE}${opts.path}`, {
        method: opts.method,
        headers: commonHeaders(token),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      }),
    opts.errLabel,
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
  });
}

/** GET /centers/{centerId}/weboffers/{id} — single web-offer detail */
export async function getWebOffer(centerId: number, id: number): Promise<WebOfferDetail> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/weboffers/${id}`,
    errLabel: `getWebOffer(${centerId},${id})`,
  });
}

/** POST /centers/{centerId}/reservations/availability/search — what
 *  web offers cover the given window + headcount? */
export interface AvailabilityFilter {
  BookedAtRange: { StartAt: string; EndAt: string };
  TotalPlayers: number;
  WebOffer?: { Services?: Service[] };
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
  });
}

/** PATCH /centers/{centerId}/reservations/{reservationId}/status */
export async function setReservationStatus(
  centerId: number,
  reservationId: string,
  status: ReservationStatus,
): Promise<void> {
  await call({
    method: "PATCH",
    path: `/centers/${centerId}/reservations/${reservationId}/status`,
    body: { Status: status },
    errLabel: `setReservationStatus(${reservationId},${status})`,
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
  });
}
