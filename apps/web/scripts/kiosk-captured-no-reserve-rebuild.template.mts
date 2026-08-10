/**
 * TEMPLATE — rebuild a kiosk booking whose payment CAPTURED but whose reserve
 * never completed (no bowling_reservations row; BMI bill dead or missing).
 *
 * Read docs/sop-kiosk-captured-no-reserve-rebuild.md FIRST. This file is the
 * executable form of that SOP, proven live 2026-08-10 (Yocum, $420.68 → W59710).
 * Copy it to a per-incident script, fill in the CONFIG block from triage
 * (Square payment + kiosk_split_tenders + the surviving booking record at
 * GET /api/booking-record?billId={seed}), and run:
 *
 *   npx tsx scripts/<your-copy>.mts            # DRY RUN: capacity + $0 quote gate
 *   APPLY=1 npx tsx scripts/<your-copy>.mts    # book for real
 *
 * NO CHARGE anywhere: the cart re-books at $0 via a single-use 100% promo the
 * server re-resolves fail-closed, and the already-captured money is patched
 * onto the Neon rows afterward. Do NOT pass externalPayment to reserve-all —
 * on a fresh bill the baseKey differs and verification hard-fails (SOP §2).
 *
 * Hard rules honored throughout (tasks/lessons.md): BMI ids are raw-injected
 * into JSON bodies, never JSON.stringify'd or Number()'d; BMI responses are
 * read as raw text; registerProjectPerson's HTTP 200 is not success.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */

// ════════════════════════ CONFIG — fill from triage ════════════════════════
const APPLY = process.env.APPLY === "1";
const HOST = "https://fasttraxent.com";
const DATE = "YYYY-MM-DD"; // visit date
const CLIENT_KEY = "headpinzftmyers"; // BMI client key for the center
const RACING_LOCATION_ID = "LAB52GY480CJF"; // Pandora racing center (FastTrax FM)
const QAMF_CENTER_ID = 9172; // HeadPinz FM

// The money that already moved (verify in Square: COMPLETED, unrefunded):
const SQUARE_DEPOSIT_ORDER_ID = "FILL_ME";
const SQUARE_PAYMENT_ID = "FILL_ME";
const CAPTURED_CENTS = 0; // FILL — exact captured amount
const OLD_BILL_ID = "FILL_ME"; // the dead bill (= kiosk_split_tenders.seed)
const PROMO_CODE = `REBUILD-${DATE.replaceAll("-", "")}`; // single-use, audit-named

// Real per-leg totals (tax-incl) for the post-reserve Neon money patch — the
// per-leg pre-tax subtotals × (1 + tax) must sum to CAPTURED_CENTS:
const RACE_LEG_CENTS = 0; // FILL
const BOWL_LEG_CENTS = 0; // FILL

const CONTACT = {
  firstName: "FILL",
  lastName: "FILL",
  email: "fill@example.com",
  phone: "0000000000",
  smsOptIn: true,
};

// Party from the booking record. pandoraPersonId: set = bmiPersonId when the
// id is Pandora-short; leave unset for 17-digit Office ids (their grid seat
// may need the check-in flow / assign sweep).
const party: Array<{
  id: string;
  firstName: string;
  lastName: string;
  isNewRacer: boolean;
  bmiPersonId: string;
  pandoraPersonId?: string;
  category: "adult" | "junior";
  isBillingCustomer?: boolean;
}> = [
  // { id: randomUUID(), firstName: "…", lastName: "…", isNewRacer: false, bmiPersonId: "…", pandoraPersonId: "…", category: "adult", isBillingCustomer: true },
];

// Heats from the booking record. PageId comes from race-products.ts for these
// productIds (returning-racer weekday page is 43734751).
const PAGE = 43734751;
const HEAT_DEFS: Array<{ tier: "starter" | "intermediate" | "pro"; heatId: string; heatStop: string; productId: string; productName: string; track: "Blue" | "Red" | "Mega" }> = [
  // { tier: "starter", heatId: `${DATE}T18:48:00`, heatStop: `${DATE}T18:55:00`, productId: "43734325", productName: "Starter Race Blue", track: "Blue" },
];
const HEAT_SPECS = HEAT_DEFS.flatMap((h) => party.map((m) => ({ member: m, ...h })));

