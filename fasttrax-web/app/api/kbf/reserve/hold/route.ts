import { NextRequest, NextResponse } from "next/server";
import { isKbfBookableTime } from "@/lib/kbf-schedule";

/**
 * POST /api/kbf/reserve/hold
 *
 * Fires the FIRST of the four QAMF calls — book-for-later — to
 * place a temporary lane hold the moment a parent picks a Regular
 * vs VIP tariff and a time. Mirrors bowling's progressive flow:
 * the lane is held on QAMF (visible in their admin) for ~10 minutes
 * while the parent finishes the wizard. If they abandon, QAMF
 * auto-releases. If they reach the Confirm step, /api/kbf/reserve
 * (the rest of the orchestration) fires PATCH players + Cart
 * summary + guest/confirm against this same reservationKey.
 *
 * Body:
 *   { centerId, date, time, offerId, tariffId, players }
 *
 * Returns:
 *   { ok: true, reservationKey: "W146949", sessionToken: "...", lifetimeMinutes: 10 }
 */

const QAMF_BASE = "https://qcloud.qubicaamf.com/bowler";
const QAMF_SUBSCRIPTION_KEY =
  process.env.QAMF_SUBSCRIPTION_KEY || "93108f56-0825-4030-b85f-bc6a69fa502c";

const CENTER_OK: Record<string, true> = {
  "9172": true,
  "3148": true,
};

interface HoldBody {
  centerId: string;
  date: string;
  time: string;
  offerId: number;
  tariffId: number;
  players: number;
}

interface QamfReservation {
  ReservationKey?: string;
  LifetimeMinutes?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<HoldBody>;

    if (!body.centerId || !CENTER_OK[body.centerId]) {
      return NextResponse.json({ error: "Unknown center" }, { status: 400 });
    }
    if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    if (!body.time || !/^\d{2}:\d{2}$/.test(body.time)) {
      return NextResponse.json({ error: "Invalid time" }, { status: 400 });
    }
    const datetime = `${body.date}T${body.time}`;
    if (!isKbfBookableTime(datetime)) {
      return NextResponse.json({ error: "Slot outside KBF window" }, { status: 400 });
    }
    if (!body.offerId || !body.tariffId) {
      return NextResponse.json({ error: "Offer + tariff required" }, { status: 400 });
    }
    const playerCount = Math.max(1, Math.min(8, body.players ?? 1));

    const res = await fetch(
      `${QAMF_BASE}/centers/${body.centerId}/reservations/temporary-request/book-for-later`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "ocp-apim-subscription-key": QAMF_SUBSCRIPTION_KEY,
        },
        body: JSON.stringify({
          DateFrom: datetime,
          WebOfferId: body.offerId,
          WebOfferTariffId: body.tariffId,
          PlayersList: [{ TypeId: 1, Number: playerCount }],
        }),
        cache: "no-store",
      },
    );
    const sessionToken = res.headers.get("x-sessiontoken") ?? null;
    const txt = await res.text();
    let data: QamfReservation | null = null;
    try {
      data = txt ? (JSON.parse(txt) as QamfReservation) : null;
    } catch {
      data = null;
    }

    if (!res.ok || !data?.ReservationKey) {
      console.error("[kbf/reserve/hold] book-for-later failed", res.status, txt.slice(0, 300));
      return NextResponse.json(
        { error: "Couldn't reserve a slot" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      reservationKey: data.ReservationKey,
      sessionToken,
      lifetimeMinutes: data.LifetimeMinutes ?? 10,
    });
  } catch (err) {
    console.error("[kbf/reserve/hold] error:", err);
    return NextResponse.json({ error: "Hold failed" }, { status: 500 });
  }
}
