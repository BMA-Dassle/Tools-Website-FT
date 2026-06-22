import { NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * GET /contract/{shortId}/pdf            — the current signed contract PDF
 * GET /contract/{shortId}/pdf?v={index}  — a previous version (signed_pdf_history[index])
 *
 * Serves the PDF through our own branded URL (the bytes are proxied, so the raw
 * Vercel Blob link is never exposed to the guest) for the contract page, BMI notes,
 * and emails. Historical versions are kept — the contract page lists them, newest first.
 */

export async function GET(req: Request, props: { params: Promise<{ shortId: string }> }) {
  const { shortId } = await props.params;
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const vParam = new URL(req.url).searchParams.get("v");
  let blobUrl: string | null = quote.signed_pdf_url;
  let versionLabel = "current";

  if (vParam !== null) {
    const history = (quote.signed_pdf_history ?? []) as Array<{ url: string }>;
    const idx = Number(vParam);
    if (!Number.isInteger(idx) || idx < 0 || idx >= history.length) {
      return NextResponse.json({ error: "No such contract version" }, { status: 404 });
    }
    blobUrl = history[idx]?.url ?? null;
    versionLabel = `v${idx + 1}`;
  }

  if (!blobUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Proxy the bytes so the address bar stays on our domain (never the blob host).
  const upstream = await fetch(blobUrl);
  if (!upstream.ok) {
    return NextResponse.json({ error: "Contract unavailable" }, { status: 502 });
  }
  const bytes = await upstream.arrayBuffer();
  const safeEvent = (quote.event_name || "contract").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeEvent}-${versionLabel}.pdf"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
