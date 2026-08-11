/**
 * Probe: the 9 BMI birthday-party products (Bronze/Silver/VIP × Group 1-3) on the
 * private webshop page "Web - BIrthdays" (pageId 58417254, headpinzftmyers).
 * Each "Group" = 10 guests. BMI keeps the lane calendar only — QAMF stays the real
 * lane authority (zero-price reservations there per owner 2026-08-10).
 *
 * Verified 2026-08-10 (VIP resource; Bronze/Silver resource 350954 not yet emitting):
 *   - Products are INVISIBLE to /products and /page?date on both public APIs; they
 *     only surface via the SMS-Timing rail: GET page/availability?pageId=58417254.
 *   - Slots come from POST dayplanner/dayplanner {productId, pageId, quantity:1,
 *     dynamicLines:null, date} → proposals = (start × lane-session) pairs, 90 min,
 *     15-min grid, 24h/day. Response ignores the requested hour (whole-day list).
 *   - booking/book (via /api/bmi raw-safe proxy) books it; chain groups on one bill
 *     by raw-injecting {"orderId":<raw>} — each group lands on its OWN lane resource.
 *   - Booking decrements freeSpots; DELETE bill/{id}/cancel restores them.
 *   - Book response has schedules[]/prices[] EMPTY and orderItemId 0 — the truth is
 *     in bill/overview (line + "Birthday VIP Bowling" schedule + billLine id).
 *   - ⚠ Lines book at $0.00 despite page prices (174.50/214.50/324.50) — flagged.
 *
 * READ-ONLY by default. APPLY=1 runs one VIP-G1 book → verify → cancel round-trip.
 */
const HOST = "https://fasttraxent.com";
const PAGE_ID = "58417254";
const CLIENT = "headpinzftmyers";
const DATE = process.env.PARTY_DATE || "2026-08-15"; // probe date (Saturday)
const APPLY = process.env.APPLY === "1";

const PRODUCTS: Record<string, string> = {
  "30732175": "Bronze Birthday Party - Group 1",
  "30732328": "Bronze Birthday Party - Group 2",
  "30732339": "Bronze Birthday Party - Group 3",
  "30731757": "Silver Birthday Party - Group 1",
  "30732113": "Silver Birthday Party - Group 2",
  "30732144": "Silver Birthday Party - Group 3",
  "30645244": "VIP Birthday Party - Group 1",
  "30725470": "VIP Birthday Party - Group 2",
  "30731593": "VIP Birthday Party - Group 3",
};

interface Block {
  name: string;
  start: string;
  stop: string;
  capacity: number;
  freeSpots: number;
  resourceId: string | number;
  prices?: Array<{ amount: number }>;
}
interface Proposal {
  blocks: Array<{ productLineIds: Array<string | number>; block: Block }>;
  productLineId: string | number | null;
}

const rawField = (text: string, field: string): string | null => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return m ? m[1] : null;
};

async function dayplanner(productId: string, quantity = 1): Promise<Proposal[]> {
  const res = await fetch(`${HOST}/api/sms?endpoint=dayplanner%2Fdayplanner&clientKey=${CLIENT}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId,
      pageId: PAGE_ID,
      quantity,
      dynamicLines: null,
      date: `${DATE}T15:00:00.000Z`,
    }),
  });
  const data = (await res.json()) as Proposal[] | { proposals?: Proposal[] };
  return Array.isArray(data) ? data : (data.proposals ?? []);
}

// ── sweep all 9 ──────────────────────────────────────────────────────────────
for (const [pid, label] of Object.entries(PRODUCTS)) {
  const props = await dayplanner(pid);
  if (!props.length) {
    console.log(`${label.padEnd(36)} → 0 proposals (resource not web-enabled?)`);
    continue;
  }
  const b0 = props[0].blocks[0].block;
  console.log(
    `${label.padEnd(36)} → ${props.length} proposals | ${b0.start}–${b0.stop.slice(11, 16)} ` +
      `free ${b0.freeSpots}/${b0.capacity} res ${b0.resourceId} $${b0.prices?.[0]?.amount ?? "?"}`,
  );
}

if (!APPLY) {
  console.log("\nRead-only sweep done. APPLY=1 runs a VIP-G1 book→verify→cancel round-trip.");
  process.exit(0);
}

// ── APPLY: one fake booking round-trip on VIP G1, always cancelled ───────────
const pid = "30645244";
const props = await dayplanner(pid);
const pick = props.find((p) => (p.blocks[0]?.block.start ?? "").includes("T14:00"));
if (!pick) throw new Error("no 14:00 proposal on VIP G1");
const b = pick.blocks[0].block;
console.log(`\n[book] ${b.name} ${b.start} free=${b.freeSpots}`);

const payload = {
  productId: pid,
  quantity: 1,
  resourceId: Number(b.resourceId) || -1,
  proposal: {
    blocks: pick.blocks.map((pb) => ({
      productLineIds: pb.productLineIds || [],
      block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
    })),
    productLineId: pick.productLineId ?? null,
  },
};
const bookRes = await fetch(`${HOST}/api/bmi?endpoint=booking%2Fbook&clientKey=${CLIENT}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
const bookText = await bookRes.text();
const orderId = rawField(bookText, "orderId"); // raw digits — NEVER Number()
if (!bookRes.ok || !orderId) throw new Error(`book failed: ${bookRes.status} ${bookText.slice(0, 200)}`);
console.log(`[book] OK order ${orderId}`);

try {
  const after = await dayplanner(pid);
  const same = after.find(
    (p) => p.blocks[0]?.block.name === b.name && p.blocks[0]?.block.start === b.start,
  );
  console.log(`[verify] freeSpots ${b.freeSpots} → ${same?.blocks[0].block.freeSpots ?? "GONE"}`);
  const ov = await fetch(
    `${HOST}/api/sms?endpoint=bill%2Foverview&billId=${orderId}&clientKey=${CLIENT}`,
  );
  const bill = (await ov.json()) as {
    lines?: Array<{ name: string; totalPrice?: Array<{ amount: number }>; schedules?: Array<{ name: string; start: string; stop: string; resourceId: string }> }>;
  };
  for (const l of bill.lines ?? []) {
    console.log(
      `[bill] ${l.name} $${l.totalPrice?.[0]?.amount} — ${(l.schedules ?? [])
        .map((s) => `${s.name} ${s.start.slice(11, 16)}–${s.stop.slice(11, 16)} res ${s.resourceId}`)
        .join("; ")}`,
    );
  }
} finally {
  const del = await fetch(`${HOST}/api/bmi?endpoint=bill%2F${orderId}%2Fcancel&clientKey=${CLIENT}`, {
    method: "DELETE",
  });
  console.log(`[cancel] → ${del.status} ${(await del.text()).slice(0, 80)}`);
}
