/**
 * NFL VIP Bowling — Step 1 Conqueror probe.
 *
 * Answers the three questions the build plan is blocked on, before any feature
 * code exists:
 *
 *   PHASE 1 (default, READ-ONLY — pure GETs, zero mutations):
 *     1. Every web offer at the center + its Time/Game/Unlimited option ids and
 *        durations. Confirms what durations Conqueror actually has today, and
 *        gives ops the exact shape to clone for the 180-min NFL option.
 *     2. The lane roster, so the VIP block boundaries (FM 5-8 / 9-12) can be
 *        checked against real lane numbers rather than the BMI resource table.
 *
 *   PHASE 2 (--holds, EXPLICIT OPT-IN — creates and deletes real holds):
 *     3. Does createReservation accept an OFF-GRID BookedAt (e.g. 15:50)?
 *        NFL kicks off at :05/:15/:20/:25, so "15 minutes before kickoff" lands
 *        off the :00/:15/:30/:45 grid. If Conqueror rounds or rejects, the start
 *        rule becomes "nearest 15-min slot at or before kickoff-15".
 *
 * SAFETY: Phase 1 mutates nothing. Phase 2 creates Temporary/BookForLater holds
 * far in the future, titles them so staff can spot them, and DELETEs every one
 * in a finally block even on error. It never opens a lane and never writes lane
 * status. Still a live production center — run it at a quiet time.
 *
 * Zero dependencies on purpose: plain .mjs, global fetch, node: builtins only.
 * It reads QAMF_BOWLING_CLIENT_ID/SECRET straight from .env.local and mints its
 * own token, so it runs without npm install in a fresh worktree.
 *
 * Usage (from anywhere):
 *   node apps/web/scripts/nfl-qamf-probe.mjs [--center 9172] [--env <path>] [--holds]
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// Resolves from the repo-root node_modules by ordinary upward lookup (this
// worktree is nested inside the main checkout) — no install, no junction.
import Redis from "ioredis";

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VERSION = "2025-12-01.1.0";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argVal(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const CENTER = Number(argVal("--center", "9172"));
const RUN_HOLDS = argv.includes("--holds");

// ── env ─────────────────────────────────────────────────────────────────────
// .env.local is gitignored, so a fresh worktree has none — fall back to the
// primary checkout's copy. Read-only; nothing is written back.
const ENV_CANDIDATES = [
  argVal("--env", null),
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "apps/web/.env.local"),
  resolve(process.cwd(), "../../apps/web/.env.local"),
  "C:/GIT/Tools-Website-FT/apps/web/.env.local",
].filter(Boolean);

function loadEnv() {
  for (const p of ENV_CANDIDATES) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
    return p;
  }
  return null;
}

// ── http ────────────────────────────────────────────────────────────────────
/**
 * Token, by whichever route is available.
 *
 * The QAMF client id/secret live ONLY in Vercel — .env.local carries the key
 * names with empty values — so locally we ride the Redis-cached access token
 * the app already minted. Mint first anyway, in case creds are present.
 */
async function tokenFor(centerId) {
  const id = process.env.QAMF_BOWLING_CLIENT_ID;
  const secret = process.env.QAMF_BOWLING_CLIENT_SECRET;

  if (id && secret) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      scope: "bowling_reservations",
      center_id: String(centerId),
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`token mint failed: ${res.status} ${txt.slice(0, 300)}`);
    return { token: JSON.parse(txt).access_token, via: "mint" };
  }

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "No QAMF creds (Vercel-only) and no REDIS_URL — cannot obtain a token. Pass --env <path to .env.local>.",
    );
  }
  const r = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await r.connect();
    const key = `qamf:bowling:access-token:${centerId}`;
    const cached = await r.get(key);
    if (cached) return { token: cached, via: `redis (${key})` };
    const seen = await r.keys("qamf:bowling:access-token:*");
    throw new Error(
      `no cached token at ${key}. Cached centers: ${seen.length ? seen.join(", ") : "(none)"}. ` +
        `Hit the live site's bowling availability for center ${centerId} to warm it, then re-run.`,
    );
  } finally {
    r.disconnect();
  }
}

async function req(method, path, token, body, apiVersion = API_VERSION) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "api-version": apiVersion,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

// ── ET helpers (the correct way — Intl, not a month heuristic) ──────────────
/** True America/New_York UTC offset for an instant, e.g. "-04:00". */
function etOffsetFor(date) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  return (name ?? "GMT-05:00").replace("GMT", "");
}

