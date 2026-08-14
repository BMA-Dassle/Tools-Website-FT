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
  markRacePitted,
  overrideLaneSlot,
  sendToHolding,
} from "~/features/signage/pit/lane.server";
import { etCalledAtIso, setCalledRace } from "~/features/signage/briefing/called-override.server";
import { recordBriefingEvent } from "~/features/signage/briefing/events-db";
import { businessDayYmdET } from "@/lib/race-business-day";
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
    slot?: string;
    force?: boolean;
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

  /**
   * STAFF OVERRIDE — place a session in a lane slot, or empty it.
   *
   * Handled before the room parse, like "pitted", because it is track-keyed.
   * The occupancy guard lives in overrideLaneSlot, not here: a rule the UI
   * enforces is a rule a second tab can break.
   */
  if (action === "override") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    const slot =
      body.slot === "holding" ||
      body.slot === "racing" ||
      body.slot === "called" ||
      body.slot === "room"
        ? body.slot
        : null;
    if (!slot) {
      return NextResponse.json(
        { error: "slot must be called, room, holding or racing" },
        { status: 400 },
      );
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d — same rule as "send".
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    const heatNumber = Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null;
    const raceType = typeof body.raceType === "string" ? body.raceType : null;

    /**
     * CHECK-IN — the called record itself. Pandora owns this key normally; the
     * desk writes it only when Pandora cannot (see called-override.server.ts).
     * The event row is the audit trail, and it is action "override" rather than
     * "sent" because nobody went anywhere: a call was asserted, not performed.
     */
    if (slot === "called") {
      await setCalledRace(
        track,
        sessionId
          ? {
              trackName: track.charAt(0).toUpperCase() + track.slice(1),
              raceType,
              heatNumber,
              scheduledStart: null,
              calledAt: etCalledAtIso(),
              sessionId: Number(sessionId),
            }
          : null,
      );
      if (sessionId) {
        await recordBriefingEvent({
          venue: "FT",
          businessDay: businessDayYmdET(),
          room: parseBriefingRoom(body.room) ?? "red",
          track,
          sessionId,
          heatNumber,
          raceType,
          tier: null,
          action: "override",
          reason: "override",
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true });
    }

    /**
     * BRIEFING — placing into a room reuses the ordinary send, so the room gets
     * its film, its assignment row and its briefed marker exactly as it would
     * have; clearing reuses Undo. An override that took a private path would be
     * an override whose result did not behave like the real thing.
     */
    if (slot === "room") {
      const target = parseBriefingRoom(body.room);
      if (!target) {
        return NextResponse.json({ error: "room must be red or blue" }, { status: 400 });
      }
      if (!sessionId) return NextResponse.json(await clearRoom(target));
      const result = await sendBriefing({
        room: target,
        track,
        sessionId,
        heatNumber,
        raceType,
        tier: null,
      });
      return NextResponse.json(result);
    }

    const result = await overrideLaneSlot({
      track,
      slot,
      // No sessionId means "empty this slot" — the way a mis-placed group is
      // taken back out before the right one goes in.
      occupant: sessionId
        ? { sessionId, heatNumber, raceType, room: parseBriefingRoom(body.room) }
        : null,
      force: body.force === true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  /**
   * "RACE RETURNED" — the pit lane's release (owner 2026-08-13). Track-keyed,
   * not room-keyed, so it is handled before the room parse below: the press
   * says the finished race's karts are fully back in the lane, and it is the
   * ONLY thing that ends the pit board's hold.
   */
  if (action === "pitted") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    const result = await markRacePitted(track);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  const room = parseBriefingRoom(body.room);
  if (!room) return NextResponse.json({ error: "room must be red or blue" }, { status: 400 });

  if (action === "clear") {
    return NextResponse.json(await clearRoom(room));
  }

  /**
   * "SEND TO HOLDING" — the step after the briefing (owner 2026-08-13). The
   * group leaves the room for the pit seats: the room's occupancy closes in
   * the insurance log, the room frees for the returning race, and the pit
   * board's rail flips to its seat state. Same body shape as "send".
   */
  if (action === "send-holding") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d — same rule as "send".
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    const result = await sendToHolding({
      room,
      track,
      sessionId,
      heatNumber: Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null,
      raceType: typeof body.raceType === "string" ? body.raceType : null,
    });
    return NextResponse.json(result);
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
