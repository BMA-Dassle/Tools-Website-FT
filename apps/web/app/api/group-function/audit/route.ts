import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId, appendAuditLog } from "@/lib/group-function-db";

/**
 * Append an audit log entry from the client.
 *
 * POST /api/group-function/audit
 * Body: { shortId, event, metadata? }
 *
 * NOTE: re-sign completion no longer flips status here — the contract page calls
 * /api/group-function/resign-settle, which restores status (deposit_paid or
 * balance_charged) and settles any re-price delta. See that route.
 */

export async function POST(req: NextRequest) {
  const { shortId, event, metadata } = (await req.json()) as {
    shortId: string;
    event: string;
    metadata?: Record<string, unknown>;
  };

  if (!shortId || !event) {
    return NextResponse.json({ error: "shortId and event required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  await appendAuditLog({
    quoteId: quote.id,
    event,
    actorEmail: quote.guest_email,
    actorIp: ip,
    actorUa: ua,
    metadata,
  });

  return NextResponse.json({ ok: true });
}