// Bowling leg from the booking record + /api/bowling/v2/experiences.
const BOWL = {
  experienceId: 0, // FILL from experiences payload
  experienceSlug: "vip-mon-thur",
  webOfferId: 0, // FILL
  optionId: 0, // FILL (duration option qamfOptionId)
  durationMinutes: 90,
  bookedAt: `${DATE}T19:45:00-04:00`, // center-local with offset, from availability
  laneCount: 1,
  playerCount: party.length,
  items: [] as Array<{ squareProductId: number; quantity: number; label: string; priceCents: number; depositPct: number; squareCatalogObjectId: string; sortOrder: number }>,
};

const POV_ZERO_PRODUCT_ID = "50361293"; // $0 POV build product (combo includedPovPerRacer)
const COMBO_SPECIAL_ID = "race-bowl-v2";
// ═══════════════════════════ END CONFIG ════════════════════════════════════

const BOOKING_API_KEY = process.env.BOOKING_API_KEY || "";
if (!BOOKING_API_KEY) throw new Error("BOOKING_API_KEY missing from .env.local");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HOST}${path}`, { ...init, headers: { "user-agent": UA, ...(init?.headers ?? {}) } });
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}
const rawField = (text: string, field: string): string | null => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return m ? m[1] : null;
};

// ── BMI availability via the deployed proxy ─────────────────────────────────
async function bmiAvailability(productId: string): Promise<any[]> {
  const data = await apiJson<{ proposals: any[] }>(
    `/api/bmi?endpoint=availability&date=${DATE}&clientKey=${CLIENT_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ProductId: Number(productId), PageId: PAGE, Quantity: 1, OrderId: null, PersonId: null, DynamicLines: [] }),
    },
  );
  return data.proposals ?? [];
}
const proposalFor = (proposals: any[], heatId: string) => proposals.find((p) => p.blocks?.[0]?.block?.start === heatId);

async function verifyCapacity(): Promise<void> {
  const need = new Map<string, { heatId: string; n: number }>();
  for (const s of HEAT_SPECS) {
    const cur = need.get(s.productId);
    if (cur) cur.n += 1;
    else need.set(s.productId, { heatId: s.heatId, n: 1 });
  }
  for (const [pid, { heatId, n }] of need) {
    const prop = proposalFor(await bmiAvailability(pid), heatId);
    if (!prop) throw new Error(`Heat ${heatId} (product ${pid}) not in dayplanner`);
    const b = prop.blocks[0].block;
    if (b.freeSpots < n) throw new Error(`Heat ${heatId}: only ${b.freeSpots} free, need ${n}`);
    console.log(`[heats] ${heatId} product ${pid}: free ${b.freeSpots}/${b.capacity} ✔`);
  }
}

// ── single-use 100% promo (the no-recharge lever; server re-resolves it) ────
async function ensurePromo(): Promise<void> {
  const { sql } = await import("@/lib/db");
  const q = sql();
  const existing = (await q`SELECT id, uses_count, max_uses, active FROM discount_codes WHERE UPPER(code) = ${PROMO_CODE}`) as Array<Record<string, unknown>>;
  if (existing.length) {
    console.log(`[promo] ${PROMO_CODE} exists (uses ${existing[0].uses_count}/${existing[0].max_uses}, active=${existing[0].active})`);
    return;
  }
  await q`
    INSERT INTO discount_codes
      (code, description, mechanic, amount_pct, starts_at, expires_at,
       booking_date_start, booking_date_end, scopes, max_uses, active, created_by)
    VALUES
      (${PROMO_CODE},
       ${`REBUILD of PAID kiosk booking ${DATE} — money already captured on Square payment ${SQUARE_PAYMENT_ID} (deposit order ${SQUARE_DEPOSIT_ORDER_ID}); orig BMI bill ${OLD_BILL_ID} died after capture. Code exists ONLY so reserve-all re-books at $0 without re-charging. See docs/sop-kiosk-captured-no-reserve-rebuild.md`},
       'percent', 100, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '12 hours',
       ${DATE}, ${DATE}, ${'{"racing":{},"bowling":{}}'}::jsonb, 1, TRUE, 'captured-no-reserve-rebuild')
  `;
  console.log(`[promo] created ${PROMO_CODE}`);
}

