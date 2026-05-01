import { NextRequest, NextResponse } from "next/server";
import { isKbfBookableTime } from "@/lib/kbf-schedule";
import { upsertMemberPref } from "@/lib/kbf-prefs";
import { logSale } from "@/lib/sales-log";

/**
 * POST /api/kbf/reserve
 *
 * Orchestrates the four QAMF calls that turn a wizard submission
 * into a confirmed reservation:
 *
 *   1. POST  /reservations/temporary-request/book-for-later
 *   2. PATCH /reservations/{key}/players
 *   3. POST  /Cart/CreateSummary
 *   4. POST  /reservations/{key}/guest/confirm
 *
 * Plus, after a successful confirm:
 *   - logs to sales_log with bookingType=attractions, package_id=kids-bowl-free
 *   - upserts each booked bowler's prefs to kbf_member_prefs
 *
 * Returns:
 *   { ok: true, redirect: "/hp/book/kids-bowl-free/confirmation?..." }    // zero-balance
 *   { ok: true, redirect: "https://payments.mybowlingpassport.com/..." } // needs payment
 *
 * Body (JSON):
 *   {
 *     centerId: "9172" | "3148",
 *     date: "2026-05-15",
 *     time: "13:40",
 *     offerId: 150,
 *     tariffId: 896,
 *     offerName: "Kids Bowl Free Regular",
 *     tariffPrice: 0,
 *     bowlers: [
 *       {
 *         passId: 12, memberSlot: 1, relation: "kid",
 *         name: "Ada Lovelace",
 *         wantShoes: true, shoeSizeId: 40, shoeSizeLabel: "KM 2.5",
 *         wantBumpers: true
 *       },
 *       ...
 *     ],
 *     shoePriceKeyId?: 12787,        // QAMF PriceKeyId for the rental shoes line
 *     shoeUnitPrice?: 4.75,          // dollars per pair
 *     guest: { firstName, lastName, email, phone },
 *     // For sales_log + clickwrap correlation
 *     primaryPassId: 12,
 *   }
 */

const QAMF_BASE = "https://qcloud.qubicaamf.com/bowler";
const QAMF_SUBSCRIPTION_KEY =
  process.env.QAMF_SUBSCRIPTION_KEY || "93108f56-0825-4030-b85f-bc6a69fa502c";

const CENTER_TO_LOCATION: Record<string, "fortmyers" | "naples"> = {
  "9172": "fortmyers",
  "3148": "naples",
};

interface BowlerInput {
  passId: number;
  memberSlot: number;
  relation: "kid" | "family" | "parent";
  name: string;
  wantShoes?: boolean;
  shoeSizeId?: number | null;
  shoeSizeLabel?: string | null;
  wantBumpers?: boolean;
}

interface ReserveBody {
  centerId: string;
  date: string;
  time: string;
  offerId: number;
  tariffId: number;
  offerName: string;
  tariffPrice: number;
  bowlers: BowlerInput[];
  shoePriceKeyId?: number;
  shoeUnitPrice?: number;
  guest: { firstName: string; lastName: string; email: string; phone: string };
  primaryPassId?: number;
  reservationNumber?: string;
}

interface QamfRequestInit extends RequestInit {
  sessionToken?: string;
}

/**
 * Single per-call wrapper for QAMF — same headers as the catch-all
 * proxy, plus an out-of-band session-token shuttle so we can keep
 * the reservation context across the four calls.
 */
