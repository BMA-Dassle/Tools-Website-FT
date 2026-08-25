/**
 * BMI (Pandora) sync for race-leg edits — LINE-LEVEL, never a full cancel.
 *
 * Adding a racer books their heats ONTO THE EXISTING BILL (booking/book
 * chains on orderId), then re-confirms the bill as a $0 credit and re-asserts
 * Pandora state -3 so BMI doesn't auto-cancel the touched bill. Removing a
 * heat uses booking/removeItem with the bmiLineId persisted at booking
 * (PR 0); legacy rows without line ids refuse rather than guess (the cancel
 * flow is the fallback for those).
 *
 * All BMI ids are raw-string-injected (@ft/db) — never JSON.stringify/parse.
 * Drives the same /api/bmi proxy as bmi-rebuild.ts so every call lands in
 * the proxy's audit log. Gated behind RESERVATION_EDIT_V2_RACE (service.ts).
 */

import { stringifyWithRawIds } from "@ft/db";
import { sql } from "@/lib/db";
import { getBowlingReservation, type BowlingReservation } from "@/lib/bowling-db";
import { bmiBookingTarget, type RaceTier } from "~/features/booking/service/race-products";
import { ATTRACTIONS, type LocationKey } from "@/lib/attractions-data";
import { resolveCenter } from "~/features/cancellation/centers";
import { stampVipStateIfCombo } from "~/features/combos/vip-state.server";

import type { EditPlan } from "./plan";
import type { RaceAddPlan } from "./reprice";
import { EditGuardError, type HeatMeta } from "./types";

const RACE_PANDORA_LOCATION = "LAB52GY480CJF"; // FastTrax (race bills live here)

/** Normalize a BMI ISO to ET wall-clock minute (mirrors bmi-rebuild). */
const normMinute = (iso: string): string =>
  iso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .slice(0, 16);

interface ProposalBlock {
  productLineIds?: unknown[];
  block: { start: string; resourceId?: string | number };
}
interface Proposal {
  blocks: ProposalBlock[];
  productLineId?: string | null;
}

const findProposalForHeat = (proposals: Proposal[], heatStart: string): Proposal | null => {
  const target = normMinute(heatStart);
  for (const p of proposals) {
    const start = p.blocks?.[0]?.block?.start;
    if (start && normMinute(start) === target) return p;
  }
  return null;
};

const proxyCall = async (
  origin: string,
  clientKey: string,
  method: "GET" | "POST",
  endpoint: string,
  body?: string,
  extraParams?: Record<string, string>,
): Promise<{ status: number; text: string }> => {
  const qs = new URLSearchParams({ endpoint, clientKey, ...(extraParams ?? {}) });
  const res = await fetch(`${origin}/api/bmi?${qs.toString()}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body } : {}),
    cache: "no-store",
  });
  return { status: res.status, text: await res.text() };
};

const heatsMetaOf = (row: BowlingReservation): HeatMeta[] => {
  const meta = row.bookingMetadata as { heats?: unknown } | undefined;
  return meta && Array.isArray(meta.heats) ? (meta.heats as HeatMeta[]) : [];
};

export const persistHeatsMeta = async (reservationId: number, heats: HeatMeta[]): Promise<void> => {
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET booking_metadata = COALESCE(booking_metadata, '{}'::jsonb)
        || jsonb_build_object('heats', ${JSON.stringify(heats)}::jsonb)
    WHERE id = ${reservationId}
  `;
};

/**
 * Re-confirm the bill as a $0 credit + re-assert Pandora -3 (never auto-cancel).
 *
 * `comboSpecialId` is the anchor's — an Ultimate VIP Experience is put BACK on
 * "Confirmation - VIP" afterwards, because a bare -3 here would demote every
 * edited VIP reservation to plain Confirmation (owner 2026-08-02). Every caller
 * passes it; the anchor is in scope at all three sites.
 */
const reconfirmBill = async (
  origin: string,
  clientKey: string,
  billId: string,
  comboSpecialId?: string | null,
): Promise<void> => {
  const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${billId},"depositKind":2}`;
  const confirm = await proxyCall(origin, clientKey, "POST", "payment/confirm", confirmBody);
  if (confirm.status >= 400) {
    throw new Error(`BMI re-confirm failed (${confirm.status}): ${confirm.text.slice(0, 120)}`);
  }
  const pandoraKey = process.env.SWAGGER_ADMIN_KEY;
  const projectId = (BigInt(billId) + BigInt(1)).toString();
  if (pandoraKey) {
    await fetch("https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pandoraKey}` },
      body: JSON.stringify({
        locationID: RACE_PANDORA_LOCATION,
        projectId,
        stateID: "-3",
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      /* best-effort — the sweep re-asserts too */
    });
  }
  // Restore the VIP state on top of the -3 just written. Self-heal window
  // covers that Pandora write's async propagation; read-then-compare means a
  // cancelled or arrived project is left alone.
  await stampVipStateIfCombo({
    comboSpecialId,
    centerCode: "fasttrax",
    officeProjectId: projectId,
    tag: "reservation-edit",
    label: "Confirmation - VIP (edit re-confirm)",
    ensureAttempts: 4,
  });
};

