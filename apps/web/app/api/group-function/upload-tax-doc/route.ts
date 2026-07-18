import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getGfQuoteByShortId, appendAuditLog } from "@/lib/group-function-db";
import { sql } from "@/lib/db";

/**
 * Upload DR-14 tax exempt letter to Vercel Blob.
 *
 * POST /api/group-function/upload-tax-doc
 * Body: FormData with "file" and "shortId"
 */

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const shortId = form.get("shortId") as string | null;

  if (!file || !shortId) {
    return NextResponse.json({ error: "file and shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
  if (!["pdf", "jpg", "jpeg", "png"].includes(ext)) {
    return NextResponse.json({ error: "Only PDF, JPG, or PNG files accepted" }, { status: 400 });
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File must be under 10MB" }, { status: 400 });
  }

  // allowOverwrite: the path is deterministic per quote, so any re-upload
  // (retry, replacement doc, page refresh) targets an existing blob and
  // @vercel/blob v2 throws without it.
  const filename = `tax-exempt/${shortId}-dr14.${ext}`;
  try {
    const blob = await put(filename, file, { access: "public", allowOverwrite: true });

    // Serve via the brand domain (next.config /tax-exempt/* rewrite), not the
    // raw blob-store hostname.
    const docUrl = `${quote.base_url || "https://headpinz.com"}/${blob.pathname}`;

    // Persist at capture — the doc must survive even if the guest never
    // completes signing (sign/route.ts re-stamps it later).
    const q = sql();
    await q`
      UPDATE group_function_quotes SET
        tax_file_url = ${docUrl},
        updated_at = NOW()
      WHERE id = ${quote.id}
    `;
    appendAuditLog({
      quoteId: quote.id,
      event: "tax_doc_uploaded",
      metadata: { url: docUrl, originalName: file.name, size: file.size },
    }).catch(() => {});

    return NextResponse.json({ url: docUrl });
  } catch (err) {
    console.error(`[upload-tax-doc] blob put failed for ${shortId}:`, err);
    return NextResponse.json(
      { error: "Upload failed. Please try again or contact us." },
      { status: 500 },
    );
  }
}
