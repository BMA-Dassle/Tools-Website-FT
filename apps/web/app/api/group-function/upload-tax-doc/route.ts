import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getGfQuoteByShortId } from "@/lib/group-function-db";

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

  const filename = `tax-exempt/${shortId}-dr14.${ext}`;
  const blob = await put(filename, file, { access: "public" });

  return NextResponse.json({ url: blob.url });
}
