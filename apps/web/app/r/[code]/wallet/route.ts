import { NextRequest, NextResponse } from "next/server";
import { walletPlatformFromUserAgent } from "~/features/game-cards/wallet/platform";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";
import { issueLicencePass } from "~/features/racing/wallet/licence-pass";
import { buildLicenceMeta } from "~/features/racing/wallet/licence-meta";
import { RACER_LOGIN_CODE_RE } from "~/features/kiosk/license/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /r/{loginCode}/wallet — Add the FastTrax Racing Licence to a wallet.
 *
 * ISSUED LAZILY, ON THE TAP. A member record bills EVERY MONTH it exists, so
 * pre-issuing across the racer table would bill us forever for people who came
 * once in 2023. Only a racer who actually asks gets one — which also
 * self-selects the frequent guests the pass is worth holding for.
 *
 * Idempotent: `externalId` is the BMI personId and a duplicate answers 409, so a
 * double-tap recovers the existing pass instead of minting a second billed
 * record. That is a stronger requirement here than for a voucher, where a
 * duplicate would only ever be a one-off charge.
 *
 * UNAUTHENTICATED by design, same posture as `/v/{code}/wallet`: possession of
 * the login code is the identity, which is the bar the kiosk sign-in has applied
 * since 2026-07-23. The code is shape-checked before any I/O because it becomes
 * an Office search TOKEN — that search answers other shapes too (a
 * `LastName M/D/YYYY` token finds people by birthday), so an unbounded value
 * here would be a person-search oracle.
 *
 * Every failure path lands on `/book/race?code=…`, the returning-racer sign-in,
 * so a racer holding a real code is never left at a dead end.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code: raw } = await params;
  const code = String(raw ?? "").trim();

  const fallback = () =>
    NextResponse.redirect(
      new URL(`/book/race${code ? `?code=${encodeURIComponent(code)}` : ""}`, req.url),
    );

  if (!RACER_LOGIN_CODE_RE.test(code)) return fallback();

  const matches = await lookupMemberMatches(code).catch(() => null);
  // Exactly one, deliberately. A code resolving to several records means we
  // cannot tell which human is holding the phone, and issuing a monthly-billed
  // pass against a guess is not a recoverable mistake.
  if (!matches || matches.length !== 1) return fallback();
  const m = matches[0];

  const result = await issueLicencePass({
    personId: m.personId,
    // FULL metaData, built by the same helper the e-ticket route uses — the
    // template binds eleven fields and an absent key renders as a blank on the
    // pass. No heat here: a kiosk sign-in knows the racer, not their race, so
    // the pre-race cron fills those three within two minutes.
    meta: await buildLicenceMeta({
      personId: String(m.personId),
      code,
      fullName: m.fullName,
      races: m.races,
      memberships: m.memberships,
      lastVisit: m.lastSeen,
    }),
  });
  if (!result.ok || !result.urls) return fallback();

  // `?platform=` wins over sniffing: a racer tapping "Google Wallet" on an
  // iPhone means it, and second-guessing them would hand over the wrong file.
  const stated = req.nextUrl.searchParams.get("platform");
  const platform =
    stated === "apple" || stated === "google"
      ? stated
      : walletPlatformFromUserAgent(req.headers.get("user-agent"));

  const target =
    platform === "apple"
      ? result.urls.apple
      : platform === "google"
        ? result.urls.google
        : result.urls.landing;

  return NextResponse.redirect(target, {
    // Pass content changes as the racer's next race does — never let a CDN or
    // the browser cache this hop.
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

