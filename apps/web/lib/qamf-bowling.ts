import { qamfAuthedFetch } from "@/lib/qamf-bowling-auth";
import { emailRejection, isDeliverableEmail } from "~/lib/helpers/email";

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
  | "None"
  | "Canceled"
  | "Temporary"
  | "Confirmed"
  | "Ready"
  | "Running"
  | "Completed";
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
  BookedAt: string; // ISO 8601 with offset
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
/*  Outbound field normalizers (last stop before the vendor)          */
/* ------------------------------------------------------------------ */

/**
 * Strip a guest phone down to digits before QAMF sees it.
 *
 * Our surfaces store what the guest typed, and the kiosk formats for display —
 * `(973) 518-4297`. QAMF's createReservation validated PhoneNumber and rejected
 * that shape on 2026-07-28 (alongside the BookedAt millisecond error; its exact
 * rule text was lost to a 200-char truncation, since fixed). Digits are what the
 * paths that have always worked send, so normalize here rather than at each of
 * the ~6 call sites. A leading US country code is dropped: QAMF centers are all
 * domestic and an 11-digit "1…" is the same subscriber number.
 */
export function normalizeGuestPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Clean the WHOLE Guest payload before QAMF sees it — not one field at a time.
 *
 * This used to normalize PhoneNumber only, because PhoneNumber and BookedAt were
 * the two rules that had bitten us. Email was the third field of the same object,
 * passed through untouched, and on 2026-07-28 it cost $346.12: a stray trailing
 * `@` reached `createReservation`, which 400'd with
 * `Customer.Guest.Email: "Value is not a valid Email."` after the capture.
 * Patching named fields one incident at a time guarantees a next incident, so
 * every field of Guest is handled here now.
 *
 * Whitespace is the part this layer can safely fix (a trailing space alone fails
 * .NET's email validator). A structurally invalid address is NOT repaired or
 * dropped here: `Email` is non-optional in QAMF's schema and we have not probed
 * what it does with an empty string, so silently substituting could trade one
 * post-capture failure for another. Correctness belongs to the pre-charge guard
 * in unifiedReserve (`isDeliverableEmail`); this logs loudly so that if anything
 * ever reaches the vendor invalid, the reserve_attempts row names the reason
 * instead of leaving a bare 400.
 */
export function withNormalizedGuest<
  T extends { Guest: { Name: string; PhoneNumber: string; Email: string } },
>(customer: T): T {
  const email = (customer.Guest.Email ?? "").trim().toLowerCase();
  if (email && !isDeliverableEmail(email)) {
    console.error(
      `[qamf-bowling] guest email ${JSON.stringify(email)} (${emailRejection(email)}) will likely be refused by QAMF — it should have been caught pre-charge`,
    );
  }
  return {
    ...customer,
    Guest: {
      ...customer.Guest,
      Name: (customer.Guest.Name ?? "").replace(/\s+/g, " ").trim(),
      PhoneNumber: normalizeGuestPhone(customer.Guest.PhoneNumber),
      Email: email,
    },
  };
}

/**
 * QAMF requires BookedAt seconds AND milliseconds to be zero (it 400s with
 * "Millisecond must be 0."). Truncate any sub-minute precision while preserving
 * the offset exactly as the caller sent it — the offset is what QAMF reads as
 * center-local wall clock, so it must never be rewritten here. A value we can't
 * parse is passed through untouched for the vendor to judge.
 */
export function normalizeBookedAt(bookedAt: string): string {
  // 2026-07-28T17:15:38.230Z / …-04:00 → 2026-07-28T17:15:00.230Z-less form.
  const m = bookedAt.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(.*)$/);
  if (!m) return bookedAt;
  return `${m[1]}:00${m[2]}`;
}

/* ------------------------------------------------------------------ */
/*  Internal request helper                                           */
/* ------------------------------------------------------------------ */

