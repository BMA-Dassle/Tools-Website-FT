import { NextRequest, NextResponse } from "next/server";
import { getDepositOverview } from "@/lib/pandora-deposits";

/**
 * Read a person's deposit balances from Pandora (Firebird DPS_OVERVIEW).
 *
 *   GET /api/pandora/deposits/{personId}?locationId=LAB52GY480CJF
 *
 * Upstream: GET /v2/bmi/deposits/{locationID}/{personID}
 *
 * Response: { data: DepositOverviewRow[] } — one row per deposit kind
 * the person has (or has ever had) a balance under. Empty array means
 * "no deposit rows on file" — NOT an error.
 *
 * Use cases (this is intentionally generic, not race-pack-scoped):
 *  - Race-packs sale flow: read RACE_WEEKDAY / RACE_ANYTIME balance
 *    to show "current credit" on the confirmation screen
 *  - Future "your account credits" page: list every kind they hold
 *  - Race-checkout: verify person has enough credit before redeeming
 *  - Admin dashboards: audit a person's deposit history at a glance
 *
 * No caching — balances move whenever staff or the booking flow
 * inserts a T_DEPOSIT row, and stale "you have X credits" reads can
 * mislead a customer. Cheap stored proc, hit it fresh.
 */

const ALLOWED_LOCATIONS = new Set([
  "LAB52GY480CJF", // FastTrax (default)
  "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  "PPTR5G2N0QXF7", // HeadPinz Naples
]);
const DEFAULT_LOCATION = "LAB52GY480CJF";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ personId: string }> },
) {
  const { personId } = await params;
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get("locationId") || DEFAULT_LOCATION;

  if (!personId || !/^\d+$/.test(personId)) {
    return NextResponse.json({ error: "Invalid personId" }, { status: 400 });
  }
  if (!ALLOWED_LOCATIONS.has(locationId)) {
    return NextResponse.json({ error: "Invalid locationId" }, { status: 400 });
  }

  try {
    const data = await getDepositOverview(personId, locationId);
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "deposits fetch failed";
    console.error(`[deposits] personId=${personId} loc=${locationId}: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
