import { NextRequest, NextResponse } from "next/server";
import {
  blockSession,
  unblockSession,
  blockPerson,
  unblockPerson,
  overrideUnblockPerson,
} from "@/lib/video-block";

/**
 * POST /api/admin/camera-assign/block
 *
 * Body:
 *   { scope: "session", sessionId, block: true|false, reason? }
 *     → block/unblock every racer in this heat
 *   { scope: "person",  sessionId, personId, block: true|false, reason?, override? }
 *     → block one racer. `override: true` with `block: false` writes an
 *       explicit unblock marker that beats a session-level block (use
 *       when the heat is blocked but staff wants to release ONE racer).
 *
 * This endpoint does NOT call VT3 — the heat's videos may not have
 * arrived yet. The video-match cron picks up the block state when it
 * processes each new video and flips VT3's `disabled` flag there.
 * Video-level blocks (applied post-match from the video admin page)
 * use the separate /api/admin/videos/block endpoint, which DOES hit
 * VT3 immediately.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const scope = body?.scope;
    const sessionId = body?.sessionId;
    const personId = body?.personId;
    const block = !!body?.block;
    const override = !!body?.override;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    if (scope === "session") {
      if (block) {
        await blockSession(sessionId, { reason });
      } else {
        await unblockSession(sessionId);
      }
      return NextResponse.json({ ok: true, scope, block });
    }

    if (scope === "person") {
      if (!personId) {
        return NextResponse.json({ error: "personId required for person scope" }, { status: 400 });
      }
      if (block) {
        await blockPerson(sessionId, personId, { reason });
      } else if (override) {
        // "Heat is blocked, release this one racer" marker.
        await overrideUnblockPerson(sessionId, personId, { reason });
      } else {
        await unblockPerson(sessionId, personId);
      }
      return NextResponse.json({ ok: true, scope, block, override });
    }

    return NextResponse.json({ error: "scope must be 'session' or 'person'" }, { status: 400 });
  } catch (err) {
    console.error("[camera-assign/block]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "block failed" },
      { status: 500 },
    );
  }
}
