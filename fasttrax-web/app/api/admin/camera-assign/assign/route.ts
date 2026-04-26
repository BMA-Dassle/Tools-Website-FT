import { NextRequest, NextResponse } from "next/server";
import {
  upsertCameraAssignment,
  deleteCameraAssignment,
  type CameraAssignment,
} from "@/lib/camera-assign";

/**
 * POST /api/admin/camera-assign/assign
 *
 * Body:
 *   {
 *     sessionId: string | number;
 *     personId: string | number;
 *     firstName: string;
 *     lastName: string;
 *     systemNumber: string;       // required — the base/system # from the NFC scan
 *     sessionName?: string;
 *     scheduledStart?: string;    // ISO
 *     track?: string;             // "Blue Track" | etc.
 *     raceType?: string;
 *     heatNumber?: number;
 *     assignedBy?: string;
 *   }
 *
 * Writes the primary assignment record AND the system-watch reverse
 * lookup key so the video-match cron can resolve an incoming vt3.io
 * video (keyed by video.system.name) back to the racer.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 *
 * DELETE /api/admin/camera-assign/assign?sessionId=X&personId=Y
 *   Un-assigns (used for rescans / typo corrections).
 */
export async function POST(req: NextRequest) {
  // Also accept the legacy `cameraNumber` field name so an old client
  // cached in a staff tab doesn't start 400-ing the minute this deploys.
  let body: Partial<CameraAssignment> & { cameraNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sessionId = body.sessionId;
  const personId = body.personId;
  const systemNumber = (body.systemNumber || body.cameraNumber || "").trim();
  const firstName = body.firstName || "";
  const lastName = body.lastName || "";

  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  if (!personId) return NextResponse.json({ error: "personId is required" }, { status: 400 });
  if (!systemNumber) return NextResponse.json({ error: "systemNumber is required" }, { status: 400 });

  const record: CameraAssignment = {
    sessionId,
    personId,
    firstName,
    lastName,
    systemNumber,
    assignedAt: new Date().toISOString(),
    sessionName: body.sessionName,
    scheduledStart: body.scheduledStart,
    track: body.track,
    raceType: body.raceType,
    heatNumber: body.heatNumber,
    assignedBy: body.assignedBy,
    // Contact fields captured by the client from the session
    // endpoint so the video-match cron can send notifications.
    email: body.email,
    mobilePhone: body.mobilePhone,
    homePhone: body.homePhone,
    phone: body.phone,
    acceptSmsCommercial: body.acceptSmsCommercial,
    acceptSmsScores: body.acceptSmsScores,
    // Guardian fallback for minors — forwarded by the client from
    // the session endpoint's Pandora payload. Used by the video-
    // notify path only (e-tickets stay racer-only for now).
    guardian: body.guardian,
  };

  await upsertCameraAssignment(record);

  return NextResponse.json({ ok: true, record });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const personId = searchParams.get("personId");
  if (!sessionId || !personId) {
    return NextResponse.json({ error: "sessionId and personId are required" }, { status: 400 });
  }
  await deleteCameraAssignment(sessionId, personId);
  return NextResponse.json({ ok: true });
}
