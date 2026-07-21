import { NextRequest, NextResponse } from "next/server";
import { kioskAdminOk } from "~/features/kiosk/admin-auth";
import {
  loadKioskDevice,
  saveKioskDevice,
  listKioskDevices,
} from "~/features/kiosk/data/kiosk-devices-db";
import {
  listReaders,
  createDeviceCode,
  createTerminalCheckout,
  dismissTerminalCheckout,
  squareLocationId,
} from "~/features/kiosk/service/square-terminal";
import { addDeposit, DEPOSIT_KIND } from "@/lib/pandora-deposits";

/**
 * Kiosk admin API — staff device provisioning + comps. PIN-gated
 * (KIOSK_ADMIN_PIN via x-kiosk-admin-pin). Every action is server-side; the
 * kiosk admin screen is the only client.
 *
 * GET  ?action=config&kioskId=…          → saved Neon config (fallback pull)
 *      ?action=readers&center=&brand=     → paired Square readers (picker)
 *      ?action=devices                    → all provisioned kiosks (overview)
 * POST { action:"save-config", ...cfg }   → upsert config to Neon
 *      { action:"pair-reader", center, brand } → new device code to pair a reader
 *      { action:"reader-test", deviceId } → wake a reader with a $1 test checkout
 *                                            (autocomplete off) → { checkoutId }
 *      { action:"reader-test-cancel", checkoutId } → dismiss the test checkout
 *      { action:"comp", personId, kind, amount } → add a comp deposit
 */

export async function GET(req: NextRequest) {
  if (!kioskAdminOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    if (action === "config") {
      const kioskId = searchParams.get("kioskId") || "";
      if (!kioskId) return NextResponse.json({ error: "Missing kioskId" }, { status: 400 });
      const row = await loadKioskDevice(kioskId);
      return NextResponse.json({ device: row });
    }
    if (action === "readers") {
      const center = searchParams.get("center") || "fort-myers";
      const brand = searchParams.get("brand") || "fasttrax";
      const readers = await listReaders(squareLocationId(center, brand));
      return NextResponse.json({ readers });
    }
    if (action === "devices") {
      return NextResponse.json({ devices: await listKioskDevices() });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Admin error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!kioskAdminOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    if (action === "save-config") {
      const center = String(body.center || "");
      const brand = String(body.brand || "");
      const kioskNumber = Number(body.kioskNumber || 1);
      const config = (body.config as Record<string, unknown>) || {};
      if (!center || !brand) {
        return NextResponse.json({ error: "center + brand required" }, { status: 400 });
      }
      // Key by venue slug (FT / HPFM / HPN) + number — the same identity the
      // launch URL carries. The slug distinguishes FastTrax-FM from HeadPinz-FM
      // (both center `fort-myers`), so they no longer clobber one cloud row.
      const slug = center === "naples" ? "HPN" : brand === "headpinz" ? "HPFM" : "FT";
      const kioskId = `${slug}:${kioskNumber}`;
      await saveKioskDevice({ kioskId, center, kioskNumber, brand, config });
      return NextResponse.json({ ok: true, kioskId });
    }

    if (action === "pair-reader") {
      const center = String(body.center || "fort-myers");
      const brand = String(body.brand || "fasttrax");
      const name = String(body.name || `Kiosk ${center}`);
      const code = await createDeviceCode(squareLocationId(center, brand), name);
      if (!code) return NextResponse.json({ error: "Square not configured" }, { status: 500 });
      return NextResponse.json({ pairing: code });
    }

    if (action === "reader-test") {
      // Push a live checkout to the physical reader so staff can SEE it wake
      // (Ping only asks Square if it's paired). autocomplete:false → an
      // accidental tap before cancel is an uncaptured auth the cancel voids.
      const deviceId = String(body.deviceId || "");
      if (!deviceId) return NextResponse.json({ error: "deviceId required" }, { status: 400 });
      const result = await createTerminalCheckout({
        deviceId,
        amountCents: 100,
        referenceId: "reader-test",
        note: "Reader test — cancel me (no charge)",
        autocomplete: false,
      });
      if (!result) return NextResponse.json({ error: "Square not configured" }, { status: 500 });
      return NextResponse.json({ ok: true, checkoutId: result.checkoutId, status: result.status });
    }

    if (action === "reader-test-cancel") {
      const checkoutId = String(body.checkoutId || "");
      if (!checkoutId) return NextResponse.json({ error: "checkoutId required" }, { status: 400 });
      const ok = await dismissTerminalCheckout(checkoutId);
      return NextResponse.json({ ok });
    }

    if (action === "comp") {
      // Add a comp deposit (race credits) to a signed-in person. Uses the same
      // Pandora addDeposit rail as booking credits. Game-token comps route
      // through the Intercard bridge (stage 9) once it lands.
      const personId = String(body.personId || "");
      const amount = Number(body.amount || 0);
      const kind = String(body.kind || DEPOSIT_KIND.RACE_COMP);
      if (!personId || !amount) {
        return NextResponse.json({ error: "personId + non-zero amount required" }, { status: 400 });
      }
      const depositId = await addDeposit({ personId, depositKindId: kind, amount });
      return NextResponse.json({ ok: true, depositId });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Admin error" },
      { status: 500 },
    );
  }
}
