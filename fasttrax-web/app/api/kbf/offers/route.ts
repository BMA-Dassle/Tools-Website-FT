import { NextRequest, NextResponse } from "next/server";
import {
  isKbfBookableDate,
  isKbfBookableTime,
  kbfBookableReason,
} from "@/lib/kbf-schedule";

/**
 * GET /api/kbf/offers?center={centerId}&date={ymd}&players={N}
 *
 * Server-side proxy to QAMF /offers-availability that:
 *   - Enforces the schedule gate (Mon–Fri only, before 5pm Fri,
 *     program-start floor, 2-day rolling window).
 *   - Filters the QAMF response to only the configured KBF web
 *     offers per center (Regular vs VIP).
 *   - Drops any returned slots that fall outside the Friday-5pm
 *     cutoff (defense in depth — QAMF doesn't know our gate).
 *
 * Response: { offers: KbfOffer[], gateReason?: string }
 */

const QAMF_BASE = "https://qcloud.qubicaamf.com/bowler";
const QAMF_SUBSCRIPTION_KEY =
  process.env.QAMF_SUBSCRIPTION_KEY || "93108f56-0825-4030-b85f-bc6a69fa502c";

/** Center → display location key. The IDs come from the existing
 *  bowling flow's LOCATIONS table. */
const CENTER_TO_LOCATION: Record<string, "fortmyers" | "naples"> = {
  "9172": "fortmyers",
  "3148": "naples",
};

/**
 * Per-center KBF offer IDs.
 *
 * Defaults baked in (verified against QAMF /offers-availability):
 *   Fort Myers — 150 = "Kids Bowl Free Regular", 151 = "Kids Bowl Free VIP"
 *   Naples     — 116 + 117 (both come back labeled "Kids Bowl Free
 *                Regular" in QAMF's admin — label typo on their side;
 *                one is functionally Regular, the other VIP)
 *
 * Env vars `KBF_WEBOFFER_{REGULAR,VIP}_{FORTMYERS,NAPLES}` override
 * the defaults if set (comma- or space-separated for multi-tariff
 * centers). Leaving them unset is the supported common case.
 */
const KBF_OFFER_DEFAULTS: Record<string, number[]> = {
  "9172": [150, 151],
  "3148": [116, 117],
};

function kbfOfferIdsFor(centerId: string): Set<number> {
  const ids = new Set<number>();
  const loc = CENTER_TO_LOCATION[centerId];
  if (!loc) return ids;
  const envKeys =
    loc === "fortmyers"
      ? ["KBF_WEBOFFER_REGULAR_FORTMYERS", "KBF_WEBOFFER_VIP_FORTMYERS"]
      : ["KBF_WEBOFFER_REGULAR_NAPLES", "KBF_WEBOFFER_VIP_NAPLES"];
  let envSet = false;
  for (const k of envKeys) {
    const raw = process.env[k] || "";
    for (const part of raw.split(/[,\s]+/)) {
      const n = parseInt(part, 10);
      if (Number.isFinite(n)) {
        ids.add(n);
        envSet = true;
      }
    }
  }
  // Fall back to baked-in defaults if no env override provided.
  if (!envSet) {
    for (const id of KBF_OFFER_DEFAULTS[centerId] ?? []) ids.add(id);
  }
  return ids;
}

/**
 * QAMF /offers-availability response shape.
 *
 * Each Offer has an Items[] of bookable (tariff, slot) tuples — there
 * is NO separate Tariffs[] / ReservationOptions[] split on this
 * endpoint. ItemId is what we pass as WebOfferTariffId on book-for-later.
 *
 * Same shape the bowling page consumes (see app/hp/book/bowling/page.tsx
 * `interface OfferItem`).
 */
interface QamfOfferItem {
  ItemId: number;
  Quantity: number;
  QuantityType: string;     // "Games" | "Minutes"
  Time: string;             // "17:00" — HH:MM ET local
  Total: number;            // price in dollars
  Remaining: number;        // open lanes
  Lanes: number;
  Reason?: string;
}

interface QamfOffer {
  OfferId: number;
  Name: string;
  Description?: string;
  ImageUrl?: string;
  Items?: QamfOfferItem[];
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const centerId = sp.get("center") || "";
    const date = sp.get("date") || "";
    const playersRaw = sp.get("players") || "1";
    const players = Math.max(1, Math.min(8, parseInt(playersRaw, 10) || 1));

    if (!CENTER_TO_LOCATION[centerId]) {
      return NextResponse.json({ error: "Unknown center" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }

    // Schedule gate (server-side enforcement — never trust client filtering).
    if (!isKbfBookableDate(date)) {
      return NextResponse.json(
        {
          offers: [],
          gateReason: kbfBookableReason(date) ?? "Not bookable",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const allowed = kbfOfferIdsFor(centerId);
    if (allowed.size === 0) {
      // Misconfigured env — surface a clear error so we don't
      // silently show "no offers available" forever.
      console.error(`[kbf/offers] No KBF_WEBOFFER_* env vars configured for center ${centerId}`);
      return NextResponse.json(
        { error: "Kids Bowl Free isn't configured for this center yet." },
        { status: 503 },
      );
    }

    // Probe at the start of the day to get every slot QAMF has for
    // KBF on this date. The bowling flow uses the user's selected
    // time as the probe; we don't have one yet, so we use 09:00
    // local which is before any reasonable open time.
    const datetime = `${date}T09:00`;
    const url =
      `${QAMF_BASE}/centers/${centerId}/offers-availability` +
      `?systemId=${centerId}` +
      `&datetime=${encodeURIComponent(datetime)}` +
      `&players=1-${players}` +
      `&page=1&itemsPerPage=50`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "ocp-apim-subscription-key": QAMF_SUBSCRIPTION_KEY,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[kbf/offers] QAMF ${res.status}:`, txt);
      return NextResponse.json(
        { error: "Failed to load offers" },
        { status: 502 },
      );
    }
    const raw = (await res.json()) as QamfOffer[] | unknown;
    const allOffers: QamfOffer[] = Array.isArray(raw) ? raw : [];

    // Filter to only the KBF offers this center is allowed to surface,
    // and to slots that pass the Fri-5pm cutoff. Each Item is a
    // (tariff, slot) tuple — Items[].Time is HH:MM ET local, paired
    // with the request `date` to form the per-slot ISO timestamp.
    const kbfOffers = allOffers
      .filter((o) => allowed.has(o.OfferId))
      .map((o) => {
        const items = (o.Items ?? []).filter((it) => {
          if (!it.Time) return false;
          // Hide soldout slots — Remaining=0 means no lanes free.
          if (it.Remaining != null && it.Remaining <= 0) return false;
          return isKbfBookableTime(`${date}T${it.Time}`);
        });
        return { ...o, Items: items };
      })
      .filter((o) => (o.Items?.length ?? 0) > 0);

    return NextResponse.json(
      { offers: kbfOffers, date },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[kbf/offers] error:", err);
    return NextResponse.json({ error: "Failed to load offers" }, { status: 500 });
  }
}