export interface BmiSyncResult {
  detail: string;
  /**
   * REMOVE mode only: the heats that remain after the removal. NOT persisted
   * here — the executor writes them with the Neon commit, so
   * booking_metadata.heats only changes when the whole edit lands (a retry
   * after a later-step failure can still see, and re-price, the heat).
   */
  survivingHeats?: HeatMeta[];
  /** The row whose booking_metadata.heats those belong to (the race leg). */
  heatsRowId?: number;
}

/**
 * Apply the plan's race-leg delta to the live BMI bill. `mode` mirrors the
 * step being executed; ADD is fatal (runs before money), REMOVE is
 * best-effort-with-verify (runs after — excess capacity is safe, but a
 * silent failure isn't, so a failed remove throws for the step log).
 */
export const syncBmiRaceEdit = async (params: {
  editId: string;
  anchor: BowlingReservation;
  plan: EditPlan;
  mode: "add" | "remove";
  origin: string;
}): Promise<BmiSyncResult> => {
  const { anchor, plan, origin } = params;

  // Combos can be anchored from the BOWLING leg — the BMI bill and its heat
  // metadata live on the race leg, so resolve that leg's row.
  const raceLegPlan =
    plan.legs.find((l) => l.productKind === "race") ??
    plan.legs.find((l) => l.reservationId === anchor.id) ??
    plan.legs[0];
  const raceRow =
    raceLegPlan.reservationId === anchor.id
      ? anchor
      : ((await getBowlingReservation(raceLegPlan.reservationId)) ?? anchor);

  const billId = raceRow.bmiBillId;
  if (!billId) throw new EditGuardError("bmi_line_unavailable", "reservation has no BMI bill");
  // center_code is a mixed namespace (v1 rows: Square location ids) — a raw
  // compare would hand v1 Naples rows the Fort Myers key.
  const clientKey = resolveCenter(raceRow.centerCode, raceRow.productKind).bmiClientKey;

  const raceLeg = raceLegPlan;
  const heatsMeta = heatsMetaOf(raceRow);

  // ── Re-fetch the live bill BEFORE mutating (auto-cancel-pending lesson) ──
  const overviewBefore = await proxyCall(origin, clientKey, "GET", `order/${billId}/overview`);
  if (overviewBefore.status >= 400) {
    throw new Error(`BMI overview fetch failed (${overviewBefore.status})`);
  }
  let linesBefore = 0;
  try {
    linesBefore = (JSON.parse(overviewBefore.text).lines ?? []).length;
  } catch {
    throw new Error("BMI overview returned non-JSON");
  }
  if (linesBefore === 0) {
    throw new EditGuardError(
      "phase_conflict",
      "BMI bill has no lines (auto-cancelled?) — do not edit; investigate first",
    );
  }

  if (params.mode === "add") {
    // Prefer the plan's resolved per-racer booking plan: plan.ts resolves each
    // added racer's product PER HEAT at the racer's OWN category (an adult
    // joining junior heats books the adult counterpart product), so what was
    // priced is exactly what gets booked. Combo legs don't carry raceAdds —
    // fall back to joining each surviving slot's own product.
    let racerPlans: RaceAddPlan[] | null = raceLeg?.raceAdds ?? null;
    if (!racerPlans) {
      const specAdds = plan.spec.racers?.add ?? [];
      if (specAdds.length === 0) return { detail: "nothing to add" };
      const removeSet = new Set((raceLeg?.removedHeats ?? []).map((r) => r.index));
      const surviving = heatsMeta.filter((_, i) => !removeSet.has(i));
      const slots = new Map<string, HeatMeta>();
      for (const h of surviving) {
        if (h.heatId && h.productId && !slots.has(h.heatId)) slots.set(h.heatId, h);
      }
      if (slots.size === 0) {
        throw new EditGuardError("pricing_unresolvable", "no surviving heats to join");
      }
      racerPlans = specAdds.map((racer) => ({
        firstName: racer.firstName,
        lastName: racer.lastName ?? "",
        isNew: racer.isNew ?? false,
        bmiPersonId: racer.bmiPersonId ?? null,
        category: racer.category ?? "adult",
        heats: [...slots.values()].map((slot) => ({
          heatId: slot.heatId!,
          track: slot.track ?? null,
          tier: slot.tier ?? null,
          bmiProductId: slot.productId!,
        })),
      }));
    }
    if (racerPlans.length === 0) return { detail: "nothing to add" };

    const newHeats: HeatMeta[] = [];
    let booked = 0;
    for (const racer of racerPlans) {
      let firstHeat = true;
      for (const heat of racer.heats) {
        const withLicense = racer.isNew && firstHeat;
        firstHeat = false;
        const target = bmiBookingTarget(heat.bmiProductId, {
          withLicense,
          category: racer.category,
          tier: (heat.tier as RaceTier | null) ?? null,
          track: heat.track ?? null,
        });

        const availPayload = JSON.stringify({
          ProductId: Number(target.productId),
          PageId: Number(target.pageId),
          Quantity: 1,
          OrderId: null,
          PersonId: null,
          DynamicLines: [],
        });
        const avail = await proxyCall(origin, clientKey, "POST", "availability", availPayload, {
          date: heat.heatId.slice(0, 10),
        });
        if (avail.status >= 400) throw new Error(`BMI availability ${avail.status}`);
        let proposals: Proposal[] = [];
        try {
          const parsed = JSON.parse(avail.text) as {
            proposals?: Proposal[];
            Proposals?: Proposal[];
          };
          proposals = parsed.proposals ?? parsed.Proposals ?? [];
        } catch {
          throw new Error("BMI availability returned non-JSON");
        }
        const proposal = findProposalForHeat(proposals, heat.heatId);
        if (!proposal) {
          throw new EditGuardError(
            "heat_capacity",
            `heat ${heat.heatId} has no open spot for the added racer`,
          );
        }

        const bookPayload: Record<string, unknown> = {
          productId: String(target.productId),
          quantity: 1,
          resourceId: Number(proposal.blocks[0]?.block?.resourceId) || -1,
          proposal: {
            blocks: proposal.blocks.map((pb) => ({
              productLineIds: pb.productLineIds || [],
              block: { ...pb.block, resourceId: Number(pb.block?.resourceId) || -1 },
            })),
            productLineId: proposal.productLineId ?? null,
          },
        };
        const rawIds: Record<string, string> = { orderId: billId };
        if (racer.bmiPersonId) rawIds.personId = racer.bmiPersonId;
        const book = await proxyCall(
          origin,
          clientKey,
          "POST",
          "booking/book",
          stringifyWithRawIds(bookPayload, { rawIds }),
        );
        if (book.status >= 400) {
          throw new Error(`BMI booking/book ${book.status}: ${book.text.slice(0, 120)}`);
        }
        const lineMatch = book.text.match(/"billLineId"\s*:\s*(\d+)/);
        newHeats.push({
          productId: heat.bmiProductId,
          track: heat.track,
          heatId: heat.heatId,
          assignedTo: null,
          tier: heat.tier,
          category: racer.category,
          bmiPersonId: racer.bmiPersonId,
          racer: racer.firstName,
          bmiLineId: lineMatch ? lineMatch[1] : null,
        });
        booked++;
      }

      // Attach known returning racers to the project roster.
      if (racer.bmiPersonId) {
        const pBody =
          `{"personId":${racer.bmiPersonId},"orderId":${billId},` +
          JSON.stringify({ firstName: racer.firstName, lastName: racer.lastName }).slice(1);
        await proxyCall(origin, clientKey, "POST", "person/registerProjectPerson", pBody);
      }
    }

    await reconfirmBill(origin, clientKey, billId, anchor.comboSpecialId);

    // Verify-after: the bill grew by exactly the booked line count (license
    // build products ride the same line, so lines == heats booked).
    const overviewAfter = await proxyCall(origin, clientKey, "GET", `order/${billId}/overview`);
    let linesAfter = 0;
    try {
      linesAfter = (JSON.parse(overviewAfter.text).lines ?? []).length;
    } catch {
      /* fails the check below */
    }
    if (linesAfter < linesBefore + booked) {
      throw new Error(
        `BMI verify failed after add: lines ${linesBefore} → ${linesAfter}, expected +${booked}`,
      );
    }

    await persistHeatsMeta(raceRow.id, [...heatsMeta, ...newHeats]);
    return { detail: `booked ${booked} heat line(s) for ${racerPlans.length} racer(s)` };
  }

  // ── mode === "remove" ────────────────────────────────────────────────
  const removed = raceLeg?.removedHeats ?? [];
  if (removed.length === 0) return { detail: "nothing to remove" };
  const missing = removed.filter((r) => !r.bmiLineId);
  if (missing.length > 0) {
    throw new EditGuardError(
      "bmi_line_unavailable",
      `${missing.length} heat(s) have no BMI line id (booked before the stamp) — use cancel & rebook`,
    );
  }

  let removedCount = 0;
  let alreadyGone = 0;
  for (const r of removed) {
    // Idempotent for the retry window: a prior attempt may have removed this
    // line at BMI and then failed on a later step. A line the live bill no
    // longer carries is a success, not a 4xx. Presence is checked on the RAW
    // overview text — never JSON.parse a BMI body that carries line ids.
    const present = new RegExp(`"billLineId"\\s*:\\s*"?${r.bmiLineId}"?(?![0-9])`).test(
      overviewBefore.text,
    );
    if (!present && /"billLineId"/.test(overviewBefore.text)) {
      alreadyGone++;
      continue;
    }
    const body = stringifyWithRawIds({}, { rawIds: { orderId: billId, billLineId: r.bmiLineId! } });
    const res = await proxyCall(origin, clientKey, "POST", "booking/removeItem", body);
    if (res.status >= 400) {
      throw new Error(`BMI removeItem ${res.status} for line ${r.bmiLineId}`);
    }
    removedCount++;
  }

  if (removedCount > 0) await reconfirmBill(origin, clientKey, billId, anchor.comboSpecialId);

  const keep = heatsMeta.filter((_, i) => !removed.some((r) => r.index === i));
  return {
    detail:
      `removed ${removedCount} heat line(s)` +
      (alreadyGone > 0 ? ` (${alreadyGone} already gone from the bill)` : ""),
    survivingHeats: keep,
    heatsRowId: raceRow.id,
  };
};