function commonHeaders(
  token: string,
  subscriptionKey: string,
  apiVersion: string = API_VERSION,
): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "api-version": apiVersion,
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
  /**
   * Per-call api-version override. Versioning is per-REQUEST (header), so
   * one endpoint can run a newer spec while everything else stays pinned.
   * Probed live 2026-07-11: the pinned date-string serves the v1.0-era
   * schema (Player has NO Id); "1.2" serves spec v1.2 (Player.Id present,
   * per-player DELETE available). Re-probed 2026-07-14: Conqueror is now
   * >= 15.13 and "1.3" works — PATCH /reservations/{id}/lanes reschedules
   * time and changes lanes (target lane must satisfy the web offer's Lane
   * Groups or it 409s LanesNotCompatible).
   */
  apiVersion?: string;
}): Promise<T> {
  const res = await qamfAuthedFetch(
    (token, subKey) =>
      fetch(`${BASE}${opts.path}`, {
        method: opts.method,
        headers: commonHeaders(token, subKey, opts.apiVersion),
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

/** GET /centers/{centerId}/lanes — current lane status snapshot.
 *  QAMF returns { Lanes: Lane[] } — we unwrap to a plain array. */
export async function listLanes(centerId: number): Promise<Lane[]> {
  const res = await call<{ Lanes?: Lane[] } | Lane[]>({
    method: "GET",
    path: `/centers/${centerId}/lanes`,
    errLabel: `listLanes(${centerId})`,
    centerId,
  });
  // API returns { Lanes: [...] } wrapper; fall back to bare array for safety
  if (res && !Array.isArray(res) && Array.isArray((res as { Lanes?: Lane[] }).Lanes)) {
    return (res as { Lanes: Lane[] }).Lanes;
  }
  return Array.isArray(res) ? res : [];
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
    body: {
      ...input,
      BookedAt: normalizeBookedAt(input.BookedAt),
      ...(input.Customer ? { Customer: withNormalizedGuest(input.Customer) } : {}),
    },
    errLabel: `createReservation(${centerId})`,
    centerId,
  });
}

/** GET /centers/{centerId}/reservations/{reservationId} */
export async function getReservation(
  centerId: number,
  reservationId: string,
  /** Pass "1.2" when the caller needs Player.Id (absent from the pinned
   *  version's schema); existing callers default to the pinned version. */
  apiVersion?: string,
): Promise<Reservation> {
  return call({
    method: "GET",
    path: `/centers/${centerId}/reservations/${reservationId}`,
    errLabel: `getReservation(${centerId},${reservationId})`,
    centerId,
    apiVersion,
  });
}

/** DELETE /centers/{centerId}/reservations/{reservationId} */
export async function deleteReservation(centerId: number, reservationId: string): Promise<void> {
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
    body: { Customer: withNormalizedGuest(customer) },
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

/**
 * PATCH /centers/{centerId}/reservations/{reservationId}/lanes
 *  — moves a reservation IN PLACE: new StartTime/EndTime reschedules it,
 *  a new LaneNumber (same times) reassigns the lane. Spec v1.3, live at
 *  our centers since Conqueror passed 15.13 (verified 2026-07-14), so
 *  this call pins `api-version: 1.3`.
 *
 *  Every lane on the reservation must be passed (same duration — QAMF
 *  rejects duration changes here). Lane REASSIGNMENT is constrained by
 *  the web offer's Lane Groups (409 LanesNotCompatible otherwise);
 *  time moves 409 LanesNotAvailable/WebOfferNotAvailable when the
 *  target slot can't take the block.
 *
 *  TIME FORMAT (probed live 2026-07-14): Conqueror takes the wall-clock
 *  portion of StartTime/EndTime as CENTER-LOCAL time and IGNORES the UTC
 *  offset — a Z-rendered 15:30-ET instant landed at 7:30 PM ET. Worse,
 *  the immediately-following GET echoes the requested instant; Conqueror
 *  truth only shows up in a later read. ALWAYS send center-local
 *  wall-clock with the true local offset (see toCenterLocalIso in
 *  qamf-reschedule.ts) — correct under both interpretations.
 */
export async function moveReservationLanes(
  centerId: number,
  reservationId: string,
  lanes: Array<{ Id: string; LaneNumber: number; StartTime: string; EndTime: string }>,
): Promise<void> {
  await call({
    method: "PATCH",
    path: `/centers/${centerId}/reservations/${reservationId}/lanes`,
    body: { Lanes: lanes },
    errLabel: `moveReservationLanes(${reservationId})`,
    centerId,
    apiVersion: "1.3",
  });
}

/** PATCH /centers/{centerId}/reservations/{reservationId}/expiresAt
 *  — extends the temporary 10-min hold by another 10 min */
export async function extendReservation(centerId: number, reservationId: string): Promise<void> {
  await call({
    method: "PATCH",
    path: `/centers/${centerId}/reservations/${reservationId}/expiresAt`,
    errLabel: `extendReservation(${reservationId})`,
    centerId,
  });
}

/** PATCH /centers/{centerId}/reservations/{reservationId}/lanes/{laneId}/status
 *  — transitions a lane to a new status (Confirmed ↔ Ready ↔ Running).
 *  See docs/qamf-lane-lifecycle.md for the full state machine. */
export async function setLaneStatus(
  centerId: number,
  reservationId: string,
  laneId: string,
  status: BookedLaneStatus,
): Promise<boolean> {
  try {
    await call({
      method: "PATCH",
      path: `/centers/${centerId}/reservations/${reservationId}/lanes/${laneId}/status`,
      body: { Status: status },
      errLabel: `setLaneStatus(${reservationId},${laneId},${status})`,
      centerId,
    });
    console.log(
      `[qamf-bowling] setLaneStatus(${reservationId}, lane=${laneId}): PATCH → "${status}"`,
    );
    return true;
  } catch (err) {
    console.error(
      `[qamf-bowling] setLaneStatus(${reservationId},${laneId},${status}) PATCH failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
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

/**
 * DELETE /centers/{centerId}/reservations/{reservationId}/lanes/{laneId}/players/{playerId}
 *
 * Removes ONE player from a lane's lineup — the only way to DECREASE a
 * reservation's player count via the API (the players PUT above is
 * same-count-only). Spec v1.2 (owner-supplied 2026-07-11), so this call
 * pins `api-version: 1.2` — the playerId only exists in that version's
 * GET schema. Works on reservations whose lanes haven't opened yet (no
 * check-in required — booked-for-later reservations qualify); Time
 * reservations keep their duration, Game reservations shrink theirs. 409s
 * when Conqueror considers the reservation paid (`ReservationAlreadyPaid`)
 * or the cart mixes price keys (`DifferentPriceKeyInTheCart`).
 */
export async function deleteLanePlayer(
  centerId: number,
  reservationId: string,
  laneId: string,
  playerId: string | number,
): Promise<void> {
  await call({
    method: "DELETE",
    path: `/centers/${centerId}/reservations/${reservationId}/lanes/${laneId}/players/${playerId}`,
    errLabel: `deleteLanePlayer(${reservationId},${laneId},${playerId})`,
    centerId,
    apiVersion: "1.2",
  });
}
