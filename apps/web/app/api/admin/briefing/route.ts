import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { del } from "@vercel/blob";
import {
  briefingBoardStatus,
  clearRoom,
  sendBriefing,
  startBriefing,
} from "~/features/signage/briefing/service";
import {
  isBriefingAssetKey,
  parseBriefingRoom,
  parseBriefingTier,
} from "~/features/signage/briefing/types";
import { deleteSignageAsset, saveSignageAsset } from "~/features/signage/data/signage-assets-db";
import { briefingEnabled } from "~/features/signage/flags";

/**
 * Briefing rooms — the control board's API.
 *
 * A thin shell: parse, authorise, delegate to
 * ~/features/signage/briefing/service. Its own route rather than another action
 * on /api/admin/checkin (1,300 lines, and about licence scanning) or
 * /api/admin/signage (about provisioning screens) — one purpose per surface.
 *
 * Auth: middleware gates every /api/admin/* path on ADMIN_CAMERA_TOKEN. The
 * inline check repeats it because this route writes state that appears on a wall
 * in front of guests, the same reasoning as /api/admin/signage.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected) return false;
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  return token === expected;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = await briefingBoardStatus();
  return NextResponse.json(
    { ...status, enabled: briefingEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    room?: string;
    track?: string;
    sessionId?: string | number;
    heatNumber?: number;
    raceType?: string;
    tier?: string;
    assetKey?: string;
    url?: string;
    size?: number;
    durationMs?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const action = body.action ?? "";

  /* ── asset manifest ─────────────────────────────────────────────────── */

  if (action === "save-asset") {
    // The confirm-POST that lands after a direct-to-blob upload. This is what
    // makes an uploaded file the CURRENT one — see briefing-upload/route.ts for
    // why Vercel's own completion callback cannot do it here.
    if (!isBriefingAssetKey(body.assetKey)) {
      return NextResponse.json({ error: "unknown assetKey" }, { status: 400 });
    }
    const url = typeof body.url === "string" ? body.url : "";
    if (!url.startsWith("https://")) {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }
    const { replacedUrl } = await saveSignageAsset({
      key: body.assetKey,
      url,
      size: Number.isFinite(body.size) ? (body.size as number) : null,
      durationMs: Number.isFinite(body.durationMs) ? Math.round(body.durationMs as number) : null,
    });
    // The superseded film is now unreachable — nothing references it and the
    // players will prune their copies. Deleting it keeps a season of re-uploads
    // from quietly becoming a storage bill.
    if (replacedUrl) await del(replacedUrl).catch(() => {});
    return NextResponse.json({ ok: true, replaced: !!replacedUrl });
  }

  if (action === "delete-asset") {
    if (!isBriefingAssetKey(body.assetKey)) {
      return NextResponse.json({ error: "unknown assetKey" }, { status: 400 });
    }
    const removed = await deleteSignageAsset(body.assetKey);
    if (removed) await del(removed).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  /* ── room control ───────────────────────────────────────────────────── */

  // The kill switch makes a send a no-op rather than hiding the buttons: staff
  // get a clear "briefing rooms are switched off" instead of a control that
  // silently does nothing.
  if (!briefingEnabled()) {
    return NextResponse.json({ error: "briefing rooms are switched off" }, { status: 503 });
  }

  const room = parseBriefingRoom(body.room);
  if (!room) return NextResponse.json({ error: "room must be red or blue" }, { status: 400 });

  if (action === "clear") {
    return NextResponse.json(await clearRoom(room));
  }

  // Phase two of a send, and also "play it again" — the same operation either
  // way, so one action rather than two that could drift (see startBriefing).
  if (action === "start" || action === "restart") {
    const result = await startBriefing(room);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  if (action === "send") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d. Pandora session ids are
    // numeric today but BMI's id space exceeds Number.MAX_SAFE_INTEGER, and this
    // value is stored and round-tripped through JSON (house rule, CLAUDE.md).
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

    const result = await sendBriefing({
      room,
      track,
      sessionId,
      heatNumber: Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null,
      raceType: typeof body.raceType === "string" ? body.raceType : null,
      tier: parseBriefingTier(body.tier),
    });
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
