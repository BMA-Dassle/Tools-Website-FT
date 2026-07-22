import { NextRequest, NextResponse } from "next/server";
import { listWebOffers, listLanes, type WebOfferDetail, type Lane } from "@/lib/qamf-bowling";

/**
 * Read-only liveness probe for a QubicaAMF Internal (Bowling Reservations)
 * center. Confirms our BMA credential can mint a per-center token and read
 * the center's web offers + lanes — the green light before migrating a
 * location off BMI onto QAMF.
 *
 *   GET /api/admin/qamf-internal-test/center-live?centerId=11542
 *
 * Built for the FastTrax duckpin migration (center 11542). Hitting this in
 * production (where QAMF_BOWLING_CLIENT_ID/SECRET resolve) mints + caches the
 * token for the requested center in Redis (qamf:bowling:access-token:<id>),
 * so subsequent calls — and local verification — reuse it.
 *
 * No reservation is created; this only issues GETs. Safe to call repeatedly.
 *
 * Auth: lives under /api/admin/* so middleware.ts gates it (admin-token from
 * URL or x-api-key from SALES_API_KEYS). No bespoke ?token= needed.
 */

const DEFAULT_CENTER_ID = 11542; // FastTrax

interface StepResult<T> {
  step: string;
  ok: boolean;
  data?: T;
  error?: string;
  ms: number;
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<StepResult<T>> {
  const t0 = Date.now();
  try {
    return { step: name, ok: true, data: await fn(), ms: Date.now() - t0 };
  } catch (err) {
    return {
      step: name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - t0,
    };
  }
}

function summarizeOffer(o: WebOfferDetail) {
  const opts: string[] = [];
  for (const t of o.Options?.Time ?? [])
    opts.push(`Time:${t.Id}${t.Minutes ? `(${t.Minutes}m)` : ""}`);
  for (const g of o.Options?.Game ?? [])
    opts.push(`Game:${g.Id}${g.GamesPerPlayer ? `(${g.GamesPerPlayer}g)` : ""}`);
  for (const u of o.Options?.Unlimited ?? []) opts.push(`Unlimited:${u.Id}`);
  return {
    id: o.Id,
    title: o.Title,
    enabled: o.IsEnabled === true || o.IsEnabled === "true",
    openType: o.OpenType,
    options: opts,
  };
}

export async function GET(req: NextRequest) {
  // Auth handled by middleware.ts (admin-token OR x-api-key).
  if (!process.env.QAMF_BOWLING_CLIENT_ID || !process.env.QAMF_BOWLING_CLIENT_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        blocked: "QAMF_BOWLING_CLIENT_ID / QAMF_BOWLING_CLIENT_SECRET not set",
        hint: "OAuth credentials are Vercel-only; the token mint fails without them.",
      },
      { status: 503 },
    );
  }

  const centerId = Number(req.nextUrl.searchParams.get("centerId")) || DEFAULT_CENTER_ID;

  const offers = await timed<WebOfferDetail[]>("listWebOffers", () => listWebOffers(centerId));
  const lanes = await timed<Lane[]>("listLanes", () => listLanes(centerId));

  const live = offers.ok && lanes.ok;
  return NextResponse.json({
    centerId,
    live,
    verdict: live
      ? `center ${centerId} is LIVE — token minted and configuration readable`
      : `center ${centerId} did NOT respond cleanly — see step errors`,
    offers: offers.ok
      ? {
          count: offers.data!.length,
          enabled: offers.data!.filter((o) => o.IsEnabled === true || o.IsEnabled === "true")
            .length,
          items: offers.data!.map(summarizeOffer),
        }
      : { error: offers.error, ms: offers.ms },
    lanes: lanes.ok ? { count: lanes.data!.length } : { error: lanes.error, ms: lanes.ms },
    steps: [
      {
        step: offers.step,
        ok: offers.ok,
        ms: offers.ms,
        ...(offers.error ? { error: offers.error } : {}),
      },
      {
        step: lanes.step,
        ok: lanes.ok,
        ms: lanes.ms,
        ...(lanes.error ? { error: lanes.error } : {}),
      },
    ],
  });
}
