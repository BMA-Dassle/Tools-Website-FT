/**
 * Add-on booking orchestrator — SERVER-ONLY. Adds `guests` to a completed combo
 * booking as a SELF-CONTAINED second settlement that mirrors unifiedReserve:
 *
 *   1. (Neon-first) record the add-on intent as `pending` — source of truth.
 *   2. Re-check capacity (charge-time re-eval).
 *   3. Create the add-on day-of order(s) — one per entity (FastTrax racing +
 *      HeadPinz bowling) via the shared createDayofOrder. Left OPEN.
 *   4. Charge the card for the tax-inclusive day-of total + mint ONE gift card
 *      (createDepositAndCharge), exactly like the original combo (100% prepaid).
 *   5. Racing: book the new guests' heats into a FRESH $0 BMI bill via
 *      rebuildRaceBill (same heats the party holds; confirmed $0 credit).
 *   6. Bowling: create a NEW QAMF reservation for the added bowlers at the same
 *      slot (its own lane-open settles the add-on HP order — no orphan order).
 *   7. Persist Neon rows (race anchor + bowling) + append the booking record.
 *   8. Notify staff + guest.
 *
 * Every BMI id is raw-string handled by rebuildRaceBill; we never Number() one.
 * Idempotent on `baseKey` (derived from the client idempotencyKey) so a reload
 * never double-charges or double-books.
 */
import { buildGanPrefix } from "@/lib/gan";
import redis from "@/lib/redis";
import {
  createReservation,
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  setLanePlayers,
  patchReservation,
} from "@/lib/qamf-bowling";
import { insertBowlingReservation, type ReservationProductKind } from "@/lib/bowling-db";
import { comboReservationNote, getComboSpecial, type ComboSpecial } from "~/features/combos";
import { createDayofOrder, type DayofLineItem } from "~/features/booking/service/square-dayof";
import { createDepositAndCharge } from "~/features/booking/service/deposit";
import { rebuildRaceBill, type RebuildRacerHeat } from "~/features/booking/service/bmi-rebuild";
import { SQUARE_LOCATIONS } from "~/features/booking/data/square-catalog-map";
import { notifyComboGuestsAdded } from "~/features/combos/combo-notify";

import { buildAddOnQuote, addonOrderGroups } from "./pricing";
import { checkAddOnCapacity, type CapacityDeps } from "./capacity";
import type { AddGuest, AddOnContext, AddOnResult } from "./types";

const TTL = 60 * 60 * 24 * 90;

export interface BookAddOnArgs {
  ctx: AddOnContext;
  guests: AddGuest[];
  /** Square Web Payments card token (single-use). */
  paymentToken: string;
  /** Stable client idempotency seed → deterministic Square keys. */
  idempotencyKey: string;
  squareCustomerId?: string;
  /** Request origin (e.g. https://…) so server code can reach our /api proxies. */
  origin: string;
  /** Injected heat-availability lookup for the capacity re-check. */
  capacityDeps: CapacityDeps;
}

function entityLocation(entity: string): string {
  return entity === "fasttrax-fm" ? SQUARE_LOCATIONS.FASTTRAX_FM : SQUARE_LOCATIONS.HEADPINZ_FM;
}

/** Resolve the VIP bowling experience's QAMF webOffer + duration option for a
 *  new lane, from the experiences catalog (the record doesn't store them). */
async function resolveBowlingOffer(
  origin: string,
  combo: ComboSpecial,
  centerId: number,
): Promise<{ webOfferId: number; optionId: number } | null> {
  const bowlLeg = combo.components.find(
    (c): c is Extract<(typeof combo.components)[number], { kind: "bowling" }> =>
      c.kind === "bowling",
  );
  if (!bowlLeg) return null;
  const centerCode = centerId === 3148 ? "PPTR5G2N0QXF7" : "TXBSQN0FEKQ11";
  try {
    const res = await fetch(`${origin}/api/bowling/v2/experiences?centerCode=${centerCode}`, {
      cache: "no-store",
    });
    const all = (await res.json().catch(() => [])) as Array<{
      isVip?: boolean;
      kind?: string;
      qamfWebOfferId?: number;
      durationOptions?: Array<{ durationMinutes: number; qamfOptionId: number }>;
    }>;
    const match = (Array.isArray(all) ? all : []).find(
      (e) =>
        e.isVip === (bowlLeg.vip ?? false) &&
        e.kind !== "kbf" &&
        (e.durationOptions ?? []).some((d) => d.durationMinutes === bowlLeg.durationMinutes),
    );
    if (!match?.qamfWebOfferId) return null;
    const opt = (match.durationOptions ?? []).find(
      (d) => d.durationMinutes === bowlLeg.durationMinutes,
    );
    if (!opt) return null;
    return { webOfferId: match.qamfWebOfferId, optionId: opt.qamfOptionId };
  } catch {
    return null;
  }
}

