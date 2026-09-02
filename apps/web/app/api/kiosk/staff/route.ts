import { NextRequest, NextResponse } from "next/server";
import { kioskStaffOk } from "~/features/kiosk/admin-auth";
import { buildGrid, findGridGaps } from "~/features/lane-plan/grid.server";
import {
  flattenLaneGrid,
  type StaffLaneBoard,
  type StaffLaneCenter,
} from "~/features/kiosk/staff/lanes";
import {
  FASTTRAX_QAMF_CENTER_ID,
  HEADPINZ_FM_CENTER_ID,
  HEADPINZ_NAPLES_CENTER_ID,
} from "@/lib/qamf-centers";
import { isValidLocationCode } from "~/config/intercard-centers";
import { verifyAccount } from "~/features/game-cards/data/intercard-router";
import { probeOnsite } from "~/features/game-cards/data/intercard-onsite";
import { listKioskLoads } from "~/features/game-cards/data/transactions-log";

/**
 * Kiosk STAFF API â€” the floor tools behind /kiosk/staff. PIN-gated by
 * `kioskStaffOk` (staff PIN or the admin PIN, via x-kiosk-pin) â€” a narrower
 * tier than /api/kiosk/admin, which stays admin-PIN-only.
 *
 * GET  ?action=ping                        â†’ 200 {} (the client PIN check)
 *      ?action=lanes&center=&brand=        â†’ bowling + duckpin lane boards
 *      ?action=loads&kioskId=&locationCode=&centerWide=&sinceHours=
 *                                          â†’ this kiosk's card-load ledger rows
 *      ?action=card&account=&locationCode= â†’ live balance + Intercard history
 *
 * READ-ONLY BY DESIGN â€” there is no POST. A clear-card action shipped here on
 * 2026-09-02 and was removed the same day (owner): clearing de-registers an
 * account and destroys whatever value it holds, which is not a call to put
 * behind a floor PIN on a machine guests stand at. Clearing still happens
 * where it is actually needed â€” clear-on-encode inside the load path â€” and a
 * card that genuinely must be cleared goes through Intercard's own tooling.
 *
 * The lane window is now-15min â†’ now+3h: current occupancy plus what lands
 * next. buildGrid already widens its search read internally so a session that
 * started before the window is not missed.
 */

const LANE_WINDOW_BACK_MS = 15 * 60_000;
const LANE_WINDOW_FORWARD_MS = 3 * 60 * 60_000;

/** Which QAMF houses a kiosk's venue covers. FastTrax and HeadPinz Fort Myers
 *  share one complex, so any FM kiosk shows both; Naples has one house. */
function laneCentersFor(center: string): StaffLaneCenter[] {
  if (center === "naples") {
    return [{ centerId: HEADPINZ_NAPLES_CENTER_ID, label: "HeadPinz Naples" }];
  }
  return [
    { centerId: HEADPINZ_FM_CENTER_ID, label: "HeadPinz bowling" },
    { centerId: FASTTRAX_QAMF_CENTER_ID, label: "FastTrax duckpin" },
  ];
}

export async function GET(req: NextRequest) {
  if (!kioskStaffOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    if (action === "ping") {
      // Cheap authed GET â€” verifyKioskStaffPin's target. Reaching here IS the answer.
      return NextResponse.json({ ok: true });
    }

    if (action === "lanes") {
      const center = searchParams.get("center") || "fort-myers";
      const now = Date.now();
      // Per-house isolation: buildGrid fails loudly (a silently partial grid
      // would read as free lanes), so one house's vendor error becomes an error
      // BOARD while the other still renders.
      const boards = await Promise.all(
        laneCentersFor(center).map(
          async (
            c,
          ): Promise<StaffLaneBoard | { centerId: number; label: string; error: string }> => {
            try {
              const grid = await buildGrid(
                c.centerId,
                now - LANE_WINDOW_BACK_MS,
                now + LANE_WINDOW_FORWARD_MS,
              );
              return {
                centerId: c.centerId,
                label: c.label,
                readAtMs: grid.readAtMs,
                lanes: flattenLaneGrid(grid, now),
                gaps: findGridGaps(grid, now),
              };
            } catch (err) {
              return {
                centerId: c.centerId,
                label: c.label,
                error: err instanceof Error ? err.message : "lane read failed",
              };
            }
          },
        ),
      );
      return NextResponse.json({ boards, atMs: now });
    }

    if (action === "loads") {
      const kioskId = searchParams.get("kioskId") || "";
      const locationCode = Number(searchParams.get("locationCode"));
      if (!kioskId || !isValidLocationCode(locationCode)) {
        return NextResponse.json({ error: "kioskId + locationCode required" }, { status: 400 });
      }
      const sinceHours = Math.min(Math.max(Number(searchParams.get("sinceHours")) || 24, 1), 168);
      const rows = await listKioskLoads({
        kioskId,
        locationCode,
        centerWide: searchParams.get("centerWide") === "1",
        sinceMs: Date.now() - sinceHours * 60 * 60_000,
        limit: 100,
      });
      return NextResponse.json({ rows });
    }

    if (action === "card") {
      const account = (searchParams.get("account") || "").trim();
      const locationCode = Number(searchParams.get("locationCode"));
      if (!/^\d{3,20}$/.test(account) || !isValidLocationCode(locationCode)) {
        return NextResponse.json({ error: "account + locationCode required" }, { status: 400 });
      }
      // verifyAccount carries balance AND history on either transport (the
      // router fetches the onsite history half in parallel; cloud returns both
      // from one op). probeOnsite feeds the onsite/cloud chip only, so its
      // failure degrades to "error" rather than sinking the lookup.
      const [verify, onsite] = await Promise.all([
        verifyAccount(account, locationCode),
        probeOnsite(locationCode).catch(() => ({ status: "error" as const })),
      ]);
      return NextResponse.json({
        verify,
        // null = the history read FAILED (say so); [] = genuinely no activity.
        transactions: verify.transactions ?? null,
        historyTransport: verify.transport,
        onsiteStatus: onsite.status,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Staff API error" },
      { status: 500 },
    );
  }
}
