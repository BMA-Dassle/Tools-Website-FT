import { NextRequest, NextResponse } from "next/server";
import {
  listBowlingReservations,
  listVipComboReservations,
  updateBowlingReservationShortCode,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import { getSurveysForReservations } from "@/lib/guest-survey-db";
import { shortenUrl } from "@/lib/short-url";
import { confirmationShortUrl } from "@/lib/booking-confirmation-link";
import { sql } from "@/lib/db";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { getReservation } from "@/lib/qamf-bowling";

/** QAMF numeric center ids (mirrors bowling-lane-poll). */
const QAMF_CENTER_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172, // HeadPinz Fort Myers
  PPTR5G2N0QXF7: 3148, // HeadPinz Naples
};

/**
 * GET /api/admin/bowling/reservations?token=...&date=YYYY-MM-DD&center=...
 *
 * Returns all bowling reservations for the given date.
 * Each reservation includes a `shortCode` for the confirmation page,
 * read from the stored short_code column. Legacy rows that pre-date
 * the column get a code generated + backfilled on first access.
 *
 * Auth: ADMIN_CAMERA_TOKEN query param.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const center = searchParams.get("center") || undefined;
  const kindParam = searchParams.get("kind");
  const productKinds = kindParam
    ? (kindParam.split(",").filter(Boolean) as ReservationProductKind[])
    : undefined;

  // BRIDGE: center_code carries two namespaces today — bowling rows store the
  // Square location ID, race/attraction rows store a center slug (defaulting to
  // 'fort-myers'). So one physical center's reservations span both. Map the
  // requested location to every center_code its rows live under, so the board
  // (esp. the FastTrax embed, which is racing) isn't empty. Remove once
  // center_code is normalized — see tasks/future/center-code-normalization.md.
  const CENTER_CODE_ALIASES: Record<string, string[]> = {
    TXBSQN0FEKQ11: ["TXBSQN0FEKQ11"], // HeadPinz Fort Myers — bowling only
    PPTR5G2N0QXF7: ["PPTR5G2N0QXF7", "naples"], // HeadPinz Naples — bowling + slug attractions
    LAB52GY480CJF: ["LAB52GY480CJF", "fort-myers"], // FastTrax — racing/attractions under the fort-myers slug
  };
  const centerCodes = center ? (CENTER_CODE_ALIASES[center] ?? [center]) : undefined;

  try {
    const reservations = await listBowlingReservations({
      startDate: date,
      endDate: date,
      centerCodes,
      productKinds,
    });

    // Backfill short codes for legacy rows that don't have one stored yet
    const withCodes = await Promise.all(
      reservations.map(async (r) => {
        if (r.shortCode) return r; // already stored — use as-is

        // Legacy row — generate + persist so future reads don't regenerate
        const confirmBase =
          r.productKind === "kbf"
            ? "/hp/book/kids-bowl-free/confirmation"
            : "/hp/book/bowling/confirmation";
        try {
          const code = await shortenUrl(`${confirmBase}?neonId=${r.id}`);
          // Fire-and-forget persist to Neon
          updateBowlingReservationShortCode(r.id, code).catch(() => {});
          return { ...r, shortCode: code };
        } catch {
          return r; // non-fatal
        }
      }),
    );

    // Attach guest-survey snapshot per reservation (one batch query, no
    // N+1). Reservations without a survey row return `survey: null`.
    const surveyMap = await getSurveysForReservations(withCodes.map((r) => r.id));
    const enriched = withCodes.map((r) => ({
      ...r,
      survey: surveyMap.get(String(r.id)) ?? null,
    }));

    // Group function events for the same date.
    // `center` is a Square location ID (bowling reservations use it); group
    // function quotes use center_code ('fort-myers', 'naples', 'fasttrax').
    // Map so the filter works for both.
    const GF_CENTER_MAP: Record<string, string> = {
      TXBSQN0FEKQ11: "fort-myers",
      LAB52GY480CJF: "fasttrax",
      PPTR5G2N0QXF7: "naples",
    };
    const gfCenter = center ? GF_CENTER_MAP[center] : undefined;
    const q = sql();
    const gfRows = await q`
      SELECT id, contract_short_id, event_name, event_number, event_date, event_date_display,
             guest_first_name, guest_last_name, guest_email, guest_phone, guest_count,
             planner_first, planner_last, planner_email, planner_phone,
             center_code, brand, status, total_cents, tax_cents, deposit_due_cents, balance_cents,
             square_deposit_order_id, square_dayof_order_id, square_gift_card_gan,
             square_customer_id, saved_card_id, deposit_paid_at, balance_paid_at,
             line_items, notes, created_at
      FROM group_function_quotes
      WHERE event_date::date = ${date}::date
        AND status NOT IN ('cancelled', 'denied')
        ${gfCenter ? q`AND center_code = ${gfCenter}` : q``}
      ORDER BY event_date ASC
    `;
    const groupEvents = gfRows.map((r: Record<string, unknown>) => ({
      id: r.id,
      contractShortId: r.contract_short_id,
      eventName: r.event_name,
      eventNumber: r.event_number,
      eventDate: r.event_date,
      eventDateDisplay: r.event_date_display,
      guestName: `${r.guest_first_name} ${r.guest_last_name}`,
      guestEmail: r.guest_email,
      guestPhone: r.guest_phone,
      guestCount: r.guest_count,
      plannerName: r.planner_first ? `${r.planner_first} ${r.planner_last || ""}`.trim() : null,
      plannerEmail: r.planner_email,
      plannerPhone: r.planner_phone,
      centerCode: r.center_code,
      brand: r.brand,
      status: r.status,
      totalCents: r.total_cents,
      taxCents: r.tax_cents,
      depositDueCents: r.deposit_due_cents,
      balanceCents: r.balance_cents,
      squareDepositOrderId: r.square_deposit_order_id,
      squareDayofOrderId: r.square_dayof_order_id,
      squareGiftCardGan: r.square_gift_card_gan,
      squareCustomerId: r.square_customer_id,
      savedCardId: r.saved_card_id,
      depositPaidAt: r.deposit_paid_at,
      balancePaidAt: r.balance_paid_at,
      lineItems: r.line_items,
      notes: r.notes,
      createdAt: r.created_at,
    }));

    // VIP combos for the date — fetched UNSCOPED (all centers) because a combo
    // spans FastTrax racing + HeadPinz bowling, so staff at either location must
    // see it regardless of the center this portal is scoped to. The two legs
    // share a square_dayof_order_id; the client groups on that.
    const vipReservations = await listVipComboReservations({ startDate: date, endDate: date });

    // Enrich combo BOWLING legs with their QAMF lane. dayof_order_lane is only
    // persisted at lane-open, so an upcoming combo shows no lane even though the
    // VIP lane is already reserved in QAMF — fetch it. Best-effort; never fails
    // the response.
    await Promise.all(
      vipReservations.map(async (r) => {
        if (
          (r.productKind !== "open" && r.productKind !== "kbf") ||
          r.dayofOrderLane ||
          !r.qamfReservationId
        )
          return;
        const centerId = QAMF_CENTER_ID[r.centerCode];
        if (!centerId) return;
        try {
          const qr = await getReservation(centerId, r.qamfReservationId);
          const lanes = (qr.Lanes ?? [])
            .map((l) => l.LaneNumber)
            .filter((n): n is number => typeof n === "number");
          if (lanes.length) r.dayofOrderLane = lanes.join(", ");
        } catch {
          /* non-fatal — lane just stays blank */
        }
      }),
    );

    // Attach the canonical short confirmation link to each combo RACE leg. A
    // combo's "View" opens the multi-activity (v2) confirmation via the race
    // leg's BMI bill; this gives staff the same /s/{code} short link the guest
    // gets by email/SMS instead of a raw 17-digit billId URL. Deterministic +
    // idempotent. Best-effort — never fails the response.
    await Promise.all(
      vipReservations.map(async (r) => {
        if (r.productKind !== "race" || !r.bmiBillId) return;
        try {
          (r as { confirmationShortUrl?: string }).confirmationShortUrl =
            await confirmationShortUrl(r.bmiBillId, true);
        } catch {
          /* non-fatal — client falls back to the raw billId URL */
        }
      }),
    );

    const comboMeta: Record<
      string,
      { name: string; accentColor: string; includes: string[]; center: string }
    > = {};
    for (const r of vipReservations) {
      const id = r.comboSpecialId;
      if (!id || comboMeta[id]) continue;
      const combo = getComboSpecial(id);
      if (combo) {
        comboMeta[id] = {
          name: combo.name,
          accentColor: combo.accentColor,
          includes: combo.includes,
          center: combo.center,
        };
      }
    }

    return NextResponse.json({ reservations: enriched, groupEvents, vipReservations, comboMeta });
  } catch (err) {
    console.error("[admin/bowling/reservations]", err);
    return NextResponse.json({ error: "Failed to load reservations" }, { status: 500 });
  }
}
