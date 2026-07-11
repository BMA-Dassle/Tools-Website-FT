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
import type { BowlingReservation } from "@/lib/bowling-db";
import { bmiBookingTarget } from "~/features/booking/service/race-products";

import type { EditPlan } from "./plan";
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

const heatsMetaOf = (anchor: BowlingReservation): HeatMeta[] => {
  const meta = anchor.bookingMetadata as { heats?: unknown } | undefined;
  return meta && Array.isArray(meta.heats) ? (meta.heats as HeatMeta[]) : [];
};

const persistHeatsMeta = async (reservationId: number, heats: HeatMeta[]): Promise<void> => {
  const q = sql();
  await q`
    UPDATE bowling_reservations
    SET booking_metadata = COALESCE(booking_metadata, '{}'::jsonb)
        || jsonb_build_object('heats', ${JSON.stringify(heats)}::jsonb)
    WHERE id = ${reservationId}
  `;
};

/** Re-confirm the bill as a $0 credit + re-assert Pandora -3 (never auto-cancel). */
const reconfirmBill = async (origin: string, clientKey: string, billId: string): Promise<void> => {
  const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${billId},"depositKind":2}`;
  const confirm = await proxyCall(origin, clientKey, "POST", "payment/confirm", confirmBody);
  if (confirm.status >= 400) {
    throw new Error(`BMI re-confirm failed (${confirm.status}): ${confirm.text.slice(0, 120)}`);
  }
  const pandoraKey = process.env.SWAGGER_ADMIN_KEY;
  if (pandoraKey) {
    const projectId = (BigInt(billId) + BigInt(1)).toString();
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
};

export interface BmiSyncResult {
  detail: string;
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
  const billId = anchor.bmiBillId;
  if (!billId) throw new EditGuardError("bmi_line_unavailable", "reservation has no BMI bill");
  const clientKey = anchor.centerCode === "naples" ? "headpinznaples" : "headpinzftmyers";

  const raceLeg = plan.legs.find((l) => l.reservationId === anchor.id);
  const heatsMeta = heatsMetaOf(anchor);

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
    const adds = plan.spec.racers?.add ?? [];
    if (adds.length === 0) return { detail: "nothing to add" };
    const removeSet = new Set((raceLeg?.removedHeats ?? []).map((r) => r.index));
    const surviving = heatsMeta.filter((_, i) => !removeSet.has(i));
    const slots = new Map<string, HeatMeta>();
    for (const h of surviving) {
      if (h.heatId && h.productId && !slots.has(h.heatId)) slots.set(h.heatId, h);
    }
    if (slots.size === 0) {
      throw new EditGuardError("pricing_unresolvable", "no surviving heats to join");
    }

    const newHeats: HeatMeta[] = [];
    let booked = 0;
    for (const racer of adds) {
      let firstHeat = true;
      for (const slot of slots.values()) {
        const withLicense = (racer.isNew ?? false) && firstHeat;
        firstHeat = false;
        const target = bmiBookingTarget(slot.productId!, {
          withLicense,
          track: slot.track ?? null,
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
          date: slot.heatId!.slice(0, 10),
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
        const proposal = findProposalForHeat(proposals, slot.heatId!);
        if (!proposal) {
          throw new EditGuardError(
            "heat_capacity",
            `heat ${slot.heatId} has no open spot for the added racer`,
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
          productId: slot.productId ?? null,
          track: slot.track ?? null,
          heatId: slot.heatId ?? null,
          assignedTo: null,
          tier: slot.tier ?? null,
          category: racer.category ?? "adult",
          bmiPersonId: racer.bmiPersonId ?? null,
          racer: racer.firstName,
          bmiLineId: lineMatch ? lineMatch[1] : null,
        });
        booked++;
      }

      // Attach known returning racers to the project roster.
      if (racer.bmiPersonId) {
        const pBody =
          `{"personId":${racer.bmiPersonId},"orderId":${billId},` +
          JSON.stringify({ firstName: racer.firstName, lastName: racer.lastName ?? "" }).slice(1);
        await proxyCall(origin, clientKey, "POST", "person/registerProjectPerson", pBody);
      }
    }

    await reconfirmBill(origin, clientKey, billId);

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

    await persistHeatsMeta(anchor.id, [...heatsMeta, ...newHeats]);
    return { detail: `booked ${booked} heat line(s) for ${adds.length} racer(s)` };
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
  for (const r of removed) {
    const body = stringifyWithRawIds({}, { rawIds: { orderId: billId, billLineId: r.bmiLineId! } });
    const res = await proxyCall(origin, clientKey, "POST", "booking/removeItem", body);
    if (res.status >= 400) {
      throw new Error(`BMI removeItem ${res.status} for line ${r.bmiLineId}`);
    }
    removedCount++;
  }

  await reconfirmBill(origin, clientKey, billId);

  const keep = heatsMeta.filter((_, i) => !removed.some((r) => r.index === i));
  await persistHeatsMeta(anchor.id, keep);
  return { detail: `removed ${removedCount} heat line(s)` };
};
