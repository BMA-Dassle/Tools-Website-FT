import { NextRequest, NextResponse } from "next/server";
import { deleteActivity } from "@/lib/teams-bot";

/**
 * POST /api/teams/dev-delete
 *
 * Dev-only helper for removing a Teams Adaptive Card activity — used for
 * cleaning up test posts after end-to-end verification. Gated on a header
 * secret so it can't be called from production without intent.
 *
 * Body:
 *   { conversationId: "19:...@thread.v2", activityId: "1776..." }
 *
 * Header:
 *   x-dev-secret: <PORTAL_FORWARD_SECRET>
 */
export async function POST(req: NextRequest) {
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-dev-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { conversationId?: string; activityId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.conversationId || !body.activityId) {
    return NextResponse.json(
      { error: "conversationId + activityId required" },
      { status: 400 },
    );
  }

  const result = await deleteActivity(body.conversationId, body.activityId);
  return NextResponse.json(result);
}
