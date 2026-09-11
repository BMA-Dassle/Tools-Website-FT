import { NextRequest, NextResponse } from "next/server";
import {
  getContractVersions,
  getGfQuoteById,
  diffVersionsAgainstLive,
  extractContractSnapshot,
} from "@/lib/group-function-db";
import { isAdminCredential } from "@/lib/admin-request-auth";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!(await isAdminCredential(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const quoteId = Number(req.nextUrl.searchParams.get("quoteId"));
  if (!quoteId || isNaN(quoteId)) {
    return NextResponse.json({ error: "quoteId required" }, { status: 400 });
  }

  const [versions, quote] = await Promise.all([
    getContractVersions(quoteId),
    getGfQuoteById(quoteId),
  ]);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // Each row's diff runs from its own snapshot to the next one (live row for the newest),
  // which is the change its `changes` array describes — see diffVersionsAgainstLive.
  const versionsWithDiffs = diffVersionsAgainstLive(versions, extractContractSnapshot(quote)).map(
    ({ version: v, diffs }) => ({
      versionNumber: v.version_number,
      snapshot: v.snapshot,
      changes: v.changes,
      trigger: v.trigger,
      createdAt: v.created_at,
      diffs,
    }),
  );

  return NextResponse.json({ ok: true, quoteId, versions: versionsWithDiffs });
}
