/**
 * Detect whether a group event was settled the old way at the POS.
 *
 * At close-out the venue rings the event up on a Square POS check whose ticket
 * NAME starts with "BMI <event_number>" (e.g. "Bmi H1145 Angelina's 11th Bday").
 * A COMPLETED such check means the event is paid.
 *
 * Shared by:
 *   - group-square-settled-close cron — auto-complete events that have one.
 *   - legacy win-back ingest — do NOT offer a $20 "pay your balance" to someone
 *     who already paid at the venue.
 *
 * Match on the check NAME, never the amount: close-out totals routinely run lower
 * than our quote (deposit collected separately + totals drop at close), so amount
 * matching would miss real settlements.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

const DAY_MS = 86_400_000;

export interface SquareSettlementCheck {
  orderId: string;
  ticketName: string;
  totalCents: number | null;
  createdAt: string | null;
}

interface SquareOrder {
  id: string;
  state?: string;
  ticket_name?: string;
  total_money?: { amount?: number; currency?: string };
  created_at?: string;
}

/**
 * Does a POS check name start with "BMI <eventNumber>" on a word boundary?
 * Case-insensitive, whitespace-normalized. The boundary guard stops event
 * "H1145" from matching a check named "BMI H11456 …".
 */
export function ticketMatches(
  ticketName: string | undefined | null,
  eventNumber: string | null,
): boolean {
  if (!ticketName || !eventNumber) return false;
  const t = ticketName.trim().toUpperCase().replace(/\s+/g, " ");
  const en = String(eventNumber).trim().toUpperCase();
  if (!en) return false;
  const prefix = `BMI ${en}`;
  if (!t.startsWith(prefix)) return false;
  const next = t.charAt(prefix.length);
  return next === "" || !/[A-Z0-9]/.test(next);
}

/**
 * Find a COMPLETED Square check named "BMI <eventNumber>" near the event date.
 * Returns the first match (newest-first) or null. Paginates with early exit.
 * Throws on a Square API error so callers can distinguish "not found" from "lookup failed".
 */
export async function findSettlementCheck(opts: {
  locationId: string;
  eventNumber: string;
  eventMs: number;
  lookbackDays?: number;
  lookaheadDays?: number;
}): Promise<SquareSettlementCheck | null> {
  const { locationId, eventNumber, eventMs } = opts;
  const lookbackDays = opts.lookbackDays ?? 7;
  const lookaheadDays = opts.lookaheadDays ?? 21;
  const startAt = new Date(eventMs - lookbackDays * DAY_MS).toISOString();
  const endAt = new Date(eventMs + lookaheadDays * DAY_MS).toISOString();
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const res = await fetch(`${SQUARE_BASE}/orders/search`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            state_filter: { states: ["COMPLETED"] },
            date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
        },
        limit: 500,
        return_entries: false,
        ...(cursor ? { cursor } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`SearchOrders failed (${res.status}) for location ${locationId}`);
    }
    const data = await res.json();
    for (const o of (data.orders ?? []) as SquareOrder[]) {
      if (ticketMatches(o.ticket_name, eventNumber)) {
        return {
          orderId: o.id,
          ticketName: o.ticket_name as string,
          totalCents: o.total_money?.amount ?? null,
          createdAt: o.created_at ?? null,
        };
      }
    }
    cursor = data.cursor;
    if (!cursor) break;
  }
  return null;
}