// ── session builder (unified v2 shape — wizard/kiosk parity) ────────────────
function buildSession(opts: { bmiBillId: string | null; bmiLineIds: Map<number, string>; qamfReservationId: string | null }) {
  const naive = BOWL.bookedAt.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const raceItem = {
    id: randomUUID(),
    kind: "race",
    date: DATE,
    productIdAdult: null,
    productIdJunior: null,
    productTrackAdult: null,
    productTrackJunior: null,
    packageIdAdult: null,
    packageIdJunior: null,
    povQuantity: party.length,
    povSold: true,
    rookiePack: null,
    addons: [],
    heats: HEAT_SPECS.map((s, i) => ({
      productId: s.productId,
      track: s.track,
      tier: s.tier,
      category: s.member.category,
      heatId: s.heatId,
      bmiLineId: opts.bmiLineIds.get(i) ?? null,
      assignedTo: s.member.id,
    })),
  };
  const bowlingItem = {
    id: randomUUID(),
    kind: "bowling",
    variant: "hourly",
    tier: "vip",
    date: DATE,
    hour: parseInt(naive.slice(11, 13), 10),
    minute: parseInt(naive.slice(14, 16), 10),
    bookedAt: BOWL.bookedAt,
    experienceId: BOWL.experienceId,
    experienceSlug: BOWL.experienceSlug,
    webOfferId: BOWL.webOfferId,
    optionId: BOWL.optionId,
    optionType: "Time",
    laneCount: BOWL.laneCount,
    durationMinutes: BOWL.durationMinutes,
    durationMultiplier: 1,
    playerCount: BOWL.playerCount,
    assignedTo: [],
    shoeSelections: {},
    attractionAddons: [],
    pizzaModifierSelections: [{}],
    qamfReservationId: opts.qamfReservationId,
    qamfCenterId: QAMF_CENTER_ID,
    lineItems: BOWL.items.map((ei) => ({
      squareProductId: ei.squareProductId,
      quantity: ei.quantity * BOWL.laneCount,
      label: ei.label,
      priceCents: ei.priceCents,
      depositPct: ei.depositPct,
      squareCatalogObjectId: ei.squareCatalogObjectId,
    })),
    rawItems: [],
    quoteDayofOrderId: null,
    quoteTotalCents: 0,
    quoteDepositCents: 0,
    quoteDiscountOffCents: 0,
    hasBookingFee: false, // the kiosk charged without a booking fee — keep parity
    discountCode: null,
    isWorldCup: false,
    worldCupMatchId: null,
    isDuckpin: false,
  };
  return {
    squareOrderId: null,
    bmiBillId: opts.bmiBillId,
    entryBrand: "fasttrax",
    center: "fort-myers",
    contact: CONTACT,
    // kiosk context: deposit-location parity + the kiosk post-reserve rail
    // (guest email/SMS, memo, Pandora -3, Confirmation-VIP state).
    context: { kiosk: true },
    appliedPromo: {
      code: PROMO_CODE,
      domains: ["racing", "bowling"],
      scopes: { racing: {}, bowling: {} },
      startsAt: `${DATE}T00:00:00.000Z`,
      expiresAt: null,
      allowedWeekdays: null,
      bookingDateStart: DATE,
      bookingDateEnd: DATE,
      mechanic: "percent",
      amountPct: 100,
      amountCents: null,
      squareCatalogId: null,
    },
    comboSpecialId: COMBO_SPECIAL_ID,
    party,
    items: [raceItem, bowlingItem],
    activeItemId: null,
    cursors: {},
  };
}

// ════════════════════════════ MAIN ═════════════════════════════════════════
if (!party.length || !HEAT_DEFS.length || !CAPTURED_CENTS || SQUARE_PAYMENT_ID === "FILL_ME") {
  throw new Error("CONFIG incomplete — fill the block at the top from triage.");
}
await verifyCapacity();
await ensurePromo();

