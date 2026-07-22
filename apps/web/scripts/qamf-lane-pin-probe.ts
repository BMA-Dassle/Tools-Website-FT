/**
 * PR0 probe (Bowl Now / Play Now): does QAMF honor an explicit lane pin on
 * center 11542 / web offer 5?
 *
 * The per-lane QR flow MUST book the exact lane the guest is standing at, but
 * NO current caller sends NewReservationInput.Lanes — QAMF auto-assigns today.
 * This confirms, against the live center, which pinning method works before we
 * build the scan-time hold on top of it:
 *
 *   Method A (pin-at-create): POST /reservations with Lanes:[{LaneNumber:N}].
 *   Method B (create-then-move): POST auto-assign, then PATCH /lanes (api 1.3)
 *     to move onto lane N (watch for 409 LanesNotCompatible off the offer's
 *     Lane Groups; this PATCH wants CENTER-LOCAL wall-clock ISO).
 *
 * SAFETY: every reservation this creates is a Temporary/BookForLater hold on a
 * currently-FREE ("Closed") lane, titled so staff can spot it, and is DELETEd
 * in a finally block — even on error. It never opens a lane (no lane-status
 * writes) and never touches an occupied lane. Still: run it at a quiet time,
 * and it is a LIVE mutation on the production center — get the owner's OK first.
 *
 * Usage: npx tsx scripts/qamf-lane-pin-probe.ts [centerId] [--move]
 *   centerId defaults to 11542 (FastTrax duckpin). --move also runs Method B.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import Redis from "ioredis";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(k in process.env) || !process.env[k]) process.env[k] = v;
  }
} catch {
  /* rely on env */
}

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VER = "2025-12-01.1.0";
const API_VER_LANES = "1.3"; // moveReservationLanes lives on 1.3

const CENTER = Number(process.argv[2]) || 11542;
const RUN_MOVE = process.argv.includes("--move");
const WEB_OFFER_ID = 5; // FastTrax duckpin offer (30/60/90)

async function tokenFor(centerId: number): Promise<{ token: string; via: string }> {
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
    if (!res.ok) throw new Error(`mint failed: ${res.status} ${txt.slice(0, 200)}`);
    return { token: (JSON.parse(txt) as { access_token: string }).access_token, via: "mint" };
  }
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("no creds and no REDIS_URL");
  const r = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await r.connect();
    const exact = await r.get(`qamf:bowling:access-token:${centerId}`);
    if (exact) return { token: exact, via: `redis:${centerId}` };
    throw new Error("no cached token in Redis for this center");
  } finally {
    r.disconnect();
  }
}

type Resp = { status: number; ok: boolean; text: string };
async function req(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  apiVersion = API_VER,
): Promise<Resp> {
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

/** now, floored to a 5-min multiple, rendered with the true America/New_York offset. */
function nowRounded5ET(): string {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  const offMin = Math.round((asUtc - d.getTime()) / 60000); // ET is behind UTC → negative
  const sign = offMin <= 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const min5 = String(Math.floor(+parts.minute / 5) * 5).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${min5}:00${offStr}`;
}

type Lane = { LaneNumber: number; Status: string };
type BookedLane = { Id: string; LaneNumber: number; StartTime?: string; EndTime?: string };
type Reservation = { Id: string; Lanes?: BookedLane[] };

async function listLanes(token: string): Promise<Lane[]> {
  const r = await req("GET", `/centers/${CENTER}/lanes`, token);
  if (!r.ok) throw new Error(`listLanes ${r.status}: ${r.text.slice(0, 200)}`);
  const parsed = JSON.parse(r.text);
  return (Array.isArray(parsed) ? parsed : (parsed.Lanes ?? [])) as Lane[];
}

async function timeOptionForOffer5(token: string): Promise<number> {
  const r = await req("GET", `/centers/${CENTER}/weboffers/${WEB_OFFER_ID}`, token);
  if (!r.ok) throw new Error(`getWebOffer(${WEB_OFFER_ID}) ${r.status}: ${r.text.slice(0, 200)}`);
  const o = JSON.parse(r.text) as { Options?: { Time?: Array<{ Id: number; Minutes?: number }> } };
  const times = o.Options?.Time ?? [];
  if (times.length === 0) throw new Error(`offer ${WEB_OFFER_ID} has no Time options`);
  // shortest duration = least disruptive probe hold
  const shortest = [...times].sort((a, b) => (a.Minutes ?? 0) - (b.Minutes ?? 0))[0];
  console.log(
    `  offer ${WEB_OFFER_ID} Time options: ${times.map((t) => `${t.Id}(${t.Minutes}m)`).join(", ")}`,
  );
  return Number(shortest.Id);
}

async function createHold(
  token: string,
  optionId: number,
  bookedAt: string,
  pinLane?: number,
): Promise<Reservation> {
  const body = {
    BookedAt: bookedAt,
    Title: `BOWL-NOW PIN PROBE — safe to delete${pinLane ? ` (want lane ${pinLane})` : ""}`,
    WebOffer: {
      Id: WEB_OFFER_ID,
      Options: { Time: [{ Id: optionId }] },
      Services: ["BookForLater"],
    },
    TotalPlayers: 1,
    ...(pinLane ? { Lanes: [{ LaneNumber: pinLane }] } : {}),
  };
  const r = await req("POST", `/centers/${CENTER}/reservations`, token, body);
  if (!r.ok) throw new Error(`createReservation ${r.status}: ${r.text.slice(0, 300)}`);
  return JSON.parse(r.text) as Reservation;
}

async function getRes(token: string, id: string): Promise<Reservation> {
  const r = await req("GET", `/centers/${CENTER}/reservations/${id}`, token);
  if (!r.ok) throw new Error(`getReservation ${r.status}: ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text) as Reservation;
}

