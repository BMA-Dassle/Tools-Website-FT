/**
 * Client fetch layer — mirrors the portal's smsTimingService /
 * websitePaymentService / event-metadata fetches, pointed at the website's
 * /api/admin/daily-events/* routes. Every call carries the admin token in
 * the query string (reservations-board pattern; works identically on the
 * tokened page and the HMAC-gated embed).
 */
import type {
  Reservation,
  ReservationDetail,
  ReservationsResponse,
  WebsitePaymentInfo,
  EventMetadata,
} from "./types";

const BASE = "/api/admin/daily-events";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  }
  return data as T;
}

// ── Reservations (portal smsTimingService) ───────────────────────────

export async function fetchDayReservations(
  token: string,
  date: string,
  locationId: number,
): Promise<ReservationsResponse> {
  const data = await getJson<{ data: ReservationsResponse }>(
    `${BASE}/reservations?token=${encodeURIComponent(token)}&locationId=${locationId}&date=${date}`,
  );
  return data.data;
}

export async function fetchReservationDetail(
  token: string,
  projectId: string,
  locationId: number,
): Promise<ReservationDetail> {
  const data = await getJson<{ data: ReservationDetail }>(
    `${BASE}/reservations/${encodeURIComponent(projectId)}?token=${encodeURIComponent(token)}&locationId=${locationId}`,
  );
  return data.data;
}

// ── Website payments (portal websitePaymentService, session-cached) ──
//
// Display keys stay `r.number || r.id` (portal parity), but the server
// looks quotes up by BMI projectId (`r.id`) — group_function_quotes stores
// projectIds; the portal reached the same rows via its sales_prospects
// translation table.

const paymentCache = new Map<string, WebsitePaymentInfo | null>();

export async function getPaymentsBulk(
  token: string,
  reservations: Pick<Reservation, "id" | "number">[],
): Promise<Map<string, WebsitePaymentInfo>> {
  const map = new Map<string, WebsitePaymentInfo>();
  const displayKeyById = new Map<string, string>();
  for (const r of reservations) {
    if (!r.id) continue;
    displayKeyById.set(r.id, r.number || r.id);
  }

  const uncachedIds: string[] = [];
  for (const [id, displayKey] of displayKeyById) {
    if (paymentCache.has(id)) {
      const cached = paymentCache.get(id);
      if (cached) map.set(displayKey, cached);
    } else {
      uncachedIds.push(id);
    }
  }

  if (uncachedIds.length > 0) {
    // Chunk below the server's MAX_CODES cap (60) — a busy week can exceed
    // it, and ids the server silently truncated must never be
    // negative-cached as "no payment".
    const CHUNK = 50;
    const chunks: string[][] = [];
    for (let i = 0; i < uncachedIds.length; i += CHUNK) {
      chunks.push(uncachedIds.slice(i, i + CHUNK));
    }
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const resp = await getJson<{ results: Record<string, WebsitePaymentInfo> }>(
            `${BASE}/payments?token=${encodeURIComponent(token)}&bmiCodes=${encodeURIComponent(chunk.join(","))}`,
          );
          for (const [id, info] of Object.entries(resp.results || {})) {
            paymentCache.set(id, info);
            const displayKey = displayKeyById.get(id);
            if (displayKey) map.set(displayKey, info);
          }
          // Only ids this chunk actually asked about may be negative-cached
          for (const id of chunk) {
            if (!paymentCache.has(id)) paymentCache.set(id, null);
          }
        } catch {
          // chunk errored — silently degrade, leave its ids uncached (portal parity)
        }
      }),
    );
  }

  return map;
}

/** Single lookup for the detail view — by projectId. */
export async function getPayment(
  token: string,
  projectId: string,
): Promise<WebsitePaymentInfo | null> {
  if (paymentCache.has(projectId)) return paymentCache.get(projectId) || null;
  try {
    const resp = await getJson<{ result: WebsitePaymentInfo | null }>(
      `${BASE}/payments?token=${encodeURIComponent(token)}&bmiCode=${encodeURIComponent(projectId)}`,
    );
    const result = resp.result || null;
    paymentCache.set(projectId, result);
    return result;
  } catch {
    return null;
  }
}

export function clearPaymentCache(): void {
  paymentCache.clear();
}

// ── Event metadata (portal EventMetadataPanel fetches) ───────────────

export async function fetchEventMetadata(
  token: string,
  projectId: string,
  locationId: number,
  date: string,
): Promise<EventMetadata> {
  const data = await getJson<{ data: EventMetadata }>(
    `${BASE}/event-metadata?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}&locationId=${locationId}&date=${date}`,
  );
  return data.data;
}

export async function extractEventMetadata(
  token: string,
  projectId: string,
  locationId: number,
  date: string,
  body: { eventName: string; startTime: string; persons: number; notes: string },
): Promise<EventMetadata> {
  const res = await fetch(
    `${BASE}/event-metadata?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}&locationId=${locationId}&date=${date}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `AI extraction failed (${res.status})`);
  }
  return data.data as EventMetadata;
}

export async function saveEventMetadata(
  token: string,
  projectId: string,
  locationId: number,
  date: string,
  foodOutTime: string | null,
): Promise<EventMetadata> {
  const res = await fetch(`${BASE}/event-metadata?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, locationId, date, foodOutTime }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `Failed to save (${res.status})`);
  }
  return data.data as EventMetadata;
}
