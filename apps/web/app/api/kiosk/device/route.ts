import { NextRequest, NextResponse } from "next/server";
import { loadKioskDevice } from "~/features/kiosk/data/kiosk-devices-db";

/**
 * Boot-time device-config pull (no PII, no auth): a freshly-imaged kiosk with
 * empty localStorage fetches its previously-saved setup by kioskId
 * (`<center>:<number>`) so staff don't re-provision. Returns only device
 * settings (center/brand/variant/reader/dispenser/scanner) — never guest data.
 * Reads are harmless (device layout, not secrets); writes stay admin-PIN-gated.
 */
export async function GET(req: NextRequest) {
  const kioskId = new URL(req.url).searchParams.get("kioskId") || "";
  if (!kioskId) return NextResponse.json({ error: "Missing kioskId" }, { status: 400 });
  try {
    const row = await loadKioskDevice(kioskId);
    if (!row) return NextResponse.json({ device: null });
    return NextResponse.json({
      device: {
        center: row.center,
        brand: row.brand,
        kioskNumber: row.kioskNumber,
        config: row.config,
        updatedAt: row.updatedAt,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "device load error" },
      { status: 500 },
    );
  }
}
