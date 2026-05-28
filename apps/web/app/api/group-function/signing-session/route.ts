import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { createSigningSession } from "@/lib/pandadoc";

/**
 * Create a PandaDoc signing session for the contract landing page.
 *
 * GET /api/group-function/signing-session?shortId=...
 *
 * Returns a session ID that the client embeds as an iframe:
 *   https://app.pandadoc.com/s/{sessionId}
 */

export async function GET(req: NextRequest) {
  const shortId = req.nextUrl.searchParams.get("shortId");
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote || !quote.pandadoc_document_id) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  if (quote.deposit_paid_at) {
    return NextResponse.json({ error: "Already paid", phase: "done" }, { status: 400 });
  }

  try {
    const session = await createSigningSession(
      quote.center_code,
      quote.pandadoc_document_id,
      quote.guest_email,
    );
    return NextResponse.json({
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[signing-session] Failed:", msg);
    return NextResponse.json(
      { error: "Failed to create signing session", detail: msg },
      { status: 500 },
    );
  }
}