/**
 * Execute an add-on purchase. Throws on a hard failure BEFORE charge (so the
 * client can retry); after charge, persists recoverable anchors and never
 * silently loses money (mirrors unifiedReserve's forward-recovery model).
 */
export async function bookAddOn(args: BookAddOnArgs): Promise<AddOnResult> {
  const { ctx, guests, paymentToken, idempotencyKey, squareCustomerId, origin, capacityDeps } =
    args;
  const combo = getComboSpecial(ctx.comboSpecialId);
  if (!combo) throw new Error("Unknown combo");
  const addCount = guests.length;
  const baseKey = `addon-${ctx.originalBillId ?? "x"}-${idempotencyKey}`.slice(0, 80);

  // ── 1. Neon-first intent (idempotent NX lock on the baseKey) ──────────
  const lockKey = `addon:lock:${baseKey}`;
  let lockHeld = false;
  try {
    lockHeld = (await redis.set(lockKey, "1", "EX", 120, "NX")) === "OK";
  } catch {
    lockHeld = true; // Redis down — deterministic Square keys still prevent a double charge.
  }
  if (!lockHeld) throw new Error("An add-on for this booking is already in progress.");

  try {
    // ── 2. Charge-time capacity re-eval ─────────────────────────────────
    const cap = await checkAddOnCapacity(combo, ctx, addCount, capacityDeps);
    if (!cap.ok) throw new Error(cap.blockedReason ?? "These guests can't be added right now.");

    // ── 3. Create the add-on day-of order(s), one per entity ────────────
    const groups = addonOrderGroups(combo, ctx.eventDate, addCount);
    if (groups.length === 0) throw new Error("This package can't be added to.");
    const orderByEntity: Record<string, { orderId: string; totalCents: number }> = {};
    for (const g of groups) {
      const lineItems: DayofLineItem[] = g.lines.map((l) => ({
        name: l.name,
        quantity: String(l.quantity),
        catalogObjectId: l.catalogObjectId,
        basePriceMoney: { amount: l.unitCents, currency: "USD" },
      }));
      orderByEntity[g.entity] = await createDayofOrder({
        locationId: entityLocation(g.entity),
        lineItems,
        baseKey,
        keySuffix: g.entity,
        keyPrefix: "addon-dayof",
        squareCustomerId,
      });
    }
    const ftOrder = orderByEntity["fasttrax-fm"];
    const hpOrder = orderByEntity["headpinz-fm"];
    // Tax-inclusive total across both orders = what the gift card must hold so
    // each leg's settlement (race-dayof-pay / lane-open) covers county tax too.
    const dayofTotalCents = (ftOrder?.totalCents ?? 0) + (hpOrder?.totalCents ?? 0);

    // ── 4. Charge the card + mint ONE shared gift card (100% prepaid) ───
    const depositLocation = hpOrder ? SQUARE_LOCATIONS.HEADPINZ_FM : SQUARE_LOCATIONS.FASTTRAX_FM;
    const ganPrefix = buildGanPrefix("WEB", depositLocation);
    const ganSuffix = baseKey.slice(-8);
    const deposit = await createDepositAndCharge({
      amountCents: dayofTotalCents,
      locationId: depositLocation,
      cardSourceId: paymentToken,
      squareCustomerId,
      ganPrefix,
      ganSuffix,
      note: `VIP add-on ${addCount}p - ${ganPrefix}${ganSuffix}`,
      baseKey,
    });

    const squareDayofOrderIds = [ftOrder?.orderId, hpOrder?.orderId].filter(
      (id): id is string => !!id,
    );
    const result: AddOnResult = {
      ok: false,
      addedGuestCount: addCount,
      newBmiBillId: null,
      bmiReservationNumber: null,
      qamfReservationIds: [],
      squareDayofOrderIds,
      giftCardGan: deposit.giftCardGan,
      chargedCents: dayofTotalCents,
      lanesAdded: cap.lanesToAdd,
    };

    // ── 5. Racing — book new guests' heats into a FRESH $0 BMI bill ─────
    const heats: RebuildRacerHeat[] = guests.flatMap((guest) =>
      ctx.raceLegs.map((leg) => ({
        productId: leg.productId,
        track: leg.track,
        heatStart: leg.heatStart,
        personId: null, // v1: every added guest is a NEW racer (license folded in)
        firstName: guest.firstName,
        lastName: guest.lastName,
      })),
    );
    const rebuilt = await rebuildRaceBill({
      origin,
      clientKey: ctx.clientKey,
      oldBillId: ctx.originalBillId ?? "0",
      date: ctx.eventDate,
      heats,
      contact: {
        firstName: ctx.contact.firstName,
        lastName: ctx.contact.lastName,
        email: ctx.contact.email,
        phone: ctx.contact.phone,
      },
      pandoraLocationId: "LAB52GY480CJF",
      pandoraKey: process.env.SWAGGER_ADMIN_KEY,
    });
    result.newBmiBillId = rebuilt.newBillId;
    result.bmiReservationNumber = rebuilt.reservationNumber;

    // Race anchor Neon row → add-on FastTrax order, settled at race-dayof-pay.
    if (rebuilt.newBillId && ftOrder) {
      try {
        await insertBowlingReservation(
          {
            centerCode: ctx.center,
            productKind: "race" as ReservationProductKind,
            bmiBillId: rebuilt.newBillId,
            bmiReservationNumber: rebuilt.reservationNumber ?? undefined,
            squareDepositOrderId: deposit.depositOrderId ?? undefined,
            squareDepositPaymentId: deposit.depositPaymentId ?? undefined,
            squareDayofOrderId: ftOrder.orderId,
            squareGiftCardId: deposit.giftCardId ?? undefined,
            squareGiftCardGan: deposit.giftCardGan ?? undefined,
            depositCents: ftOrder.totalCents,
            totalCents: ftOrder.totalCents,
            status: rebuilt.ok ? "confirmed" : "confirm_pending",
            bookedAt: new Date().toISOString(),
            playerCount: addCount,
            guestName: `${ctx.contact.firstName} ${ctx.contact.lastName}`.trim(),
            guestEmail: ctx.contact.email,
            guestPhone: ctx.contact.phone,
            notes: `VIP add-on (+${addCount}) racing — bill ${rebuilt.newBillId}`,
            bookingSource: "web",
            squareCustomerId: squareCustomerId ?? undefined,
            comboSpecialId: ctx.comboSpecialId,
          },
          // $0 build lines (the Square FT order holds the real racing money);
          // mirrors unified-reserve's bmiLines shape (no squareProductId).
          heats.map(() => ({ label: "Race", quantity: 1, unitPriceCents: 0 })),
        );
      } catch (err) {
        console.error("[combo-addon] race anchor Neon insert failed (non-fatal):", err);
      }
    }

    // ── 6. Bowling — NEW QAMF reservation for the added bowlers ─────────
    if (ctx.bowling && hpOrder) {
      const centerId = ctx.bowling.qamfCenterId;
      const offer = await resolveBowlingOffer(origin, combo, centerId);
      const guestName = `${ctx.contact.firstName} ${ctx.contact.lastName}`.trim();
      if (offer) {
        try {
          const reservation = await createReservation(centerId, {
            BookedAt: ctx.bowling.bookedAt,
            Title: `VIP Exp. ADD-ON ${guestName} (+${addCount}p)`,
            Customer: {
              Guest: { Name: guestName, PhoneNumber: ctx.contact.phone, Email: ctx.contact.email },
            },
            WebOffer: {
              Id: offer.webOfferId,
              Options: { Time: [{ Id: offer.optionId }] },
              Services: ["BookForLater"],
            },
            TotalPlayers: addCount,
          });
          const resId = reservation.Id;
          result.qamfReservationIds.push(resId);
          await setReservationCustomer(centerId, resId, {
            Guest: { Name: guestName, PhoneNumber: ctx.contact.phone, Email: ctx.contact.email },
          });
          const confirmed = await setReservationStatus(centerId, resId, "Confirmed").catch(
            () => false,
          );
          let lanes = reservation.Lanes ?? [];
          if (lanes.length === 0) {
            try {
              lanes = (await getReservation(centerId, resId)).Lanes ?? [];
            } catch {
              /* non-fatal */
            }
          }
          if (lanes.length > 0) {
            const lane = lanes[0];
            const laneId = lane.Id ?? String(lane.LaneNumber);
            await setLanePlayers(
              centerId,
              resId,
              laneId,
              guests.map((g) => ({
                Name: `${g.firstName} ${g.lastName ?? ""}`.trim() || "Bowler",
                ActivateBumpers: false,
              })),
            ).catch(() => {});
          }
          await patchReservation(centerId, resId, {
            Title: `VIP Exp. ADD-ON ${guestName} (+${addCount}p)`,
            Notes:
              `*** ${combo.name.toUpperCase()} ADD-ON — seat with the original party ` +
              `(lane ${ctx.bowling.lane ?? "—"}). Shoes/perks included, paid online. ***`,
          }).catch(() => {});

          try {
            await insertBowlingReservation(
              {
                centerCode: ctx.center,
                productKind: "open" as ReservationProductKind,
                qamfReservationId: resId,
                squareDepositOrderId: deposit.depositOrderId ?? undefined,
                squareDepositPaymentId: deposit.depositPaymentId ?? undefined,
                squareDayofOrderId: hpOrder.orderId,
                squareGiftCardId: deposit.giftCardId ?? undefined,
                squareGiftCardGan: deposit.giftCardGan ?? undefined,
                depositCents: hpOrder.totalCents,
                totalCents: hpOrder.totalCents,
                status: confirmed ? "confirmed" : "confirm_pending",
                bookedAt: ctx.bowling.bookedAt,
                playerCount: addCount,
                guestName,
                guestEmail: ctx.contact.email,
                guestPhone: ctx.contact.phone,
                notes: `VIP add-on (+${addCount}) bowling`,
                bookingSource: "web",
                squareCustomerId: squareCustomerId ?? undefined,
                comboSpecialId: ctx.comboSpecialId,
              },
              [],
            );
          } catch (err) {
            console.error("[combo-addon] bowling Neon insert failed (non-fatal):", err);
          }
        } catch (err) {
          // Charge captured; bowling QAMF failed → leave it for staff/recovery,
          // never refund. The race side + Square orders persist.
          console.error("[combo-addon] bowling QAMF add failed (charge retained):", err);
        }
      } else {
        console.error("[combo-addon] couldn't resolve VIP bowling offer — bowling lane not added");
      }
    }

    // ── 7. Append the booking record (best-effort) ──────────────────────
    if (ctx.originalBillId) {
      try {
        const key = `bookingrecord:${ctx.originalBillId}`;
        const existing = await redis.get(key);
        if (existing) {
          const rec = typeof existing === "string" ? JSON.parse(existing) : existing;
          rec.racers = [
            ...(rec.racers ?? []),
            ...guests.flatMap((g) =>
              ctx.raceLegs.map((leg) => ({
                racerName: `${g.firstName} ${g.lastName ?? ""}`.trim(),
                product: leg.tier,
                track: leg.track,
                heatStart: leg.heatStart,
                addedVia: "combo-addon",
              })),
            ),
          ];
          rec.comboAddons = [
            ...(rec.comboAddons ?? []),
            {
              addedAt: new Date().toISOString(),
              guestCount: addCount,
              newBmiBillId: rebuilt.newBillId,
              chargedCents: dayofTotalCents,
              lanesAdded: cap.lanesToAdd,
            },
          ];
          await redis.set(key, JSON.stringify(rec), "EX", TTL);
        }
      } catch (err) {
        console.error("[combo-addon] booking-record append failed (non-fatal):", err);
      }
    }

    // ── 8. Notify ───────────────────────────────────────────────────────
    await notifyComboGuestsAdded({
      combo,
      contact: ctx.contact,
      eventDate: ctx.eventDate,
      addedGuests: guests.map((g) => `${g.firstName} ${g.lastName ?? ""}`.trim()),
      lanesAdded: cap.lanesToAdd,
      lane: ctx.bowling?.lane ?? null,
      newBmiBillId: rebuilt.newBillId,
      chargedCents: dayofTotalCents,
    });

    result.ok = true;
    return result;
  } finally {
    if (lockHeld) await redis.del(lockKey).catch(() => {});
  }
}
