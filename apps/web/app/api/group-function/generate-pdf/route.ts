import { NextRequest, NextResponse } from "next/server";
import { generateAndStorePdf } from "@/lib/contract-pdf-generate";

/**
 * Generate signed contract PDF, upload to Blob, email to guest + planner.
 *
 * POST /api/group-function/generate-pdf
 * Body: { shortId }
 *
 * Kept as a thin wrapper around generateAndStorePdf() for manual regeneration
 * and backward compatibility. The primary path is now server-side calls from
 * the deposit, resign-settle, and sign routes.
 */
export async function POST(req: NextRequest) {
  const { shortId } = (await req.json()) as { shortId: string };
  if (!shortId) return NextResponse.json({ error: "shortId required" }, { status: 400 });

  try {
    const pdfUrl = await generateAndStorePdf(shortId);
    return NextResponse.json({ ok: true, pdfUrl });
  } catch (err) {
    console.error("[generate-pdf] endpoint failed:", err);
    return NextResponse.json(
      { error: "PDF generation failed", detail: String(err) },
      { status: 500 },
    );
  }
}
