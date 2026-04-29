import { NextRequest, NextResponse } from "next/server";
import { getRaceTicket, getGroupTicket } from "@/lib/race-tickets";
import { voxSend } from "@/lib/sms-retry";
import { logSms } from "@/lib/sms-log";
import { canonicalizePhone } from "@/lib/participant-contact";
import redis from "@/lib/redis";

/**
 * Deref an SMS-log shortCode (the 6-char `/s/{code}` redirect key) back to
 * the underlying ticket-id so we can load the RaceTicket / GroupTicket. The
 * shortCode ≠ ticketId — see lib/race-tickets.ts for the full story.
 */
async function resolveShortCode(
  shortCode: string,
): Promise<{ kind: "ticket" | "group"; id: string } | null> {
  try {
    const full = await redis.get(`short:${shortCode}`);
    if (!full) return null;
    const m = /\/(t|g)\/([A-Za-z0-9_-]+)\b/.exec(full);
    if (!m) return null;
    return { kind: m[1] === "g" ? "group" : "ticket", id: m[2] };
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/e-tickets/resend
 *
 * Body:
 *   {
 *     shortCode: string;        // required — ties the resend back to a ticket
 *     body: string;             // required — exact SMS body to resend
 *     overridePhone?: string;   // optional — if set, send to this instead of
 *                               //            the ticket's stored phone
 *   }
 *
 * Auth: guarded by middleware.ts (/api/admin/* path + token + IP).
 *
 * Flow:
 *   1. Load ticket by shortCode (single or group) — 404 if neither exists.
 *   2. Determine phone: overridePhone > ticket.phone (or group.phone).
 *      canonicalizePhone → 400 if invalid.
 *   3. voxSend(phone, body) — same helper the crons use.
 *   4. logSms with source="admin-resend" so audits can distinguish these
 *      from cron deliveries.
 *   5. Return { ok, status, error? }.
 *
 * The body is passed in from the UI (copied verbatim from the SMS log
 * entry that the operator clicked "Resend" on). We trust it because the
 * UI is already auth-gated — no need to reconstruct from ticket data.
 */
export async function POST(req: NextRequest) {
  let body: { shortCode?: string; body?: string; overridePhone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shortCode = (body.shortCode || "").trim();
  const smsBody = (body.body || "").trim();
  const overridePhone = body.overridePhone;

  if (!shortCode) return NextResponse.json({ error: "shortCode is required" }, { status: 400 });
  if (!smsBody) return NextResponse.json({ error: "body is required" }, { status: 400 });

  // Resolve the ticket to harvest default phone + audit fields. The
  // SMS-log shortCode is a /s/{code} redirect key, not a ticket id —
  // deref through redis first, then fetch the actual ticket record.
  const ref = await resolveShortCode(shortCode);
  const single = ref?.kind === "ticket" ? await getRaceTicket(ref.id) : null;
  const group = ref?.kind === "group" ? await getGroupTicket(ref.id) : null;
  if (!single && !group) {
    // Ticket/short-url may have expired (12h TTL). That's usually fine for
    // resends — caller supplied overridePhone explicitly. Only fail if we
    // have nothing to fall back on.
    if (!overridePhone) {
      return NextResponse.json(
        { error: "Ticket not found for that shortCode (expired?) and no overridePhone supplied" },
        { status: 404 },
      );
    }
  }

  const defaultPhone = single?.phone || group?.phone || "";
  const rawPhone = overridePhone || defaultPhone;
  const phone = canonicalizePhone(rawPhone);
  if (!phone) {
    return NextResponse.json(
      { error: `Invalid phone: ${rawPhone || "(none)"} — must be a US 10-digit or +1-prefixed number` },
      { status: 400 },
    );
  }

  // Gather audit fields from the ticket so the resend log entry matches
  // the shape of a cron-originated one.
  const sessionIds: (string | number)[] = single
    ? [single.sessionId]
    : (group?.members || []).map((m) => m.sessionId);
  const personIds: (string | number)[] = single
    ? [single.personId]
    : (group?.members || []).map((m) => m.personId);
  const memberCount = single ? 1 : (group?.members?.length || 0);

  const ts = new Date().toISOString();

  // Fire the send.
  const result = await voxSend(phone, smsBody);

  // Log regardless of success. On failure we DO NOT queueRetry — admin
  // resends should fail loudly so the operator sees the error and can
  // retry manually instead of the cron retry queue doing it silently.
  // providerMessageId lets the Vox webhook update this entry's
  // deliveryStatus when the carrier reports back (delivered /
  // undelivered / failed) — replaces the prior "we accepted" 200 with
  // the actual handset state.
  await logSms({
    ts,
    phone,
    source: "admin-resend",
    status: result.status,
    ok: result.ok,
    error: result.ok ? undefined : (result.error || "").slice(0, 500),
    body: smsBody,
    sessionIds,
    personIds,
    memberCount,
    shortCode,
    provider: result.provider,
    providerMessageId: result.voxId,
  });

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    error: result.ok ? undefined : result.error,
    sentTo: phone,
  });
}
