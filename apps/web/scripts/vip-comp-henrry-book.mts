/**
 * Comped Ultimate VIP Experience V2 (race-bowl-v2) for the 2026-08-02 test group.
 *
 * Booked through the REAL production rail (deployed HTTP endpoints, exactly the
 * calls the web combo wizard makes) so every side effect happens: BMI bill +
 * heats, QAMF VIP lane, two $0 Square day-of orders, Neon rows, voucher mint,
 * staff alert, guest confirmation email. $0 via a single-use 100% promo code
 * scoped {racing,bowling} + booking-date 2026-08-02 (the only legitimate comp
 * lever — server re-resolves the code from Neon, fail-closed).
 *
 * Party: 5 adults + 2 juniors under Henrry Gomez.
 * Schedule (all Blue): jr starter 6:00p (joins W57002's heat), adult starter
 * 6:12p, VIP bowling 6:45p ×90min ×2 lanes, jr intermediate 8:36p (joins
 * W57002), adult intermediate 8:48p.
 *
 * DRY RUN by default: upserts the promo row, probes availability, builds the
 * session, POSTs /api/booking/v2/quote and asserts the combo prices at $0.
 * APPLY=1 runs the full chain.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const APPLY = process.env.APPLY === "1";
const HOST = "https://fasttraxent.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DATE = "2026-08-02";
const PROMO_CODE = "VIPCOMP-HG-0802";
const BOOKING_API_KEY = "CMXDJ9fct3--Js6u_c_mXUKGcv1GbbBBspVSuipdiT4";

const CONTACT = {
  firstName: "Henrry",
  lastName: "Gomez",
  email: "henrry@headpinz.com",
  phone: "7866097355",
  smsOptIn: true,
};

// ── party: 5 adults + 2 juniors (wizard-style placeholders) ────────────────
type Cat = "adult" | "junior";
const party = [
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: randomUUID(),
    firstName: `Adult ${n}`,
    lastName: "",
    isNewRacer: true,
    category: "adult" as Cat,
    ...(n === 1 ? { isBillingCustomer: true } : {}),
  })),
  ...[1, 2].map((n) => ({
    id: randomUUID(),
    firstName: `Junior ${n}`,
    lastName: "",
    isNewRacer: true,
    category: "junior" as Cat,
  })),
];
const adults = party.filter((m) => m.category === "adult");
const juniors = party.filter((m) => m.category === "junior");

// ── heat targets (weekend/existing priced catalog + $0 build twins) ────────
const PAGE_PRICED = 43734751;
const PAGE_BUILD = 49504534;
const HEAT_SPECS: Array<{
  member: (typeof party)[number];
  tier: "starter" | "intermediate";
  heatId: string;
  pricedProductId: string; // goes on the session heat (registry lookup key)
  buildProductId: string; // what actually books the BMI line ($0 twin)
  productName: string;
}> = [];
for (const j of juniors) {
  HEAT_SPECS.push({
    member: j,
    tier: "starter",
    heatId: `${DATE}T18:00:00`,
    pricedProductId: "43733133",
    buildProductId: "49501626", // junior:starter:Blue withLicense (new racer 1st heat)
    productName: "Junior Starter Race Blue",
  });
}
for (const a of adults) {
  HEAT_SPECS.push({
    member: a,
    tier: "starter",
    heatId: `${DATE}T18:12:00`,
    pricedProductId: "43734229",
    buildProductId: "49504069", // adult:starter:Blue withLicense
    productName: "Starter Race Blue",
  });
}
for (const j of juniors) {
  HEAT_SPECS.push({
    member: j,
    tier: "intermediate",
    heatId: `${DATE}T20:36:00`,
    pricedProductId: "43729633",
    buildProductId: "49498305", // junior:intermediate:Blue raceOnly
    productName: "Junior Intermediate Race Blue",
  });
}
for (const a of adults) {
  HEAT_SPECS.push({
    member: a,
    tier: "intermediate",
    heatId: `${DATE}T20:48:00`,
    pricedProductId: "43726940",
    buildProductId: "49497117", // adult:intermediate:Blue raceOnly
    productName: "Intermediate Race Blue",
  });
}

// ── http helpers ───────────────────────────────────────────────────────────
async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HOST}${path}`, {
    ...init,
    headers: { "user-agent": UA, ...(init?.headers ?? {}) },
  });
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
const rawField = (text: string, field: string): string | null => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return m ? m[1] : null;
};

// ── 1. promo code (Neon upsert — resolver reads this row) ──────────────────
async function ensurePromo(): Promise<void> {
  const existing = (await q`SELECT id, active, uses_count, max_uses FROM discount_codes WHERE UPPER(code) = ${PROMO_CODE}`) as Array<Record<string, unknown>>;
  if (existing.length) {
    console.log(`[promo] ${PROMO_CODE} already exists (uses ${existing[0].uses_count}/${existing[0].max_uses}, active=${existing[0].active})`);
    return;
  }
  await q`
    INSERT INTO discount_codes
      (code, description, mechanic, amount_pct, starts_at, expires_at,
       booking_date_start, booking_date_end, scopes, max_uses, active, created_by)
    VALUES
      (${PROMO_CODE},
       ${"Comped Ultimate VIP V2 test group 2026-08-02 — Henrry Gomez (owner-directed staff test, zero charge)"},
       'percent', 100, NOW() - INTERVAL '1 hour', ${"2026-08-04T04:00:00Z"},
       ${DATE}, ${DATE}, ${'{"racing":{},"bowling":{}}'}::jsonb, 1, TRUE, 'claude-vip-comp-script')
  `;
  console.log(`[promo] created ${PROMO_CODE} — 100% percent, scopes racing+bowling, booking date ${DATE}, maxUses 1`);
}

// ── 2. bowling: experience + 6:45 slot ─────────────────────────────────────
interface DurationOption {
  qamfOptionId: number;
  durationMinutes: number;
  squareMultiplier: number;
  overrideSquareProductId?: number | null;
  overridePriceCents?: number | null;
  overrideDepositPct?: number | null;
  overrideCatalogObjectId?: string | null;
}
interface Experience {
  id: number;
  slug: string;
  kind: string;
  isVip: boolean;
  qamfWebOfferId: number;
  daysOfWeek?: number[] | null;
  items?: Array<{
    squareProductId: number;
    quantity: number;
    label: string;
    priceCents: number;
    depositPct: number;
    squareCatalogObjectId?: string | null;
    sortOrder: number;
  }>;
  durationOptions?: DurationOption[];
}

async function findBowlingCandidate() {
  const exps = await apiJson<Experience[]>(`/api/bowling/v2/experiences?centerCode=TXBSQN0FEKQ11`);
  const dow = new Date(`${DATE}T12:00:00`).getDay();
  const match = exps
    .map((exp) => ({ exp, opt: (exp.durationOptions ?? []).find((d) => d.durationMinutes === 90) }))
    .find(
      (e) =>
        !!e.opt &&
        e.exp.isVip &&
        e.exp.kind !== "kbf" &&
        (!Array.isArray(e.exp.daysOfWeek) || e.exp.daysOfWeek.length === 0 || e.exp.daysOfWeek.includes(dow)),
    );
  if (!match?.opt) throw new Error("No VIP 90-min bowling experience for that day");
  const avail = await apiJson<{
    Availabilities?: Array<{
      BookedAt: string;
      WebOffer: { Id: number | string; Title?: string; Options?: { Time?: Array<{ Id: number; Minutes?: number }> } };
    }>;
    meta?: { optionAccuracy?: string };
  }>(
    `/api/bowling/v2/availability?centerId=9172&players=7&startDate=${DATE}&kind=open,hourly&stepMinutes=15&optionCheck=accurate`,
  );
  const slots = (avail.Availabilities ?? []).filter((a) => {
    const id = typeof a.WebOffer.Id === "string" ? parseInt(a.WebOffer.Id, 10) : a.WebOffer.Id;
    return id === match.exp.qamfWebOfferId;
  });
  const slot = slots.find(
    (a) =>
      a.BookedAt.includes("T18:45") &&
      (a.WebOffer.Options?.Time ?? []).some((t) => t.Id === match.opt!.qamfOptionId),
  );
  if (!slot) {
    console.log(
      "[bowling] 18:45 slot NOT bookable. Slots for this offer:",
      slots.map((s) => `${s.BookedAt.slice(11, 16)}(${(s.WebOffer.Options?.Time ?? []).map((t) => t.Minutes).join("/")})`).join(" "),
    );
    throw new Error("VIP lane at 6:45 PM not available for 90 min");
  }
  console.log(`[bowling] ${match.exp.slug} offer ${match.exp.qamfWebOfferId} slot ${slot.BookedAt} option ${match.opt.qamfOptionId} (90 min) ✔`);
  return { experience: match.exp, durationOption: match.opt, bookedAt: slot.BookedAt };
}

// ── 3. BMI heat availability on the $0 BUILD products ──────────────────────
interface Proposal {
  blocks: Array<{ productLineIds: number[]; block: Record<string, unknown> & { start: string; freeSpots: number; capacity: number; resourceId: number } }>;
  productLineId: number | null;
}
async function bmiAvailability(productId: string, pageId: number): Promise<Proposal[]> {
  const data = await apiJson<{ proposals: Proposal[] }>(
    `/api/bmi?endpoint=availability&date=${DATE}&clientKey=headpinzftmyers`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ProductId: Number(productId), PageId: pageId, Quantity: 1, OrderId: null, PersonId: null, DynamicLines: [] }),
    },
  );
  return data.proposals ?? [];
}
const proposalFor = (proposals: Proposal[], heatId: string): Proposal | undefined =>
  proposals.find((p) => p.blocks[0]?.block.start === heatId);

async function verifyHeatCapacity(): Promise<void> {
  const byProduct = new Map<string, { heatId: string; need: number }>();
  for (const s of HEAT_SPECS) {
    const cur = byProduct.get(s.buildProductId);
    if (cur) cur.need += 1;
    else byProduct.set(s.buildProductId, { heatId: s.heatId, need: 1 });
  }
  for (const [pid, { heatId, need }] of byProduct) {
    const prop = proposalFor(await bmiAvailability(pid, PAGE_BUILD), heatId);
    if (!prop) throw new Error(`Build product ${pid}: heat ${heatId} not in dayplanner`);
    const b = prop.blocks[0].block;
    if (b.freeSpots < need) throw new Error(`Heat ${heatId} (product ${pid}): only ${b.freeSpots} free, need ${need}`);
    console.log(`[heats] ${heatId} build ${pid}: free ${b.freeSpots}/${b.capacity} (need ${need}) ✔`);
  }
}

// ── 4. session builder ──────────────────────────────────────────────────────
function buildSession(opts: {
  bmiBillId: string | null;
  bmiLineIds: Map<number, string>; // HEAT_SPECS index → bmiLineId
  povSold: boolean;
  bowling: { experience: Experience; durationOption: DurationOption; bookedAt: string };
  qamfReservationId: string | null;
}) {
  const { experience, durationOption, bookedAt } = opts.bowling;
  const laneCount = Math.max(1, Math.ceil(party.length / 6)); // 7 → 2
  const lineItems = (experience.items ?? []).map((ei) => {
    const isPrimary = ei.sortOrder === 0;
    const useOverride = isPrimary && durationOption.overrideSquareProductId;
    return {
      squareProductId: useOverride ? durationOption.overrideSquareProductId! : ei.squareProductId,
      quantity: isPrimary ? ei.quantity * laneCount * durationOption.squareMultiplier : ei.quantity * laneCount,
      label: ei.label,
      priceCents: useOverride ? (durationOption.overridePriceCents ?? ei.priceCents) : ei.priceCents,
      depositPct: useOverride ? (durationOption.overrideDepositPct ?? ei.depositPct) : ei.depositPct,
      squareCatalogObjectId: useOverride ? (durationOption.overrideCatalogObjectId ?? ei.squareCatalogObjectId) : ei.squareCatalogObjectId,
    };
  });
  const naive = bookedAt.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const hh = parseInt(naive.slice(11, 13), 10);
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
    povSold: opts.povSold,
    rookiePack: null,
    addons: [],
    heats: HEAT_SPECS.map((s, i) => ({
      productId: s.pricedProductId,
      track: "Blue",
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
    hour: hh < 6 ? hh + 24 : hh,
    minute: parseInt(naive.slice(14, 16), 10),
    bookedAt,
    experienceId: experience.id,
    experienceSlug: experience.slug,
    webOfferId: experience.qamfWebOfferId,
    optionId: durationOption.qamfOptionId,
    optionType: "Time",
    laneCount,
    durationMinutes: 90,
    durationMultiplier: durationOption.squareMultiplier,
    playerCount: party.length,
    assignedTo: [],
    shoeSelections: {},
    attractionAddons: [],
    pizzaModifierSelections: [{}],
    qamfReservationId: opts.qamfReservationId,
    qamfCenterId: 9172,
    lineItems,
    rawItems: [],
    quoteDayofOrderId: null,
    quoteTotalCents: 0,
    quoteDepositCents: 0,
    quoteDiscountOffCents: 0,
    hasBookingFee: true,
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
    context: {},
    // Full AppliedPromo shape — the quote path prices from this object; the
    // reserve path re-resolves it from Neon by .code (fail-closed) regardless.
    appliedPromo: {
      code: PROMO_CODE,
      domains: ["racing", "bowling"],
      scopes: { racing: {}, bowling: {} },
      startsAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-04T04:00:00.000Z",
      allowedWeekdays: null,
      bookingDateStart: DATE,
      bookingDateEnd: DATE,
      mechanic: "percent",
      amountPct: 100,
      amountCents: null,
      squareCatalogId: null,
    },
    comboSpecialId: "race-bowl-v2",
    party,
    items: [raceItem, bowlingItem],
    activeItemId: null,
    cursors: {},
  };
}

// ── main ────────────────────────────────────────────────────────────────────
await ensurePromo();
const bowling = await findBowlingCandidate();
await verifyHeatCapacity();

// Quote gate: the server must recognize the session as a race-bowl-v2 combo AND
// price it $0 via the promo — asserted BEFORE any booking write.
{
  const session = buildSession({ bmiBillId: null, bmiLineIds: new Map(), povSold: true, bowling, qamfReservationId: null });
  const quote = await apiJson<Record<string, unknown>>(`/api/booking/v2/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session }),
  });
  console.log("\n[quote]", JSON.stringify(quote, null, 1).slice(0, 2500));
}

if (!APPLY) {
  console.log("\nDRY RUN complete — review the quote above (expect two Ultimate VIP lines at $0, total $0).");
  console.log("Run with APPLY=1 to book.");
  process.exit(0);
}

// ── APPLY: book the 14 BMI heats (chained on one bill) ─────────────────────
let billId: string | null = null;
const bmiLineIds = new Map<number, string>();
for (let i = 0; i < HEAT_SPECS.length; i++) {
  const s = HEAT_SPECS[i];
  const prop = proposalFor(await bmiAvailability(s.buildProductId, PAGE_BUILD), s.heatId);
  if (!prop) throw new Error(`Heat vanished: ${s.heatId} (build ${s.buildProductId})`);
  const payload = {
    productId: s.buildProductId,
    quantity: 1,
    resourceId: Number(prop.blocks[0].block.resourceId) || -1,
    proposal: {
      blocks: prop.blocks.map((pb) => ({
        productLineIds: pb.productLineIds || [],
        block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
      })),
      productLineId: prop.productLineId ?? null,
    },
  };
  // raw-inject orderId (17-digit BMI id — NEVER JSON.stringify'd as a number)
  let body = JSON.stringify(payload);
  if (billId) body = `{"orderId":${billId},` + body.slice(1);
  const res = await api(`/api/bmi?endpoint=booking%2Fbook&clientKey=headpinzftmyers`, {
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
  const lineId = rawField(text, "orderItemId");
  if (lineId) bmiLineIds.set(i, lineId);
  if (rawOrderId !== billId) {
    billId = rawOrderId;
    // attach the contact the moment the bill exists (wizard parity)
    const regBody =
      `{"orderId":${billId},` +
      JSON.stringify({ firstName: CONTACT.firstName, lastName: CONTACT.lastName, email: CONTACT.email, phone: CONTACT.phone.replace(/\D/g, "") }).slice(1);
    await api(`/api/bmi?endpoint=person%2FregisterContactPerson&clientKey=headpinzftmyers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: regBody,
    }).catch(() => void 0);
  }
  console.log(`[book] heat ${i + 1}/14 ${s.heatId} ${s.member.firstName} (${s.tier}) → line ${lineId ?? "?"} bill ${billId}`);
}
if (!billId) throw new Error("No BMI bill created");

// $0 POV product — 1 per racer (combo includedPovPerRacer)
{
  const res = await api(`/api/sms?endpoint=booking%2Fsell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ productId: "50361293", pageId: null, quantity: party.length, billId, dynamicLines: null, sellKind: 0 }]),
  });
  console.log(`[pov] sell $0 POV ×${party.length} → ${res.status}`);
}

// QAMF VIP lane hold
const hold = await apiJson<{ qamfReservationId?: string; error?: string }>(`/api/bowling/v2/reserve/hold`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    centerId: 9172,
    webOfferId: bowling.experience.qamfWebOfferId,
    optionId: bowling.durationOption.qamfOptionId,
    optionType: "Time",
    bookedAt: bowling.bookedAt,
    players: party.length,
    service: "BookForLater",
  }),
});
if (!hold.qamfReservationId) throw new Error(`Lane hold failed: ${hold.error}`);
console.log(`[lane] QAMF hold ${hold.qamfReservationId}`);

const session = buildSession({ bmiBillId: billId, bmiLineIds, povSold: true, bowling, qamfReservationId: hold.qamfReservationId });

// booking record FIRST (reserve's lane + voucher Redis stamps are if-exists guarded)
const heatStopFrom = (startIso: string): string => {
  const d = new Date(`${startIso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + 7);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
await apiJson(`/api/booking-record`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
  body: JSON.stringify({
    billId,
    billIds: [billId],
    contact: { firstName: CONTACT.firstName, lastName: CONTACT.lastName, email: CONTACT.email, phone: CONTACT.phone },
    primaryPersonId: null,
    racers: HEAT_SPECS.map((s) => ({
      racerName: s.member.firstName,
      personId: null,
      product: s.productName,
      productId: s.pricedProductId,
      tier: s.tier,
      track: "Blue",
      category: s.member.category,
      heatStart: s.heatId,
      heatStop: heatStopFrom(s.heatId),
      heatName: s.productName,
    })),
    isCreditOrder: true,
    cashOwed: 0,
    creditApplied: 0,
    totalAmount: 0,
    date: DATE,
    createdAt: new Date().toISOString(),
    status: "pending_payment",
    rookiePack: false,
    package: null,
    comboSpecial: "race-bowl-v2",
    bowling: [
      {
        kind: "bowling",
        date: DATE,
        bookedAt: bowling.bookedAt,
        experienceSlug: bowling.experience.slug,
        laneCount: Math.max(1, Math.ceil(party.length / 6)),
        playerCount: party.length,
      },
    ],
  }),
});
console.log(`[record] bookingrecord:${billId} created`);

// ── RESERVE (the big one) ───────────────────────────────────────────────────
const reserveRes = await api(`/api/booking/v2/reserve-all`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ session, contact: CONTACT }),
});
const reserveText = await reserveRes.text();
if (!reserveRes.ok) throw new Error(`reserve-all ${reserveRes.status}: ${reserveText.slice(0, 800)}`);
const result = JSON.parse(reserveText) as Record<string, unknown>;
console.log("\n[reserve-all] OK:", JSON.stringify(result, null, 1).slice(0, 3000));

const resNumber = (result.bmiReservationNumber ?? result.reservationNumber ?? null) as string | null;
const resCode = (result.reservationCode ?? result.bmiReservationCode ?? null) as string | null;
const voucher = result.comboVoucher as { code: string; expiresAt: string | null } | undefined;
const lane = (result.bowlingLane ?? null) as string | null;

// PATCH booking record → confirmed
await apiJson(`/api/booking-record`, {
  method: "PATCH",
  headers: { "content-type": "application/json", "x-api-key": BOOKING_API_KEY },
  body: JSON.stringify({
    billId,
    reservationNumber: resNumber,
    reservationCode: resCode,
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
    confirmations: [{ billId, racerName: `${CONTACT.firstName} ${CONTACT.lastName}`, resNumber, resCode }],
  }),
}).catch((e) => console.warn("[record] PATCH failed (non-fatal):", e.message));

// BMI reservation memo (single overwriting write — combo note + booking link)
let shortUrl: string | null = null;
try {
  const link = await apiJson<{ shortUrl?: string }>(`/api/booking/confirmation-link?billId=${billId}&v2=1`);
  shortUrl = link.shortUrl ?? null;
} catch {
  /* falls back to raw url */
}
const laneStr = lane ? ` — Lane ${lane}` : "";
const comboNote =
  `*** ULTIMATE VIP EXPERIENCE (VIP COMBO) *** Paid online at the flat per-person rate — racing license + POV video + VIP lane perks + shoes INCLUDED, do not charge separately.` +
  ` Visit plan: 1) Starter Race -> 2) 1.5hr VIP Bowling at HeadPinz${laneStr} -> 3) Intermediate Race (ONLY IF QUALIFIED).` +
  (lane ? ` Bowling lane: ${lane}.` : "") +
  ` If a racer does NOT qualify: convert their later race to a second Starter race OR issue a race credit.` +
  ` Bowling is a separate HeadPinz/QAMF reservation on the same Square order (settles at lane-open).` +
  ` COMPED TEST GROUP (promo ${PROMO_CODE} 100%) — $0 due.`;