{
  const session = buildSession({ bmiBillId: null, bmiLineIds: new Map(), qamfReservationId: null });
  const quote = await apiJson<{ totalCents?: number }>(`/api/booking/v2/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session }),
  });
  console.log("\n[quote]", JSON.stringify(quote, null, 1).slice(0, 2500));
  // With the 100% promo the server MUST price the cart at $0 — that is what
  // guarantees reserve-all never attempts a charge.
  if (quote.totalCents !== 0) throw new Error(`quote totalCents ${quote.totalCents} != 0 with promo — DO NOT APPLY`);
  console.log(`[quote] $0 with ${PROMO_CODE} ✔ (real money already captured: ${CAPTURED_CENTS}¢)`);
}

if (!APPLY) {
  console.log("\nDRY RUN complete. Run with APPLY=1 to book.");
  process.exit(0);
}

// ── 1. book the heats (chained onto one fresh bill) ─────────────────────────
let billId: string | null = null;
const bmiLineIds = new Map<number, string>();
for (let i = 0; i < HEAT_SPECS.length; i++) {
  const s = HEAT_SPECS[i];
  const prop = proposalFor(await bmiAvailability(s.productId), s.heatId);
  if (!prop) throw new Error(`Heat vanished: ${s.heatId}`);
  const payload = {
    productId: s.productId,
    quantity: 1,
    resourceId: Number(prop.blocks[0].block.resourceId) || -1,
    proposal: {
      blocks: prop.blocks.map((pb: any) => ({
        productLineIds: pb.productLineIds || [],
        block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
      })),
      productLineId: prop.productLineId ?? null,
    },
  };
  // raw-inject orderId — a 17-digit BMI id must NEVER pass through JSON.stringify
  let body = JSON.stringify(payload);
  if (billId) body = `{"orderId":${billId},` + body.slice(1);
  const res = await api(`/api/bmi?endpoint=booking%2Fbook&clientKey=${CLIENT_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  let parsed: { success?: boolean; errorMessage?: string | null } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`booking/book non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (parsed.success === false) throw new Error(`booking/book failed at heat ${i} (${s.heatId}): ${parsed.errorMessage}`);
  const rawOrderId = rawField(text, "orderId");
  if (!rawOrderId) throw new Error(`booking/book returned no orderId at heat ${i}`);
  if (billId && rawOrderId !== billId) throw new Error(`ABORT: heat ${i + 1} landed on bill ${rawOrderId}, expected ${billId}`);
  const lineId = rawField(text, "orderItemId");
  if (lineId) bmiLineIds.set(i, lineId);
  if (!billId) {
    billId = rawOrderId;
    // attach the contact the moment the bill exists (wizard parity)
    const regBody =
      `{"orderId":${billId},` +
      JSON.stringify({ firstName: CONTACT.firstName, lastName: CONTACT.lastName, email: CONTACT.email, phone: CONTACT.phone }).slice(1);
    const r = await api(`/api/bmi?endpoint=person%2FregisterContactPerson&clientKey=${CLIENT_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: regBody,
    });
    console.log(`[contact] registerContactPerson → ${r.status}`);
  }
  console.log(`[book] heat ${i + 1}/${HEAT_SPECS.length} ${s.heatId} ${s.member.firstName} (${s.tier}) → line ${lineId ?? "?"} bill ${billId}`);
}
if (!billId) throw new Error("No BMI bill created");

// ── 2. $0 POV × racers on the bill ──────────────────────────────────────────
{
  const res = await api(`/api/sms?endpoint=booking%2Fsell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ productId: POV_ZERO_PRODUCT_ID, pageId: null, quantity: party.length, billId, dynamicLines: null, sellKind: 0 }]),
  });
  console.log(`[pov] sell POV ×${party.length} → ${res.status}`);
}

// ── 3. fresh QAMF hold (old holds from the dead session are expired) ────────
const hold = await apiJson<{ qamfReservationId?: string; error?: string }>(`/api/bowling/v2/reserve/hold`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    centerId: QAMF_CENTER_ID,
    webOfferId: BOWL.webOfferId,
    optionId: BOWL.optionId,
    optionType: "Time",
    bookedAt: BOWL.bookedAt,
    players: BOWL.playerCount,
    service: "BookForLater",
  }),
});
if (!hold.qamfReservationId) throw new Error(`Lane hold failed: ${hold.error}`);
console.log(`[lane] QAMF hold ${hold.qamfReservationId}`);

const session = buildSession({ bmiBillId: billId, bmiLineIds, qamfReservationId: hold.qamfReservationId });

// ── 4. booking record for the NEW bill, BEFORE reserve ──────────────────────
await apiJson(`/api/booking-record`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
  body: JSON.stringify({
    billId,
    billIds: [billId],
    contact: { firstName: CONTACT.firstName, lastName: CONTACT.lastName, email: CONTACT.email, phone: CONTACT.phone },
    primaryPersonId: party.find((m) => m.isBillingCustomer)?.bmiPersonId ?? null,
    racers: HEAT_SPECS.map((s) => ({
      racerName: `${s.member.firstName} ${s.member.lastName}`.trim(),
      personId: s.member.bmiPersonId,
      product: s.productName,
      productId: s.productId,
      tier: s.tier, // tier/category/heatStop are REQUIRED by /bmi/schedule
      track: s.track,
      category: s.member.category,
      heatStart: s.heatId,
      heatStop: s.heatStop,
      heatName: s.productName,
    })),
    isCreditOrder: false,
    cashOwed: 0,
    creditApplied: 0,
    totalAmount: CAPTURED_CENTS / 100,
    date: DATE,
    createdAt: new Date().toISOString(),
    status: "pending_payment",
    rookiePack: false,
    package: null,
    comboSpecial: COMBO_SPECIAL_ID,
    rebuiltFrom: OLD_BILL_ID,
    squareDepositOrderId: SQUARE_DEPOSIT_ORDER_ID,
    squarePaymentId: SQUARE_PAYMENT_ID,
    bowling: [
      {
        kind: "bowling",
        date: DATE,
        bookedAt: BOWL.bookedAt,
        experienceSlug: BOWL.experienceSlug,
        laneCount: BOWL.laneCount,
        playerCount: BOWL.playerCount,
        qamfReservationId: hold.qamfReservationId,
        isDuckpin: false,
      },
    ],
  }),
});
console.log(`[record] bookingrecord:${billId} created (rebuiltFrom ${OLD_BILL_ID})`);

// ── 5. RESERVE at $0 — no card token, no externalPayment, nothing can charge ─
const reserveRes = await api(`/api/booking/v2/reserve-all`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ session, contact: CONTACT }),
});
const reserveText = await reserveRes.text();
if (!reserveRes.ok) throw new Error(`reserve-all ${reserveRes.status}: ${reserveText.slice(0, 800)}`);
const result = JSON.parse(reserveText) as Record<string, any>;
console.log("\n[reserve-all] OK:", JSON.stringify(result, null, 1).slice(0, 3000));
const resNumber = (result.bmiReservationNumber ?? result.reservationNumber ?? null) as string | null;
const resCode = (result.reservationCode ?? result.bmiReservationCode ?? null) as string | null;

// ── 6. patch the REAL money linkage onto the Neon rows ──────────────────────
{
  const { sql } = await import("@/lib/db");
  const q = sql();
  const noteTag = `\n[REBUILD ${DATE}] Paid AT KIOSK ${(CAPTURED_CENTS / 100).toFixed(2)} — Square payment ${SQUARE_PAYMENT_ID} on deposit order ${SQUARE_DEPOSIT_ORDER_ID}. Orig bill ${OLD_BILL_ID} died after capture; rebooked via ${PROMO_CODE} at $0 so no second charge exists. Day-of orders are $0 (promo) — do NOT collect anything at settle; money is on the deposit order.`;
  const race = (await q`
    UPDATE bowling_reservations
    SET square_deposit_order_id = ${SQUARE_DEPOSIT_ORDER_ID},
        square_deposit_payment_id = ${SQUARE_PAYMENT_ID},
        deposit_cents = ${RACE_LEG_CENTS}, total_cents = ${RACE_LEG_CENTS},
        notes = COALESCE(notes, '') || ${noteTag}
    WHERE bmi_bill_id::text = ${billId} AND product_kind = 'race'
    RETURNING id
  `) as any[];
  const bowl = (await q`
    UPDATE bowling_reservations
    SET square_deposit_order_id = ${SQUARE_DEPOSIT_ORDER_ID},
        square_deposit_payment_id = ${SQUARE_PAYMENT_ID},
        deposit_cents = ${BOWL_LEG_CENTS}, total_cents = ${BOWL_LEG_CENTS},
        notes = COALESCE(notes, '') || ${noteTag}
    WHERE qamf_reservation_id = ${hold.qamfReservationId} AND product_kind = 'open'
    RETURNING id
  `) as any[];
  console.log(`[money-patch] race row(s): ${race.map((r) => r.id).join(",") || "NONE"}  bowling row(s): ${bowl.map((r) => r.id).join(",") || "NONE"}`);
}

// ── 7. records: confirm the new, point the orphan at the rebuild ────────────
await apiJson(`/api/booking-record`, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
  body: JSON.stringify({ billId, reservationNumber: resNumber, reservationCode: resCode, status: "confirmed", confirmedAt: new Date().toISOString() }),
}).catch((e) => console.warn("[record] PATCH failed (non-fatal):", e.message));
await apiJson(`/api/booking-record`, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
  body: JSON.stringify({ billId: OLD_BILL_ID, rebuiltTo: billId, rebuildNote: `Rebuilt onto ${billId} at ${new Date().toISOString()} (captured-no-reserve).` }),
}).catch((e) => console.warn("[record] old-bill PATCH failed (non-fatal):", e.message));

// ── 8. attach projectPersons + push the grid (the rail does NOT do this on a
//       rebuild: heats were booked without PersonId → person_not_on_project) ─
{
  const BMI = process.env.BMI_API_URL || "https://api.bmileisure.com";
  const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
  const auth = await fetch(`${BMI}/auth/${CLIENT_KEY}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
    body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
  });
  const tok = (await auth.text()).match(/"[Aa]ccessToken"\s*:\s*"([^"]+)"/)?.[1];
  if (!tok) throw new Error("BMI auth failed for projectPerson attach");
  for (const p of party) {
    const namesJson = JSON.stringify({ firstName: p.firstName, lastName: p.lastName });
    const res = await fetch(`${BMI}/public-booking/${CLIENT_KEY}/person/registerProjectPerson`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "BMI-Subscription-Key": SUB, "Content-Type": "application/json", "Accept-Language": "en" },
      body: `{"personId":${p.bmiPersonId},"orderId":${billId},` + namesJson.slice(1),
      cache: "no-store",
    });
    const body = await res.text().catch(() => "");
    let declaredFailure = false;
    try {
      declaredFailure = (JSON.parse(body) as any).success === false; // 200 ≠ success on this endpoint
    } catch {
      /* non-JSON 2xx = pass */
    }
    console.log(`[attach] ${p.firstName} ${p.lastName} → HTTP ${res.status}${declaredFailure ? " success=false" : " OK"}`);
  }

  if (!resNumber) {
    console.warn("[grid] no reservation number returned — push the grid manually once known");
  } else {
    const KEY = process.env.SWAGGER_ADMIN_KEY || "";
    const racers = HEAT_SPECS.map((s) => ({
      racerName: `${s.member.firstName} ${s.member.lastName}`.trim(),
      personId: s.member.pandoraPersonId ?? s.member.bmiPersonId,
      product: s.productName,
      productId: s.productId,
      tier: s.tier,
      track: s.track,
      category: s.member.category,
      heatName: s.productName,
      heatStart: s.heatId,
      heatStop: s.heatStop,
    }));
    // attach→schedule propagation lag: retry until every racer is inserted or
    // already_linked (idempotent per racer).
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(`https://bma-pandora-api.azurewebsites.net/v2/bmi/schedule/${RACING_LOCATION_ID}/${resNumber}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ racers }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let done = 0;
      try {
        const d = JSON.parse(text) as any;
        for (const r of d?.data?.results ?? []) {
          console.log(`[grid] attempt ${attempt}: ${r.racerName} ${r.heatStart?.slice(11, 16)} ${r.status}`);
          if (r.status === "inserted" || r.status === "already_linked") done++;
        }
      } catch {
        console.log(`[grid] attempt ${attempt} → HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      if (done === racers.length) {
        console.log("[grid] ALL SEATED ✔");
        break;
      }
      if (attempt < 5) await new Promise((r) => setTimeout(r, 12_000));
      else console.warn("[grid] STILL INCOMPLETE — seat the remainder manually or let race-session-assign-sweep retry");
    }
  }
}

console.log("\n──────────────────────────────────────────");
console.log(`REBUILT. bill=${billId} res=${resNumber ?? "?"} code=${resCode ?? "?"} qamf=${hold.qamfReservationId}`);
console.log(`Money: Square ${SQUARE_PAYMENT_ID} ${(CAPTURED_CENTS / 100).toFixed(2)} CAPTURED — nothing charged by this script.`);
console.log(`Verify per docs/sop-kiosk-captured-no-reserve-rebuild.md §5 (BMI overview, Neon rows, QAMF proxy, booking record, Vercel logs).`);
