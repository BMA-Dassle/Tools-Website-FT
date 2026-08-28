import { NextRequest, NextResponse } from "next/server";
import { verifyPortal } from "@/lib/portal-auth";
import {
  metadataGetQuerySchema,
  metadataExtractBodySchema,
  metadataManualBodySchema,
} from "~/features/daily-events/schemas";
import {
  getEventMetadata,
  extractFoodOut,
  saveManualFoodOut,
} from "~/features/daily-events/service";

export const dynamic = "force-dynamic";

/**
 * Food-out event metadata — port of the employee portal's
 * /api/integrations/event-metadata (same GET/POST/PUT contract):
 *
 * GET  ?token&locationId&projectId&date               → cached metadata (nulls when absent)
 * POST ?token&locationId&projectId&date  body: {eventName,startTime,persons,notes}
 *      → AI extraction; manual rows are never overwritten (returns cached:true)
 * PUT  body: {locationId, projectId, date, foodOutTime} → manual override
 *
 * POST/PUT fire the BMI private-note sync non-blocking (portal parity).
 */

export async function GET(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const parsed = metadataGetQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "projectId, locationId, and date are required" },
      { status: 400 },
    );
  }

  try {
    const data = await getEventMetadata(
      parsed.data.projectId,
      parsed.data.locationId,
      parsed.data.date,
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[daily-events] event-metadata GET error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  const query = metadataGetQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) {
    return NextResponse.json(
      { success: false, error: "projectId, locationId, and date are required" },
      { status: 400 },
    );
  }

  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    // empty body allowed (portal parity — extraction inputs default to blanks)
  }
  const body = metadataExtractBodySchema.safeParse(rawBody ?? {});
  if (!body.success) {
    return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });
  }

  try {
    const { data, cached } = await extractFoodOut({
      projectId: query.data.projectId,
      locationId: query.data.locationId,
      date: query.data.date,
      eventName: body.data.eventName,
      startTime: body.data.startTime,
      persons: body.data.persons,
      notes: body.data.notes,
    });
    return NextResponse.json(
      cached ? { success: true, data, cached: true } : { success: true, data },
    );
  } catch (error) {
    console.error("[daily-events] event-metadata POST error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = await verifyPortal(req);
  if (denied) return denied;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });
  }
  const body = metadataManualBodySchema.safeParse(rawBody);
  if (!body.success) {
    return NextResponse.json(
      { success: false, error: "projectId, locationId, and date are required" },
      { status: 400 },
    );
  }

  try {
    const data = await saveManualFoodOut({
      projectId: body.data.projectId,
      locationId: body.data.locationId,
      date: body.data.date,
      foodOutTime: body.data.foodOutTime ?? null,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[daily-events] event-metadata PUT error:", error);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
