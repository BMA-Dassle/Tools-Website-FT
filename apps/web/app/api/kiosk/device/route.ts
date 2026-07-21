import { NextRequest, NextResponse } from "next/server";
import { loadKioskDevice, saveKioskReaderHint } from "~/features/kiosk/data/kiosk-devices-db";

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

/**
 * Save the reader-location hint (port index / baud / USB info) for a kiosk.
 * Non-PII device layout, so NO admin PIN — the guest dispenser flow saves "where
 * I found the CRT-591" here so a fresh boot connects straight to it. Only these
 * three fields are writable, and only for an existing device row.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const kioskId = String(body.kioskId || "");
  if (!kioskId) return NextResponse.json({ error: "Missing kioskId" }, { status: 400 });
  const hint: {
    cardReaderPortIndex?: number;
    cardReaderBaud?: number;
    cardReaderPortInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  } = {};
  if (typeof body.cardReaderPortIndex === "number" && body.cardReaderPortIndex >= 0) {
    hint.cardReaderPortIndex = body.cardReaderPortIndex;
  }
  if (typeof body.cardReaderBaud === "number") hint.cardReaderBaud = body.cardReaderBaud;
  if (body.cardReaderPortInfo === null || typeof body.cardReaderPortInfo === "object") {
    hint.cardReaderPortInfo = body.cardReaderPortInfo as {
      usbVendorId?: number;
      usbProductId?: number;
    } | null;
  }
  if (Object.keys(hint).length === 0) {
    return NextResponse.json({ error: "No reader-hint fields" }, { status: 400 });
  }
  try {
    const ok = await saveKioskReaderHint(kioskId, hint);
    return NextResponse.json({ ok });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "hint save error" },
      { status: 500 },
    );
  }
}
