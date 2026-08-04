import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "~/features/kiosk/checkin/server";
import {
  lookupLicenseMatches,
  lookupMemberMatches,
  warmLicenseLookup,
} from "~/features/kiosk/license/lookup.server";
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "Invalid body" },
      { status: 400 },
    );
  }

  // {"warm": true} — pre-fetch the Office auth token (fired when a
  // scan-capable kiosk screen mounts, so the guest's real scan is fast).
  // No PII involved; own rate bucket so warming can't starve real lookups.
  if (body.warm === true) {
    if (await rateLimited("license-warm", clientIp(req), 30)) {
      return NextResponse.json<LicenseLookupResponse>({ ok: false }, { status: 429 });
    }
    await warmLicenseLookup();
    return NextResponse.json<LicenseLookupResponse>({ ok: true });
  }

  if (await rateLimited("license-lookup", clientIp(req), 60)) {
    return NextResponse.json<LicenseLookupResponse>(
      { ok: false, error: "Too many lookups — try again shortly" },
      { status: 429 },
    );
  }

  // SMS-Timing member QR — {"memberCode": "<code>", "memberClientKey"?: "…"}.
  // The code is the member's own secret (their app's QR) — same trust class
  // as the login-code path; a foreign clientKey yields no matches.
  //
  // The code is a BMI `person.tags[]` entry and comes in two shapes: the
  // 36-char UUID the app emits, and the 6–32-char typed login code. Both are
  // real tags, both resolve uniquely and forever. Kept alphanumeric-only so a
  // `LastName M/D/YYYY` token can never turn this unauthenticated route into a
  // person-search oracle. Mirrors CODE_RE in qr-scanner/member-qr.ts.
  const memberCode = String(body.memberCode ?? "").trim();
  if (memberCode) {
    if (!/^(?:[0-9a-f][0-9a-f-]{15,63}|[A-Za-z0-9]{6,32})$/i.test(memberCode)) {
      return NextResponse.json<LicenseLookupResponse>(
        { ok: false, error: "Invalid member code" },
        { status: 400 },
      );
    }
    try {
      const matches = await lookupMemberMatches(
        memberCode,
        String(body.memberClientKey ?? "").trim() || undefined,
      );
      console.log(`[license-lookup] member-qr ${matches.length} match(es)`); // no PII
      return NextResponse.json<LicenseLookupResponse>({ ok: true, matches });
    } catch (err) {
      console.warn(
        `[license-lookup] member-qr failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NextResponse.json<LicenseLookupResponse>(
        { ok: false, error: "Lookup unavailable" },
        { status: 502 },
      );
    }
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
