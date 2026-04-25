import { NextRequest, NextResponse } from "next/server";
import { listRecentVideos } from "@/lib/vt3";
import { getMatchByVideoCode, updateVideoMatch } from "@/lib/video-match";

/**
 * GET  /api/admin/videos/refresh?videoCode=XXX
 *   Read-only — fetches VT3's live data for a given video code by
 *   pulling the most recent 500 from the FastTrax site, finding the
 *   match, and returning both the raw VT3 record and our stored
 *   record side-by-side. Helps debug "why does our admin show X but
 *   VT3 shows Y" mismatches (e.g., stale unlockTime / purchaseType).
 *
 * POST /api/admin/videos/refresh?videoCode=XXX
 *   Re-applies the live VT3 overlay onto the stored match record.
 *   Useful when the cron's 200-record fetch window has scrolled past
 *   an older video and stale fields linger. Returns the diff.
 *
 * Auth: middleware gates /api/admin/videos/* on ADMIN_CAMERA_TOKEN.
 */

const VT3_SITE_ID = parseInt(process.env.VT3_SITE_ID || "992", 10);

async function findInVt3(videoCode: string) {
  // Pull a wider-than-cron window so older videos can be inspected
  // even after they've scrolled off the cron's lastSeenId cursor.
  const videos = await listRecentVideos({ siteId: VT3_SITE_ID, limit: 500 });
  return videos.find((v) => v.code === videoCode) || null;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("videoCode") || "";
    if (!code) {
      return NextResponse.json({ error: "videoCode required" }, { status: 400 });
    }
    const [vt3Record, ourMatch] = await Promise.all([
      findInVt3(code).catch((e) => ({ error: e instanceof Error ? e.message : "vt3 fetch failed" })),
      getMatchByVideoCode(code).catch(() => null),
    ]);
    return NextResponse.json({
      videoCode: code,
      vt3: vt3Record,
      ours: ourMatch,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "refresh fetch failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("videoCode") || "";
    if (!code) {
      return NextResponse.json({ error: "videoCode required" }, { status: 400 });
    }
    const vt3Record = await findInVt3(code);
    if (!vt3Record) {
      return NextResponse.json({ error: `videoCode ${code} not found in VT3 latest 500` }, { status: 404 });
    }
    const existing = await getMatchByVideoCode(code);
    if (!existing) {
      return NextResponse.json({ error: `no match record for ${code}` }, { status: 404 });
    }

    // Capture the before snapshot for the diff response.
    const before = {
      viewed: existing.viewed,
      firstViewedAt: existing.firstViewedAt,
      lastViewedAt: existing.lastViewedAt,
      purchased: existing.purchased,
      purchaseType: existing.purchaseType,
      unlockedAt: existing.unlockedAt,
    };

    // Same overlay derivation as the cron — keep the two in lockstep
    // so a refresh produces the exact state the next cron tick would.
    const viewed =
      !!vt3Record.hasVideoPageImpression ||
      !!vt3Record.hasMediaCentreImpression ||
      !!vt3Record.firstImpressionAt;
    const unlockedAt = vt3Record.unlockTime || undefined;
    const purchased = !!unlockedAt;

    existing.viewed = viewed || undefined;
    existing.firstViewedAt = vt3Record.firstImpressionAt || undefined;
    existing.lastViewedAt = vt3Record.lastImpressionAt || undefined;
    existing.purchased = purchased || undefined;
    existing.purchaseType = vt3Record.purchaseType || undefined;
    existing.unlockedAt = unlockedAt;

    await updateVideoMatch(existing);

    return NextResponse.json({
      ok: true,
      videoCode: code,
      before,
      after: {
        viewed: existing.viewed,
        firstViewedAt: existing.firstViewedAt,
        lastViewedAt: existing.lastViewedAt,
        purchased: existing.purchased,
        purchaseType: existing.purchaseType,
        unlockedAt: existing.unlockedAt,
      },
      vt3Raw: {
        unlockTime: vt3Record.unlockTime,
        purchaseType: vt3Record.purchaseType,
        firstImpressionAt: vt3Record.firstImpressionAt,
        lastImpressionAt: vt3Record.lastImpressionAt,
        hasVideoPageImpression: vt3Record.hasVideoPageImpression,
        hasMediaCentreImpression: vt3Record.hasMediaCentreImpression,
        status: vt3Record.status,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "refresh failed" },
      { status: 500 },
    );
  }
}
