import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "~/features/kiosk/checkin/server";
import { lookupLicenseMatches } from "~/features/kiosk/license/lookup.server";
import type { LicenseMatch } from "~/features/kiosk/license/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/kiosk/license-lookup — find existing accounts by the last name +
 * DOB read off a scanned driver's license (kiosk sign-in without typing).
 *
 * SECURITY POSTURE (owner 2026-07-23): no device auth (kiosk-route posture,
 * same as checkin/lookup). The response carries account PII, gated on knowing
 * a person's EXACT last name AND exact date of birth — the facts printed on
 * the physical ID the guest is holding, i.e. possession-equivalent (the same
 * trust class as the checkin scan path). `phoneVerified` is never granted by
 * this path, so rewards/OTP-gated flows still re-verify. POST (not GET) so
 * name+DOB never appear in URLs or request logs; the DOB is never logged.
 * Rate-limited per IP, sized for several kiosks behind one venue NAT.
 */

export interface LicenseLookupResponse {
  ok: boolean;
  matches?: LicenseMatch[];
  error?: string;
}

const LOCATIONS = new Set(["fasttrax", "headpinz", "naples"]);

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  if (await rateLimited("license-lookup", clientIp(req), 60)) {
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "Too many lookups — try again shortly" },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "Invalid body" },
      { status: 400 },
    );
  }

  const lastName = String(body.lastName ?? "").trim();
  const dobIso = String(body.dobIso ?? "").trim();
  const firstName = String(body.firstName ?? "").trim();
  const location = String(body.location ?? "").trim();
  if (!lastName || lastName.length > 60 || !/^\d{4}-\d{2}-\d{2}$/.test(dobIso)) {
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "lastName and dobIso (YYYY-MM-DD) required" },
      { status: 400 },
    );
  }

  try {
    const matches = await lookupLicenseMatches({
      lastName,
      dobIso,
      ...(firstName ? { firstName } : {}),
      ...(LOCATIONS.has(location) ? { location } : {}),
    });
    console.log(`[license-lookup] ${matches.length} match(es)`); // no PII — count only
    return NextResponse.json<LicenseLookupResponse>({ ok: true, matches });
  } catch (err) {
    console.warn(`[license-lookup] failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "Lookup unavailable" },
      { status: 502 },
    );
  }
}