/* ── Attraction add-on quantity edits ─────────────────────────────────── */

/**
 * Replace an attraction add-on's BMI line at a new quantity: removeItem the
 * booked line, then (for qty > 0) re-book the SAME slot at the new quantity
 * onto the same bill, verify availability first, and $0 re-confirm. The Neon
 * attraction_bookings JSONB is updated with the new quantity/total/line id.
 *
 * PRE phase only (plan.ts guards); gated behind RESERVATION_EDIT_V2_RACE
 * with the other BMI-touching edits.
 */
export const syncBmiAttractionEdit = async (params: {
  editId: string;
  anchor: BowlingReservation;
  plan: EditPlan;
  origin: string;
}): Promise<BmiSyncResult> => {
  const { anchor, plan, origin } = params;
  const changes = plan.legs.flatMap((l) => l.attractionChanges ?? []);
  if (changes.length === 0) return { detail: "nothing to change" };

  const bookings = [...(anchor.attractionBookings ?? [])];
  let applied = 0;

  for (const change of changes) {
    const booking = bookings[change.index];
    if (!booking || !change.bmiOrderId || !change.bmiBillLineId) {
      throw new EditGuardError("bmi_line_unavailable", `attraction ${change.name} has no BMI ids`);
    }
    const config = ATTRACTIONS[change.slug];
    if (!config) {
      throw new EditGuardError("bmi_line_unavailable", `unknown attraction slug ${change.slug}`);
    }
    // Location: HeadPinz building for the row's center (center_code is a
    // mixed namespace — resolve, don't raw-compare); fall back to the
    // config's only-products location (e.g. fasttrax-only attractions).
    let location: LocationKey =
      resolveCenter(anchor.centerCode, anchor.productKind).slug === "naples"
        ? "naples"
        : "headpinz";
    if (!config.products.some((p) => p.location === location)) {
      const fallback = config.products[0]?.location;
      if (!fallback) {
        throw new EditGuardError("bmi_line_unavailable", `${change.slug} has no products`);
      }
      location = fallback;
    }
    const product = config.products.find((p) => p.location === location);
    const pageId = config.pageIds[location];
    if (!product || !pageId) {
      throw new EditGuardError(
        "bmi_line_unavailable",
        `${change.slug} has no product/page at ${location}`,
      );
    }
    const clientKey = config.clientKeys?.[location] ?? "headpinzftmyers";
    const billId = change.bmiOrderId;

    // For INCREASES verify the slot still has room BEFORE touching the booked
    // line — never strand the guest with fewer spots than they started with.
    let proposal: Proposal | null = null;
    if (change.newQuantity > 0) {
      const availPayload = JSON.stringify({
        ProductId: Number(product.productId),
        PageId: Number(pageId),
        Quantity: change.newQuantity,
        OrderId: null,
        PersonId: null,
        DynamicLines: [],
      });
      const avail = await proxyCall(origin, clientKey, "POST", "availability", availPayload, {
        date: booking.timeSlot.slice(0, 10),
      });
      if (avail.status >= 400) throw new Error(`BMI availability ${avail.status}`);
      let proposals: Proposal[] = [];
      try {
        const parsed = JSON.parse(avail.text) as { proposals?: Proposal[]; Proposals?: Proposal[] };
        proposals = parsed.proposals ?? parsed.Proposals ?? [];
      } catch {
        throw new Error("BMI availability returned non-JSON");
      }
      proposal = findProposalForHeat(proposals, booking.timeSlot);
      if (!proposal) {
        // The CURRENT line still holds its spots — availability may show the
        // slot as full because of them. Accept when the target quantity does
        // not exceed the booked quantity (pure decrease-with-rebook).
        if (change.newQuantity > change.oldQuantity) {
          throw new EditGuardError(
            "heat_capacity",
            `${change.name} at ${booking.timeLabel} has no room for ${change.newQuantity}`,
          );
        }
      }
    }

    // Remove the booked line…
    const removeBody = stringifyWithRawIds(
      {},
      { rawIds: { orderId: billId, billLineId: change.bmiBillLineId } },
    );
    const removed = await proxyCall(origin, clientKey, "POST", "booking/removeItem", removeBody);
    if (removed.status >= 400) {
      throw new Error(`BMI removeItem ${removed.status} for attraction line`);
    }

    // …and re-book at the new quantity (skip at 0 = full removal).
    let newLineId: string | null = null;
    if (change.newQuantity > 0) {
      if (!proposal) {
        // Re-probe now that the old line released its spots.
        const availPayload = JSON.stringify({
          ProductId: Number(product.productId),
          PageId: Number(pageId),
          Quantity: change.newQuantity,
          OrderId: null,
          PersonId: null,
          DynamicLines: [],
        });
        const avail = await proxyCall(origin, clientKey, "POST", "availability", availPayload, {
          date: booking.timeSlot.slice(0, 10),
        });
        try {
          const parsed = JSON.parse(avail.text) as {
            proposals?: Proposal[];
            Proposals?: Proposal[];
          };
          proposal = findProposalForHeat(
            parsed.proposals ?? parsed.Proposals ?? [],
            booking.timeSlot,
          );
        } catch {
          proposal = null;
        }
      }
      if (!proposal) {
        throw new Error(
          `attraction slot ${booking.timeSlot} vanished after removing the old line — ` +
            `re-book ${change.name} manually (guest entitlement reduced!)`,
        );
      }
      const bookPayload: Record<string, unknown> = {
        productId: String(product.productId),
        quantity: change.newQuantity,
        resourceId: Number(proposal.blocks[0]?.block?.resourceId) || -1,
        proposal: {
          blocks: proposal.blocks.map((pb) => ({
            productLineIds: pb.productLineIds || [],
            block: { ...pb.block, resourceId: Number(pb.block?.resourceId) || -1 },
          })),
          productLineId: proposal.productLineId ?? null,
        },
      };
      const book = await proxyCall(
        origin,
        clientKey,
        "POST",
        "booking/book",
        stringifyWithRawIds(bookPayload, { rawIds: { orderId: billId } }),
      );
      if (book.status >= 400) {
        throw new Error(`BMI booking/book ${book.status}: ${book.text.slice(0, 120)}`);
      }
      newLineId = book.text.match(/"billLineId"\s*:\s*(\d+)/)?.[1] ?? null;
    }

    await reconfirmBill(origin, clientKey, billId, anchor.comboSpecialId);

    bookings[change.index] = {
      ...booking,
      quantity: change.newQuantity,
      totalPriceDollars: (change.unitPriceCents * change.newQuantity) / 100,
      bmiBillLineId: newLineId,
    };
    applied++;
  }

  // Persist the updated add-on record (quantity/total/line ids).
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET attraction_bookings = ${JSON.stringify(bookings.filter((b) => b.quantity > 0))}::jsonb
    WHERE id = ${anchor.id}
  `;
  return { detail: `${applied} attraction line(s) replaced` };
};
