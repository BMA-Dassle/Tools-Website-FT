import { NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

/**
 * GET /contract/{shortId}/pdf — redirect to the signed contract PDF.
 *
 * Provides a stable, branded URL for signed PDFs instead of exposing
 * raw Vercel Blob URLs. Used in BMI private notes and email links.
 */

export async function GET(_req: Request, props: { params: Promise<{ shortId: string }> }) {
  const { shortId } = await props.params;
  const quote = await getGfQuoteByShortId(shortId);

  if (!quote?.signed_pdf_url) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.redirect(quote.signed_pdf_url, 302);
}