/** Build an ET wall-clock ISO with the correct DST offset for that date. */
function etIso(y, m, d, hh, mm) {
  const probe = new Date(Date.UTC(y, m - 1, d, 17, 0, 0)); // noon-ish ET, DST-safe anchor
  const off = etOffsetFor(probe);
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:00${off}`;
}

// ── formatting ──────────────────────────────────────────────────────────────
const opts = (o) => {
  const t = (o.Options?.Time ?? []).map((x) => `${x.Id}(${x.Minutes ?? "?"}m)`);
  const g = (o.Options?.Game ?? []).map((x) => `${x.Id}(${x.GamesPerPlayer ?? "?"}g)`);
  const u = (o.Options?.Unlimited ?? []).map((x) => `${x.Id}(unl)`);
  const parts = [];
  if (t.length) parts.push(`Time: ${t.join(" ")}`);
  if (g.length) parts.push(`Game: ${g.join(" ")}`);
  if (u.length) parts.push(`Unlim: ${u.join(" ")}`);
  return parts.join(" | ") || "(no options)";
};

// ── phase 1: read-only inventory ────────────────────────────────────────────
async function phase1(token) {
  console.log(`\n${"=".repeat(78)}\nPHASE 1 — READ-ONLY INVENTORY (center ${CENTER})\n${"=".repeat(78)}`);

  const r = await req("GET", `/centers/${CENTER}/weboffers`, token);
  if (!r.ok) throw new Error(`listWebOffers ${r.status}: ${r.text.slice(0, 400)}`);
  const parsed = JSON.parse(r.text);
  const offers = Array.isArray(parsed) ? parsed : (parsed.WebOffers ?? []);

  console.log(`\n${offers.length} web offers configured.\n`);
  console.log(`${"id".padEnd(6)}${"on".padEnd(5)}${"title".padEnd(42)}options`);
  console.log("-".repeat(78));

  let maxTime = 0;
  const timeOffers = [];
  for (const o of offers.sort((a, b) => Number(a.Id) - Number(b.Id))) {
    const enabled = String(o.IsEnabled) === "true" || o.IsEnabled === true;
    const times = o.Options?.Time ?? [];
    for (const t of times) {
      const mins = Number(t.Minutes ?? 0);
      if (mins > maxTime) maxTime = mins;
      timeOffers.push({ offerId: Number(o.Id), title: o.Title, optionId: Number(t.Id), mins });
    }
    console.log(
      `${String(o.Id).padEnd(6)}${(enabled ? "Y" : "-").padEnd(5)}${String(o.Title ?? "").slice(0, 40).padEnd(42)}${opts(o)}`,
    );
  }

  console.log(`\n--- DURATIONS ACTUALLY CONFIGURED ---`);
  const byMins = new Map();
  for (const t of timeOffers) {
    if (!byMins.has(t.mins)) byMins.set(t.mins, []);
    byMins.get(t.mins).push(`${t.offerId}/${t.optionId}`);
  }
  for (const mins of [...byMins.keys()].sort((a, b) => a - b)) {
    console.log(`  ${String(mins).padStart(4)} min  →  ${byMins.get(mins).length} option(s)`);
  }
  console.log(`\n  LONGEST Time option anywhere at this center: ${maxTime} min`);
  console.log(
    maxTime >= 180
      ? `  >> A 180-min option ALREADY EXISTS. Reuse it — no Conqueror work needed.`
      : `  >> NO option >= 180 min. Ops must create one per NFL block offer (and one for soccer).`,
  );

  // Lanes
  const lr = await req("GET", `/centers/${CENTER}/lanes`, token);
  if (lr.ok) {
    const lp = JSON.parse(lr.text);
    const lanes = Array.isArray(lp) ? lp : (lp.Lanes ?? []);
    const nums = lanes.map((l) => Number(l.LaneNumber)).sort((a, b) => a - b);
    console.log(`\n--- LANES (${lanes.length}) ---`);
    console.log(`  numbers: ${nums.join(", ")}`);
    console.log(`  plan assumes FM VIP = 5-12 → block vip-a {5,6,7,8}, vip-b {9,10,11,12}`);
  } else {
    console.log(`\n--- LANES --- listLanes ${lr.status} (non-fatal): ${lr.text.slice(0, 160)}`);
  }

  return { offers, timeOffers, maxTime };
}

// ── phase 2: off-grid BookedAt (MUTATES — creates + deletes holds) ──────────
async function phase2(token, timeOffers) {
  console.log(`\n${"=".repeat(78)}\nPHASE 2 — OFF-GRID BookedAt (creates + deletes real holds)\n${"=".repeat(78)}`);

  // Target the offers we'd ACTUALLY use. 174/175 are the idle World Cup VIP
  // offers and they already carry a 180-min Time option (1390 / 1398), which is
  // exactly the NFL window — so probe the real config, not a stand-in.
  //
  // Date = the first SUNDAY at least 21 days out. Sunday matters twice over: it
  // is the day the two-game rule is under most pressure, and it lets us test
  // whether 175 ("Mon-Thur") actually REFUSES a Sunday. If it does, 174+175
  // cannot serve as two simultaneous blocks on the biggest football day.
  const start = new Date(Date.now() + 21 * 86400000);
  while (start.getUTCDay() !== 0) start.setUTCDate(start.getUTCDate() + 1);
  const y = start.getUTCFullYear();
  const mo = start.getUTCMonth() + 1;
  const day = start.getUTCDate();
  console.log(`  target date: ${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")} (Sunday)\n`);

  const cases = [
    { offer: 174, option: 1390, hh: 12, mm: 45, label: "174 @ 12:45  ON-grid control" },
    { offer: 174, option: 1390, hh: 15, mm: 50, label: "174 @ 15:50  OFF-grid (4:05 KO -15)" },
    { offer: 174, option: 1390, hh: 16, mm: 10, label: "174 @ 16:10  OFF-grid (4:25 KO -15)" },
    { offer: 174, option: 1390, hh: 20, mm: 5, label: "174 @ 20:05  OFF-grid (8:20 KO -15)" },
    { offer: 175, option: 1398, hh: 12, mm: 45, label: "175 @ 12:45  Mon-Thur offer ON A SUNDAY" },
  ];

  const created = [];
  try {
    for (const c of cases) {
      const iso = etIso(y, mo, day, c.hh, c.mm);
      const body = {
        BookedAt: iso,
        Title: "NFL PROBE - safe to delete",
        WebOffer: {
          Id: c.offer,
          Options: { Time: [{ Id: c.option }] },
          Services: ["BookForLater"],
        },
        TotalPlayers: 1,
      };
      const r = await req("POST", `/centers/${CENTER}/reservations`, token, body);
      if (!r.ok) {
        console.log(`  ${c.label.padEnd(40)} REJECTED ${r.status}: ${r.text.slice(0, 200)}`);
        continue;
      }
      const res = JSON.parse(r.text);
      created.push(res.Id);
      const lanes = (res.Lanes ?? []).map((l) => l.LaneNumber);
      const st = res.Lanes?.[0]?.StartTime ?? res.BookedAt ?? "";
      const en = res.Lanes?.[0]?.EndTime ?? "";
      const want = `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}`;
      const got = String(st).slice(11, 16);
      console.log(
        `  ${c.label.padEnd(40)} OK  want=${want} got=${got || "?"} ${got === want ? "[EXACT]" : "[!! SHIFTED]"}  end=${String(en).slice(11, 16) || "?"}  lane(s)=${lanes.join(",") || "?"}`,
      );
    }
  } finally {
    console.log("");
    for (const id of created) {
      const dr = await req("DELETE", `/centers/${CENTER}/reservations/${id}`, token);
      console.log(
        `  cleanup: DELETE ${id} → ${dr.status}${dr.ok ? " ok" : "  *** FAILED — DELETE THIS BY HAND ***"}`,
      );
    }
  }
}

// ── phase 3: lane pinning via PATCH /lanes (MUTATES) ────────────────────────
/**
 * Decides whether app-side block enforcement is possible WITHOUT new Conqueror
 * offers (Path B): create a hold on the VIP offer, then move it onto a chosen
 * lane inside the block. Also proves the lane-group boundary is real by trying
 * to move onto a REGULAR lane, which must 409 LanesNotCompatible.
 *
 * PATCH /lanes takes center-local wall-clock and ignores the UTC offset, so we
 * send ET wall-clock with the true ET offset (correct under either reading).
 */
async function phase3(token) {
  console.log(`\n${"=".repeat(78)}\nPHASE 3 — LANE PINNING via PATCH /lanes (creates + deletes)\n${"=".repeat(78)}`);

  const start = new Date(Date.now() + 21 * 86400000);
  while (start.getUTCDay() !== 0) start.setUTCDate(start.getUTCDate() + 1);
  const y = start.getUTCFullYear();
  const mo = start.getUTCMonth() + 1;
  const day = start.getUTCDate();
  const iso = etIso(y, mo, day, 12, 45);

  let id = null;
  try {
    const cr = await req("POST", `/centers/${CENTER}/reservations`, token, {
      BookedAt: iso,
      Title: "NFL PROBE lane-move - safe to delete",
      WebOffer: { Id: 174, Options: { Time: [{ Id: 1390 }] }, Services: ["BookForLater"] },
      TotalPlayers: 1,
    });
    if (!cr.ok) {
      console.log(`  create REJECTED ${cr.status}: ${cr.text.slice(0, 200)}`);
      return;
    }
    const res = JSON.parse(cr.text);
    id = res.Id;
    const lane0 = res.Lanes?.[0];
    console.log(`  created ${id} → auto-assigned lane ${lane0?.LaneNumber}  (${String(lane0?.StartTime).slice(11, 16)}–${String(lane0?.EndTime).slice(11, 16)})`);

    const mkLanes = (targetLane) => [
      {
        Id: lane0.Id,
        LaneNumber: targetLane,
        StartTime: etIso(y, mo, day, 12, 45),
        EndTime: etIso(y, mo, day, 15, 45),
      },
    ];

    // (a) move INSIDE the VIP range — pick a different VIP lane.
    const insideTarget = Number(lane0.LaneNumber) === 11 ? 12 : 11;
    const mv = await req("PATCH", `/centers/${CENTER}/reservations/${id}/lanes`, token, { Lanes: mkLanes(insideTarget) }, "1.3");
    console.log(`  move → VIP lane ${insideTarget}: HTTP ${mv.status}${mv.ok ? " OK" : ` ${mv.text.slice(0, 200)}`}`);

    if (mv.ok) {
      const gr = await req("GET", `/centers/${CENTER}/reservations/${id}`, token);
      if (gr.ok) {
        const after = JSON.parse(gr.text);
        console.log(`  verify GET → lane(s) now ${(after.Lanes ?? []).map((l) => l.LaneNumber).join(",")}`);
      }
    }

    // (b) move OUTSIDE the VIP range — must be refused if lane groups bind.
    const out = await req("PATCH", `/centers/${CENTER}/reservations/${id}/lanes`, token, { Lanes: mkLanes(20) }, "1.3");
    console.log(
      `  move → REGULAR lane 20: HTTP ${out.status}${out.ok ? "  !! ACCEPTED — lane group does NOT bind" : `  refused: ${out.text.slice(0, 160)}`}`,
    );
  } finally {
    if (id) {
      const dr = await req("DELETE", `/centers/${CENTER}/reservations/${id}`, token);
      console.log(`\n  cleanup: DELETE ${id} → ${dr.status}${dr.ok ? " ok" : "  *** FAILED — DELETE BY HAND ***"}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const envPath = loadEnv();
  console.log(`env: ${envPath ?? "(none found — relying on process env)"}`);
  console.log(`center: ${CENTER}   mode: ${RUN_HOLDS ? "PHASE 1 + 2 (mutating)" : "PHASE 1 only (read-only)"}`);

  const { token, via } = await tokenFor(CENTER);
  console.log(`token: ok via ${via}`);

  // --raw 161,162 → full JSON for named offers. Answers two things the list
  // view can't: whether an offer missing from /weboffers exists-but-disabled or
  // is truly gone, and whether Conqueror exposes LANE GROUP binding over the
  // API (which decides whether block enforcement can be verified from code).
  const rawIds = argVal("--raw", null);
  if (rawIds) {
    for (const idStr of rawIds.split(",").map((s) => s.trim()).filter(Boolean)) {
      const rr = await req("GET", `/centers/${CENTER}/weboffers/${idStr}`, token);
      console.log(`\n--- offer ${idStr} → HTTP ${rr.status} ---`);
      console.log(rr.ok ? JSON.stringify(JSON.parse(rr.text), null, 2) : rr.text.slice(0, 500));
    }
    return;
  }

  const { timeOffers } = await phase1(token);
  if (RUN_HOLDS) await phase2(token, timeOffers);
  else console.log(`\n(Phase 2 skipped. Re-run with --holds to test off-grid BookedAt.)`);
  if (argv.includes("--move")) await phase3(token);
})().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(1);
});
