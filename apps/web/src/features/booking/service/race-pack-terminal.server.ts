/**
 * STANDALONE kiosk race-pack purchase (server only) — the attract-screen
 * "Race Packs" flow. A locked, pack-only sale on its OWN small Square order
 * (owner: "race packs sold via the standalone would go on the current square
 * order" — i.e. this flow's order), charged card-present on the paired reader.
 * Verbatim clone of the game-cards terminal rail's two-phase shape:
 *
 *   prepare()  — validate + persist one ledger row per pack (persist-first) +
 *                create the Square order the reader will charge. NOTHING
 *                charges here.
 *   finalize() — the reader captured the card against that order; verify the
 *                payment server-side (COMPLETED + OUR stored order + the
 *                order's own total + location), mark rows charged, grant the
 *                credits (grantKioskRacePacks — NX-idempotent, sweep-recovered).
 *
 * There is structurally NO card token here → no double-charge path.
 * FastTrax kiosks only for v1: race packs are FastTrax revenue and the order
 * must live at the reader's own Square location (INVALID_LOCATION lesson).
 */
import { randomBytes } from "crypto";
import {
  kioskRacePacksEnabled,
  resolveKioskPacks,
  kioskPacksTotalCents,
  type ResolvedKioskPack,
} from "./race-pack-kiosk";
import { getRacePack, racePackLabel, SQUARE_RACE_PACK_CATALOG_ID } from "../data/packs";
import { LOCATION_TAX, SQUARE_LOCATIONS } from "../data/square-catalog-map";
import {
  upsertPackPurchases,
  stampPackOrder,
  getPackPurchases,
  markPackCharged,
} from "../data/race-pack-purchases-db";
import { grantKioskRacePacks, type PackGrantOutcome } from "./race-pack-grant.server";
import { readSquarePaymentSettled } from "~/features/game-cards/data/square-order";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const sqHeaders = () => ({
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-06-04",
});

export class RacePackHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RacePackHttpError";
  }
}

export interface StandalonePackInput {
  slug: string;
  /** Raw BMI person id string — NEVER Number() it. */
  personId: string;
  memberName: string;
}

/** v1: FastTrax kiosks only (race packs are FastTrax revenue; the order must
 *  live at the reader's Square location). */
const PACK_SQUARE_LOCATION = SQUARE_LOCATIONS.FASTTRAX_FM;

function resolveStandalone(packs: StandalonePackInput[]): ResolvedKioskPack[] {
  if (!kioskRacePacksEnabled()) {
    throw new RacePackHttpError(403, "Race packs aren't available right now.");
  }
  if (packs.length === 0) throw new RacePackHttpError(400, "Add at least one race pack.");
  for (const p of packs) {
    if (!/^\d{1,20}$/.test(p.personId)) {
      throw new RacePackHttpError(400, "A racer account couldn't be verified.");
    }
  }
  // resolveKioskPacks does the rest fail-closed: offered-today check (day
  // rule), one-pack-per-person, catalog re-derivation of every price.
  return resolveKioskPacks(
    packs.map((p) => ({ slug: p.slug, memberId: p.personId })),
    packs.map((p) => ({
      id: p.personId,
      firstName: p.memberName.split(" ")[0] || p.memberName,
      lastName: p.memberName.split(" ").slice(1).join(" ") || undefined,
      bmiPersonId: p.personId,
    })),
  );
}

export interface StandalonePrepareResult {
  purchaseKey: string;
  orderId: string;
  /** Tax-inclusive order total — what the reader charges. */
  totalCents: number;
}

