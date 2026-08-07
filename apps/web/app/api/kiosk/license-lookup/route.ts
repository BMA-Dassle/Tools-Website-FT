import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "~/features/kiosk/checkin/server";
import {
  lookupLicenseMatches,
  lookupMemberMatches,
  warmLicenseLookup,
} from "~/features/kiosk/license/lookup.server";
import { RACER_LOGIN_CODE_RE, type LicenseMatch } from "~/features/kiosk/license/types";

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
  // TWO FIELDS REACH ONE LOOKUP, AND THEY KEEP DIFFERENT GUARDS.
  //
  // `memberCode` is the SMS-Timing app's own QR. `loginCode` is a BMI
  // `person.tags[]` entry — what the wallet racing licence carries and what a
  // racer reads out at the desk. They are different secrets from different
  // places, so each is shape-checked on its own terms and then handed to the
  // same shape-agnostic lookup.
  //
  // Both classes are alphanumeric-only (or hex/UUID), deliberately: the value
  // becomes an Office token search, which also answers `LastName M/D/YYYY`, so
  // an unbounded field here would turn this unauthenticated route into a
  // person-search oracle. Nothing may key off LENGTH — real tags come in 6, 13
  // and 36-character shapes.
  const memberCode = String(body.memberCode ?? "").trim();
  const loginCode = String(body.loginCode ?? "").trim();
  const racerCode = memberCode || loginCode;
  if (racerCode) {
    const shapeOk = memberCode
      ? /^(?:[0-9a-f][0-9a-f-]{15,63}|[A-Za-z0-9]{6,32})$/i.test(memberCode)
      : RACER_LOGIN_CODE_RE.test(loginCode);
    if (!shapeOk) {
      return NextResponse.json<LicenseLookupResponse>(
        { ok: false, error: "Invalid member code" },
        { status: 400 },
      );
    }
    try {
      const matches = await lookupMemberMatches(
        racerCode,
        String(body.memberClientKey ?? "").trim() || undefined,
      );
      const via = memberCode ? "member-qr" : "login-code";
      console.log(`[license-lookup] ${via} ${matches.length} match(es)`); // no PII
      // An EMPTY result is ambiguous upstream: the Office person subsystem
      // answers `[]` — not an error — for every token while it is down (four
      // hours of it on 2026-08-03), so a real racer reads as "no account".
      // Say so in the log; the guest-facing copy can't tell the difference.
      if (matches.length === 0) {
        console.warn(`[license-lookup] ${via} resolved nobody — Office search may be degraded`);
      }
      return NextResponse.json<LicenseLookupResponse>({ ok: true, matches });
    } catch (err) {
      console.warn(
        `[license-lookup] racer code failed: ${err instanceof Error ? err.message : String(err)}`,
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
