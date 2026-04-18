import { randomBytes } from "crypto";
import redis from "@/lib/redis";

/**
 * Shared ticket record used by the pre-race and now-checking-in flows.
 * One ticket per (sessionId, personId) pair; both flows reuse the same id
 * so the `/t/{id}` URL is stable across the racer's journey.
 */

export interface RaceTicket {
  /** Pandora returns sessionId as string on the sessions-list endpoint and as number on the current-races endpoint — accept both. */
  sessionId: number | string;
  locationId: string;
  personId: number | string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  scheduledStart: string; // ISO
  track: string;          // "Blue" | "Red" | "Mega"
  raceType: string;       // "Starter" | "Intermediate" | "Pro"
  heatNumber: number;
  /** Optional — filled in if we can correlate to a Square reservation */
  resNumber?: string;
}

const TICKET_TTL = 60 * 60 * 12; // 12 hours
const LOOKUP_TTL = 60 * 60 * 12;

function ticketKey(id: string) {
  return `ticket:${id}`;
}

function lookupKey(sessionId: number | string, personId: number | string) {
  return `ticket:bySession:${sessionId}:${personId}`;
}

function newTicketId(): string {
  // 8-char base64url is ~48 bits — plenty for our dedup window
  return randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Reuse an existing ticket for the (sessionId, personId) pair or create a
 * new one. Returns the ticket id.
 */
export async function upsertRaceTicket(ticket: RaceTicket): Promise<string> {
  const lk = lookupKey(ticket.sessionId, ticket.personId);
  const existing = await redis.get(lk);
  if (existing) {
    // Refresh the underlying record in case anything changed (phone was added, etc.)
    await redis.set(ticketKey(existing), JSON.stringify(ticket), "EX", TICKET_TTL);
    await redis.expire(lk, LOOKUP_TTL);
    return existing;
  }
  const id = newTicketId();
  await redis.set(ticketKey(id), JSON.stringify(ticket), "EX", TICKET_TTL);
  await redis.set(lk, id, "EX", LOOKUP_TTL);
  return id;
}

export async function getRaceTicket(id: string): Promise<RaceTicket | null> {
  try {
    const raw = await redis.get(ticketKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as RaceTicket;
  } catch {
    return null;
  }
}