export async function prepareStandalonePackPurchase(
  packs: StandalonePackInput[],
): Promise<StandalonePrepareResult> {
  const resolved = resolveStandalone(packs);
  const purchaseKey = `sp-${randomBytes(8).toString("hex")}`;

  // Persist BEFORE the order exists (throws if the DB is down → no money moves).
  await upsertPackPurchases({ purchaseKey, surface: "standalone", packs: resolved });

  const taxId = LOCATION_TAX[PACK_SQUARE_LOCATION];
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `race-pack-${purchaseKey}`,
      order: {
        location_id: PACK_SQUARE_LOCATION,
        reference_id: purchaseKey.slice(0, 40),
        line_items: resolved.map((p) => ({
          name: `Race Pack — ${p.label} · ${p.memberName}`,
          quantity: "1",
          catalog_object_id: SQUARE_RACE_PACK_CATALOG_ID,
          base_price_money: { amount: p.priceCents, currency: "USD" },
        })),
        // Same order-scope county tax as every other order at this location —
        // web race-pack sales are taxed, kiosk parity.
        ...(taxId ? { taxes: [{ catalog_object_id: taxId, scope: "ORDER" }] } : {}),
      },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.errors || !data.order?.id) {
    const e = data.errors?.[0];
    throw new RacePackHttpError(
      502,
      `Couldn't start the payment: ${e?.detail ?? e?.code ?? res.status}`,
    );
  }
  const orderId: string = data.order.id;
  const totalCents: number = data.order.total_money?.amount ?? kioskPacksTotalCents(resolved);
  await stampPackOrder(purchaseKey, orderId);
  console.log(
    `[race-pack] standalone PREPARE ${purchaseKey}: ${resolved.length} pack(s), order ${orderId}, total ${totalCents}`,
  );
  return { purchaseKey, orderId, totalCents };
}

export interface StandaloneFinalizeResult {
  ok: true;
  packs: Array<{
    memberName: string;
    label: string;
    raceCount: number;
    granted: boolean;
  }>;
}

export async function finalizeStandalonePackPurchase(input: {
  purchaseKey: string;
  externalPayment: { paymentId: string; orderId: string; amountCents: number };
}): Promise<StandaloneFinalizeResult> {
  // Server-authoritative rows — the client only carries the purchaseKey pointer.
  const rows = await getPackPurchases(input.purchaseKey);
  if (rows.length === 0) {
    throw new RacePackHttpError(
      400,
      "We couldn't match your payment to the order. Please see the front desk.",
    );
  }
  const storedOrderId = rows[0].squareOrderId;
  if (!storedOrderId || storedOrderId !== input.externalPayment.orderId) {
    throw new RacePackHttpError(
      402,
      "That payment doesn't match this order. Please see the front desk (do not pay again).",
    );
  }

  // Verify the reader payment (displayed==charged tripwire): COMPLETED, OUR
  // order, the ORDER's own tax-inclusive total (re-fetched, never the client's),
  // our location.
  const pay = await readSquarePaymentSettled(input.externalPayment.paymentId);
  if (!pay || pay.status !== "COMPLETED") {
    throw new RacePackHttpError(
      402,
      "We couldn't confirm the reader payment. Please see the front desk (do not pay again).",
    );
  }
  if (pay.orderId && pay.orderId !== storedOrderId) {
    throw new RacePackHttpError(
      402,
      "That payment doesn't match this order. Please see the front desk.",
    );
  }
  if (pay.locationId && pay.locationId !== PACK_SQUARE_LOCATION) {
    throw new RacePackHttpError(402, "Payment location mismatch. Please see the front desk.");
  }
  const orderRes = await fetch(`${SQUARE_BASE}/orders/${storedOrderId}`, { headers: sqHeaders() });
  const orderData = await orderRes.json();
  const orderTotal: number | undefined = orderData.order?.total_money?.amount;
  if (typeof orderTotal !== "number" || pay.amountCents !== orderTotal) {
    throw new RacePackHttpError(
      402,
      "The charged amount didn't match the order. Please see the front desk.",
    );
  }

  await markPackCharged(input.purchaseKey, {
    squareOrderId: storedOrderId,
    squarePaymentId: input.externalPayment.paymentId,
  });

  // Rebuild resolved packs from OUR rows (never client data) for the grant.
  const resolved: ResolvedKioskPack[] = rows.map((r) => {
    const pack = getRacePack(r.packSlug);
    if (!pack) throw new RacePackHttpError(500, `Unknown pack on ledger: ${r.packSlug}`);
    return {
      slug: r.packSlug,
      pack,
      memberId: r.personId,
      personId: r.personId,
      memberName: r.memberName ?? "Racer",
      label: r.packLabel ?? racePackLabel(pack),
      priceCents: r.priceCents,
    };
  });
  const outcomes: PackGrantOutcome[] = await grantKioskRacePacks({
    purchaseKey: input.purchaseKey,
    packs: resolved,
  });

  return {
    ok: true,
    packs: resolved.map((p) => ({
      memberName: p.memberName,
      label: p.label,
      raceCount: p.pack.raceCount,
      granted: outcomes.find((o) => o.memberId === p.memberId)?.granted ?? false,
    })),
  };
}