async function qamf<T = unknown>(
  path: string,
  init: QamfRequestInit & { method?: string } = {},
): Promise<{ data: T; sessionToken: string | null; status: number }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "ocp-apim-subscription-key": QAMF_SUBSCRIPTION_KEY,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.sessionToken) headers["x-sessiontoken"] = init.sessionToken;
  const res = await fetch(`${QAMF_BASE}/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    cache: "no-store",
  });
  const sessionToken = res.headers.get("x-sessiontoken");
  const txt = await res.text();
  let data: unknown = null;
  if (txt) {
    try {
      data = JSON.parse(txt);
    } catch {
      data = txt;
    }
  }
  return { data: data as T, sessionToken, status: res.status };
}

interface QamfReservation {
  ReservationKey: string;
}

interface QamfCartSummary {
  Total: number;
  TotalWithoutTaxes?: number;
  AddedTaxes?: number;
  Fee?: number;
  TotalItems?: number;
  AutoGratuity?: number;
  Deposit?: number;
}

interface QamfConfirmResult {
  NeedPayment: boolean;
  ApprovePayment: { Url: string } | null;
  OperationId: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReserveBody;

    // ── Validate ─────────────────────────────────────────────────
    if (!body.centerId || !CENTER_TO_LOCATION[body.centerId]) {
      return NextResponse.json({ error: "Unknown center" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    if (!/^\d{2}:\d{2}$/.test(body.time)) {
      return NextResponse.json({ error: "Invalid time" }, { status: 400 });
    }
    const dateTime = `${body.date}T${body.time}`;
    if (!isKbfBookableTime(dateTime)) {
      return NextResponse.json(
        { error: "That time isn't bookable for Kids Bowl Free." },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.bowlers) || body.bowlers.length === 0) {
      return NextResponse.json({ error: "Pick at least one bowler" }, { status: 400 });
    }
    if (!body.guest?.email || !body.guest?.phone || !body.guest?.firstName) {
      return NextResponse.json({ error: "Guest contact required" }, { status: 400 });
    }
    if (!body.offerId || !body.tariffId) {
      return NextResponse.json({ error: "Offer + tariff required" }, { status: 400 });
    }

    const playerCount = body.bowlers.length;

    // ── 1. Create reservation ─────────────────────────────────────
    const created = await qamf<QamfReservation>(
      `centers/${body.centerId}/reservations/temporary-request/book-for-later`,
      {
        method: "POST",
        body: JSON.stringify({
          DateFrom: dateTime,
          WebOfferId: body.offerId,
          WebOfferTariffId: body.tariffId,
          PlayersList: [{ TypeId: 1, Number: playerCount }],
        }),
      },
    );
    if (created.status >= 400 || !created.data?.ReservationKey) {
      console.error("[kbf/reserve] book-for-later failed", created);
      return NextResponse.json({ error: "Couldn't reserve a slot" }, { status: 502 });
    }
    const reservationKey = created.data.ReservationKey;
    let sessionToken = created.sessionToken;

    // ── 2. PATCH players (names + shoes + bumpers) ──────────────
    const playersPayload = body.bowlers.map((b) => ({
      Name: b.name,
      ShoeSize: b.wantShoes && b.shoeSizeLabel ? b.shoeSizeLabel : null,
      WantBumpers: b.wantBumpers === true,
      Size:
        b.wantShoes && b.shoeSizeId && b.shoeSizeLabel
          ? { Id: b.shoeSizeId, Name: b.shoeSizeLabel }
          : null,
    }));
    const patched = await qamf(
      `centers/${body.centerId}/reservations/${encodeURIComponent(reservationKey)}/players`,
      {
        method: "PATCH",
        sessionToken: sessionToken || undefined,
        body: JSON.stringify({ Players: playersPayload }),
      },
    );
    if (patched.sessionToken) sessionToken = patched.sessionToken;
    if (patched.status >= 400) {
      console.error("[kbf/reserve] players PATCH failed", patched);
      // Non-fatal — slot is still reserved, names just default.
      // Continue rather than blowing up the whole booking.
    }

    // ── 3. CreateSummary (calculates total, including paid shoes) ─
    const shoeQty = body.bowlers.filter((b) => b.wantShoes === true).length;
    const shoesItems =
      shoeQty > 0 && body.shoePriceKeyId && body.shoeUnitPrice
        ? [{
            PriceKeyId: body.shoePriceKeyId,
            Quantity: shoeQty,
            UnitPrice: body.shoeUnitPrice,
            Note: "",
          }]
        : [];

    const summarized = await qamf<QamfCartSummary>(
      `centers/${body.centerId}/Cart/CreateSummary`,
      {
        method: "POST",
        sessionToken: sessionToken || undefined,
        body: JSON.stringify({
          Time: dateTime,
          Items: {
            Extra: [],
            FoodAndBeverage: [],
            ShoesSocks: shoesItems,
            WebOffer: {
              Id: body.offerId,
              UnitPrice: body.tariffPrice,
              WebOfferTariffId: body.tariffId,
            },
          },
          Players: [{ TypeId: 1, Number: playerCount }],
        }),
      },
    );
    if (summarized.sessionToken) sessionToken = summarized.sessionToken;
    if (summarized.status >= 400) {
      console.error("[kbf/reserve] summary failed", summarized);
      return NextResponse.json({ error: "Couldn't price the booking" }, { status: 502 });
    }
    const summary = summarized.data;

    // ── 4. guest/confirm ─────────────────────────────────────────
    const cartItems: {
      Name: string;
      Type: string;
      PriceKeyId: number;
      Quantity: number;
      UnitPrice: number;
    }[] = [
      {
        Name: body.offerName,
        Type: "WebOffer",
        PriceKeyId: body.offerId,
        Quantity: 1,
        UnitPrice: body.tariffPrice,
      },
    ];
    if (shoeQty > 0 && body.shoePriceKeyId && body.shoeUnitPrice) {
      cartItems.push({
        Name: "Bowling Shoes",
        Type: "ShoesSocks",
        PriceKeyId: body.shoePriceKeyId,
        Quantity: shoeQty,
        UnitPrice: body.shoeUnitPrice,
      });
    }

    // Reuse the existing bowling confirmation page — same QAMF backend,
    // same status-poll pattern, same player-edit form. KBF doesn't set
    // qamf_bmi_addons so the BMI block is a no-op.
    const origin = req.nextUrl.origin;
    const returnUrl = `${origin}/hp/book/bowling/confirmation?key=${encodeURIComponent(reservationKey)}&center=${body.centerId}`;

    const confirmed = await qamf<QamfConfirmResult>(
      `centers/${body.centerId}/reservations/${encodeURIComponent(reservationKey)}/guest/confirm`,
      {
        method: "POST",
        sessionToken: sessionToken || undefined,
        body: JSON.stringify({
          GuestDetails: {
            Email: body.guest.email,
            PhoneNumber: body.guest.phone.replace(/\D/g, ""),
            ReferentName: `${body.guest.firstName} ${body.guest.lastName}`.trim(),
          },
          Cart: {
            ReturnUrl: returnUrl,
            Items: cartItems,
            Summary: summary
              ? {
                  AddedTaxes: summary.AddedTaxes ?? 0,
                  Deposit: summary.Deposit ?? 0,
                  Fee: summary.Fee ?? 0,
                  Total: summary.Total ?? 0,
                  TotalItems: summary.TotalItems ?? 0,
                  AutoGratuity: summary.AutoGratuity ?? 0,
                  TotalWithoutTaxes: summary.TotalWithoutTaxes ?? 0,
                }
              : undefined,
          },
        }),
      },
    );
    if (confirmed.status >= 400 || !confirmed.data) {
      console.error("[kbf/reserve] confirm failed", confirmed);
      return NextResponse.json({ error: "Couldn't confirm the booking" }, { status: 502 });
    }
    const result = confirmed.data;

    // ── Post-confirm bookkeeping ─────────────────────────────────
    const location = CENTER_TO_LOCATION[body.centerId];

    // Fire-and-forget: log to sales_log so the dashboard sees this
    // booking. Failures don't block the redirect.
    void logSale({
      ts: new Date().toISOString(),
      billId: reservationKey,
      reservationNumber: body.reservationNumber,
      brand: "headpinz",
      location,
      bookingType: "attractions",
      participantCount: playerCount,
      raceProductNames: [body.offerName],
      addOnNames: shoeQty > 0 ? [`Bowling Shoes ×${shoeQty}`] : undefined,
      totalUsd: summary?.Total ?? 0,
      email: body.guest.email,
      phone: body.guest.phone.replace(/\D/g, ""),
      packageId: "kids-bowl-free",
    }).catch((err) => {
      console.error("[kbf/reserve] sales_log write failed (non-fatal):", err);
    });

    // Upsert prefs for every bowler so the next visit pre-fills.
    // Skip the parent (no passId on family-pass adults that aren't
    // in kbf_pass_members) — only persist bowlers that came from
    // the synced family roster.
    for (const b of body.bowlers) {
      if (b.relation === "parent") continue;
      if (!b.passId || !b.memberSlot) continue;
      try {
        await upsertMemberPref({
          passId: b.passId,
          memberSlot: b.memberSlot,
          relation: b.relation,
          shoeSizeId: b.shoeSizeId ?? null,
          shoeSizeLabel: b.shoeSizeLabel ?? null,
          wantShoes: b.wantShoes ?? null,
          wantBumpers: b.wantBumpers ?? null,
          lastUsedCenter: location,
        });
      } catch (err) {
        console.error("[kbf/reserve] pref upsert failed (non-fatal):", err);
      }
    }

    // ── Return: payment redirect or our own confirmation ────────
    if (result.NeedPayment && result.ApprovePayment?.Url) {
      return NextResponse.json({
        ok: true,
        needPayment: true,
        redirect: result.ApprovePayment.Url,
        reservationKey,
        centerId: body.centerId,
      });
    }

    return NextResponse.json({
      ok: true,
      needPayment: false,
      redirect: `/hp/book/bowling/confirmation?key=${encodeURIComponent(reservationKey)}&center=${body.centerId}`,
      reservationKey,
      centerId: body.centerId,
      total: summary?.Total ?? 0,
    });
  } catch (err) {
    console.error("[kbf/reserve] error:", err);
    return NextResponse.json({ error: "Reservation failed" }, { status: 500 });
  }
}
