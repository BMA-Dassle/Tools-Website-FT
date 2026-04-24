import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * Barcode ↔ camera-number mapping. Stored as a Redis hash so we can
 * round-trip in a single call, plus a reverse-lookup string per
 * barcode for O(1) scan resolution on the camera-assign page.
 *
 *   camera-barcode:map             HASH  cameraNumber → barcode
 *   camera-barcode:by-barcode:{bc} STR   barcode → cameraNumber
 *
 * No TTL — mappings persist across race days. Cameras are physical
 * hardware, barcodes are printed on them, the pairing rarely
 * changes. Staff re-provision only when a camera is swapped.
 *
 * Auth: middleware.ts gates /api/admin/camera-assign/* on
 * ADMIN_CAMERA_TOKEN.
 */

const MAP_KEY = "camera-barcode:map";
const byBarcodeKey = (bc: string) => `camera-barcode:by-barcode:${bc}`;

export async function GET() {
  try {
    const raw = await redis.hgetall(MAP_KEY);
    return NextResponse.json(
      { mappings: raw || {} },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[barcodes GET]", err);
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const cameraNumberRaw = body?.cameraNumber;
    const barcodeRaw = typeof body?.barcode === "string" ? body.barcode.trim() : "";
    const cameraNumber = parseInt(String(cameraNumberRaw), 10);

    if (!Number.isFinite(cameraNumber) || cameraNumber < 1 || cameraNumber > 999) {
      return NextResponse.json(
        { error: "cameraNumber must be a positive integer" },
        { status: 400 },
      );
    }
    if (!barcodeRaw) {
      return NextResponse.json({ error: "barcode is required" }, { status: 400 });
    }

    // Check for barcode conflict — a barcode can only map to one camera.
    const existingCam = await redis.get(byBarcodeKey(barcodeRaw));
    if (existingCam && parseInt(existingCam, 10) !== cameraNumber) {
      return NextResponse.json(
        {
          error: `Barcode already assigned to camera ${existingCam}`,
          conflict: { barcode: barcodeRaw, existingCameraNumber: parseInt(existingCam, 10) },
        },
        { status: 409 },
      );
    }

    // If this camera already had a DIFFERENT barcode, clean up the old
    // reverse lookup so we don't leak stale mappings.
    const oldBarcode = await redis.hget(MAP_KEY, String(cameraNumber));
    if (oldBarcode && oldBarcode !== barcodeRaw) {
      await redis.del(byBarcodeKey(oldBarcode));
    }

    // Upsert both directions.
    await redis.hset(MAP_KEY, String(cameraNumber), barcodeRaw);
    await redis.set(byBarcodeKey(barcodeRaw), String(cameraNumber));

    return NextResponse.json({ ok: true, cameraNumber, barcode: barcodeRaw });
  } catch (err) {
    console.error("[barcodes POST]", err);
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const cameraNumberRaw = searchParams.get("cameraNumber");
    const cameraNumber = parseInt(cameraNumberRaw || "", 10);
    if (!Number.isFinite(cameraNumber)) {
      return NextResponse.json({ error: "cameraNumber required" }, { status: 400 });
    }
    const existingBarcode = await redis.hget(MAP_KEY, String(cameraNumber));
    if (existingBarcode) await redis.del(byBarcodeKey(existingBarcode));
    await redis.hdel(MAP_KEY, String(cameraNumber));
    return NextResponse.json({ ok: true, cameraNumber });
  } catch (err) {
    console.error("[barcodes DELETE]", err);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
