import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import redis from "@/lib/redis";
import {
  listSignageScreens,
  saveSignageScreen,
  deleteSignageScreen,
} from "~/features/signage/data/signage-screens-db";
import { recordSignageEvent } from "~/features/signage/events.server";
import { parseScreenKey, VENUE_INFO, type SignageVenue } from "~/features/signage/constants";
import { buildStartupScript, startupScriptFileName } from "~/features/signage/startup-script";
import type { ScreenConfig } from "~/features/signage/types";

/**
 * Screen management for staff.
 *
 * Token-gated on ADMIN_CAMERA_TOKEN, the same posture as the other
 * /api/admin/* boards. Unlike /api/tv/feed (which is public and carries no
 * secrets), this one WRITES screen config, so it needs the gate.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Track name → BMI/Office resource id, so the simulator can be driven by a word
 * a human will actually type. Mega is resource `-1`: on a Mega day the barrier
 * between Blue and Red comes out and the two run as one circuit.
 */
const TRACK_RESOURCE_IDS: Record<string, string> = {
  blue: "11208654",
  red: "11208660",
  mega: "-1",
};

function authed(req: NextRequest): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected) return false;
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  return token === expected;
}

/** Last-seen stamps, written by the feed on every poll. Absent = never seen or
 *  offline for 15+ minutes, which is what the admin dot reports. */
async function lastSeen(screenIds: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (screenIds.length === 0) return out;
  try {
    const values = await redis.mget(...screenIds.map((id) => `signage:seen:${id}`));
    screenIds.forEach((id, i) => {
      out[id] = values[i] ?? null;
    });
  } catch {
    screenIds.forEach((id) => {
      out[id] = null;
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Startup script for one screen, as a downloadable .bat. Generated per screen
  // so the URL inside it is already correct — the person setting up a TV should
  // never have to hand-edit a path or a screen id.
  const wantsScript = req.nextUrl.searchParams.get("script");
  if (wantsScript) {
    const screen = (await listSignageScreens()).find((s) => s.screenId === wantsScript);
    if (!screen) return NextResponse.json({ error: "unknown screen" }, { status: 404 });
    const origin = req.nextUrl.origin;
    const body = buildStartupScript({
      screenId: screen.screenId,
      name: screen.name,
      url: `${origin}/tv?screen=${encodeURIComponent(screen.screenId)}`,
    });
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${startupScriptFileName(screen.screenId)}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const screens = await listSignageScreens();
  const seen = await lastSeen(screens.map((s) => s.screenId));
  return NextResponse.json({ screens, seen }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    screenId?: string;
    venue?: string;
    screenNumber?: number;
    name?: string;
    config?: ScreenConfig;
    center?: string;
    firstName?: string;
    track?: string;
    vip?: boolean;
    birthday?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const action = body.action ?? "save";

  if (action === "delete") {
    if (!body.screenId) return NextResponse.json({ error: "screenId required" }, { status: 400 });
    await deleteSignageScreen(body.screenId);
    return NextResponse.json({ ok: true });
  }

  if (action === "test-celebration") {
    // The smoke tool: fires a real event down the real rail, so staff can
    // confirm a wall reacts without waiting for a guest to book something.
    if (!body.center) return NextResponse.json({ error: "center required" }, { status: 400 });
    await recordSignageEvent({
      id: `test-${Date.now()}`,
      kind: "booking-completed",
      center: body.center,
      firstName: body.firstName || "Test",
      activityKeys: ["bowling"],
      atMs: Date.now(),
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "simulate-scan") {
    // Pretend a racer just scanned at race check-in.
    //
    // This publishes to the SAME rail the real scan seam will use, so what a
    // screen does with a simulated scan is exactly what it will do with a real
    // one — no display-only mock that can drift from production behaviour.
    // Meant to be called from the check-in PC (or anywhere with the token)
    // while standing in front of the TVs.
    const center = body.center || "fort-myers";
    const track = (body.track || "").toLowerCase();
    const resourceId = TRACK_RESOURCE_IDS[track];
    if (track && !resourceId) {
      return NextResponse.json(
        { error: `unknown track "${track}" — use blue, red or mega` },
        { status: 400 },
      );
    }
    await recordSignageEvent({
      id: `sim-${Date.now()}`,
      kind: "racer-scanned",
      center,
      firstName: body.firstName || "Marcus",
      resourceId,
      activityKeys: ["racing"],
      vip: body.vip === true,
      birthday: body.birthday === true,
      atMs: Date.now(),
    });
    return NextResponse.json({
      ok: true,
      center,
      track: track || "any",
      resourceId: resourceId ?? null,
      birthday: body.birthday === true,
    });
  }

  if (action === "save") {
    const venue = body.venue as SignageVenue | undefined;
    const screenNumber = body.screenNumber;
    if (!venue || !VENUE_INFO[venue]) {
      return NextResponse.json({ error: "unknown venue" }, { status: 400 });
    }
    if (!Number.isInteger(screenNumber) || (screenNumber as number) < 0) {
      return NextResponse.json({ error: "screenNumber must be a whole number" }, { status: 400 });
    }
    const screenId = `${venue}:${screenNumber}`;
    if (!parseScreenKey(screenId)) {
      return NextResponse.json({ error: "invalid screen id" }, { status: 400 });
    }
    await saveSignageScreen({
      screenId,
      venue,
      center: VENUE_INFO[venue].center,
      screenNumber: screenNumber as number,
      name: (body.name ?? "").slice(0, 120),
      config: body.config ?? {},
    });
    return NextResponse.json({ ok: true, screenId });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