async function del(token: string, id: string): Promise<void> {
  const r = await req("DELETE", `/centers/${CENTER}/reservations/${id}`, token);
  if (!r.ok && r.status !== 404) {
    console.log(`  ⚠ cleanup DELETE ${id} -> HTTP ${r.status}: ${r.text.slice(0, 150)}`);
  } else {
    console.log(`  cleanup: deleted ${id}`);
  }
}

async function main() {
  console.log(
    `\n${"=".repeat(64)}\nQAMF lane-pin probe — center ${CENTER}, offer ${WEB_OFFER_ID}\n${"=".repeat(64)}`,
  );
  const { token, via } = await tokenFor(CENTER);
  console.log(`token: ${via}`);

  const lanes = await listLanes(token);
  const free = lanes
    .filter((l) => l.Status === "Closed")
    .map((l) => l.LaneNumber)
    .sort((a, b) => a - b);
  console.log(`lanes: ${lanes.length} total, ${free.length} free (Closed): [${free.join(", ")}]`);
  if (free.length === 0) {
    console.log("no free lane to probe safely — try again when a lane is open. ABORT.");
    return;
  }
  const target = free[0];
  const optionId = await timeOptionForOffer5(token);
  const bookedAt = nowRounded5ET();
  console.log(`probe target: lane ${target}, option ${optionId}, bookedAt ${bookedAt}`);

  /* ── Method A: pin-at-create ──────────────────────────────────────────── */
  console.log(`\n--- Method A: createReservation Lanes:[{LaneNumber:${target}}] ---`);
  let idA: string | null = null;
  try {
    const res = await createHold(token, optionId, bookedAt, target);
    idA = res.Id;
    const got = await getRes(token, res.Id);
    const assigned = (got.Lanes ?? []).map((l) => l.LaneNumber);
    console.log(`  created ${res.Id}; assigned lane(s): [${assigned.join(", ")}]`);
    if (assigned.length === 1 && assigned[0] === target) {
      console.log(`  ✅ METHOD A PINS — createReservation.Lanes honored lane ${target}.`);
    } else {
      console.log(
        `  ❌ METHOD A did NOT pin — QAMF assigned [${assigned.join(", ")}] instead of ${target}.`,
      );
    }
  } catch (e) {
    console.log(`  ❌ METHOD A error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (idA) await del(token, idA);
  }

  /* ── Method B (optional): create-then-move ────────────────────────────── */
  if (RUN_MOVE) {
    console.log(
      `\n--- Method B: create auto-assign, then PATCH /lanes -> lane ${target} (api ${API_VER_LANES}) ---`,
    );
    let idB: string | null = null;
    try {
      const res = await createHold(token, optionId, bookedAt);
      idB = res.Id;
      const got = await getRes(token, res.Id);
      const auto = got.Lanes ?? [];
      console.log(
        `  created ${res.Id}; auto lane(s): [${auto.map((l) => l.LaneNumber).join(", ")}]`,
      );
      const moveTarget = free.find((n) => !auto.some((l) => l.LaneNumber === n)) ?? target;
      const lanePayload = auto.map((l) => ({
        Id: l.Id,
        LaneNumber: moveTarget,
        StartTime: l.StartTime,
        EndTime: l.EndTime,
      }));
      const mv = await req(
        "PATCH",
        `/centers/${CENTER}/reservations/${res.Id}/lanes`,
        token,
        { Lanes: lanePayload },
        API_VER_LANES,
      );
      console.log(
        `  PATCH /lanes -> HTTP ${mv.status}${mv.ok ? "" : `: ${mv.text.slice(0, 200)}`}`,
      );
      if (mv.ok) {
        const after = await getRes(token, res.Id);
        const now = (after.Lanes ?? []).map((l) => l.LaneNumber);
        console.log(
          `  after move: [${now.join(", ")}] (wanted ${moveTarget}) ${now.includes(moveTarget) ? "✅" : "❌"}`,
        );
      }
    } catch (e) {
      console.log(`  ❌ METHOD B error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (idB) await del(token, idB);
    }
  }

  console.log(`\ndone. (all probe holds deleted; no lanes were opened)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
