import { NextRequest, NextResponse } from "next/server";
import { getContractVersions, diffSnapshots } from "@/lib/group-function-db";

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const quoteId = Number(req.nextUrl.searchParams.get("quoteId"));
  if (!quoteId || isNaN(quoteId)) {
    return NextResponse.json({ error: "quoteId required" }, { status: 400 });
  }

  const versions = await getContractVersions(quoteId);

  const versionsWithDiffs = versions.map((v, i) => ({
    versionNumber: v.version_number,
    snapshot: v.snapshot,
    changes: v.changes,
    trigger: v.trigger,
    createdAt: v.created_at,
    diffs: i > 0 ? diffSnapshots(versions[i - 1].snapshot, v.snapshot) : [],
  }));

  return NextResponse.json({ ok: true, quoteId, versions: versionsWithDiffs });
}