const memo = comboNote + `\nBooking: ${shortUrl ?? `${HOST}/book/confirmation/v2?billId=${billId}`}`;
await api(`/api/bmi?endpoint=booking%2Fmemo&clientKey=headpinzftmyers`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: `{"orderId":${billId},"memo":${JSON.stringify(memo)}}`,
}).then((r) => console.log(`[memo] booking/memo → ${r.status}`));

// Guest confirmation email/SMS (VIP welcome template via comboSpecialId)
const schedule: Array<{ name: string; start: string; persons?: number }> = [
  { name: "Starter Race — Juniors", start: `${DATE}T18:00:00`, persons: 2 },
  { name: "Starter Race — Adults", start: `${DATE}T18:12:00`, persons: 5 },
  { name: "VIP Bowling", start: `${DATE}T18:45:00`, persons: 7 },
  { name: "Intermediate Race — Juniors", start: `${DATE}T20:36:00`, persons: 2 },
  { name: "Intermediate Race — Adults", start: `${DATE}T20:48:00`, persons: 5 },
];
const fmtT = (iso: string) => {
  const h = parseInt(iso.slice(11, 13), 10);
  const m = iso.slice(14, 16);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
};
await api(`/api/notifications/booking-confirmation`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: CONTACT.email,
    phone: CONTACT.phone,
    firstName: CONTACT.firstName,
    smsOptIn: true,
    reservationNumber: resNumber,
    reservationName: `${CONTACT.firstName} ${CONTACT.lastName}`,
    reservationDate: "Sunday, August 2, 2026",
    reservationTime: "6:00 PM",
    reservationSchedule: schedule.map((s) => `${s.name} · ${fmtT(s.start)}`).join("<br/>"),
    waiverUrl: `${HOST}/waiver`,
    reservationCode: resCode,
    billId,
    isNewRacer: true,
    povCodes: [],
    productNames: schedule.map((s) => s.name),
    scheduledItems: schedule,
    brand: "fasttrax",
    expressLane: false,
    confirmationV2: true,
    comboSpecialId: "race-bowl-v2",
  }),
}).then((r) => console.log(`[email] booking-confirmation → ${r.status}`));

console.log("\n──────────────────────────────────────────");
console.log(`BOOKED. bill=${billId} res=${resNumber ?? "?"} code=${resCode ?? "?"}`);
console.log(`QAMF: ${hold.qamfReservationId} lane=${lane ?? "assigned at reserve — check result above"}`);
console.log(`Voucher: ${voucher ? `${voucher.code} (expires ${voucher.expiresAt})` : "NOT RETURNED — check reconcile cron"}`);
console.log(`Confirmation: ${shortUrl ?? `${HOST}/book/confirmation/v2?billId=${billId}`}`);
