/**
 * Race-day RE-VERIFICATION of express-lane reservations — the check nothing
 * currently performs.
 *
 * Express is decided ONCE at checkout (`booking/service/checkout.ts` → the
 * `fastLane` flag) and then asserted as fact on race day: the BMI memo says
 * "all waivers valid; skip Guest Services", the race-day email says EXPRESS
 * LANE, and the kiosk browse badge trusts the flag. Nothing re-reads the waiver
 * in between — and an express guest never opens the kiosk, so the live
 * `isExpressRoster` check never runs for exactly the party that needs it.
 * W53940 (Adam Houghtaling, 7/28) reached the front desk badged express with
 * NO waiver on file.
 *
 * This sweeps a day's booking records, live-reads every racer's Pandora waiver,
 * and reports (or, with --apply, repairs) any reservation still flagged express
 * whose party no longer qualifies:
 *   - `fastLane` → false on the Redis record (kiosk badge + both crons follow it)
 *   - BMI booking memo rewritten without the express claim
 *   - BMI project state OFF "Confirmation - Kiosk" → plain Confirmation (-3)
 *
 * That last one was missing on the first pass (W54793, 7/28): the memo said
 * "** NO VALID WAIVER **" while the reservation still sat in the kiosk
 * confirmation state, which is exactly the state that tells staff the waivers
 * ARE signed. Express is granted as (memo + state); it has to be revoked as
 * (memo + state). See `~/features/booking/service/express-revoke.ts`.
 *
 * Re-runnable by design (a cron will want that): revoked rows stay in scope via
 * the `expressRevokedAt` marker, the memo rewrite strips its own prior headline
 * instead of stacking a second one, and the state revert no-ops unless the row
 * is still in the kiosk state.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/express-raceday-reverify.mts [YYYY-MM-DD] [--apply]
 *   npx tsx scripts/express-raceday-reverify.mts --bill=63000000005919831 [--apply]
 * Default date = today. Without --apply nothing is written. `--bill` forces a
 * single record into scope regardless of date/flag (for rows demoted before the
 * marker existed).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.argv.includes("--apply");
const DATE = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10);
const ONLY_BILL = process.argv.find((a) => a.startsWith("--bill="))?.slice("--bill=".length) ?? null;
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "TXBSQN0FEKQ11";
const BMI_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const CLIENT_KEY = "headpinzftmyers";

const { default: redis } = await import("@/lib/redis");
const { revertExpressKioskState } = await import("~/features/booking/service/express-revoke");
const { fetchProject, officeProjectIdFromBillId, KIOSK_CONFIRMATION_STATE_IDS } = await import(
  "@/lib/bmi-office-actions"
);

interface Rec {
  fastLane?: boolean;
  /** Set by a previous run of this sweep — keeps the row in scope so a half-done
   *  demotion (memo written, state left in the kiosk id) still gets finished. */
  expressRevokedAt?: string;
  date?: string | null;
  reservationNumber?: string;
  contact?: { firstName?: string; lastName?: string };
  racers?: Array<{ racerName?: string; personId?: string | null }>;
  bowling?: unknown[];
  attractions?: unknown[];
  totalAmount?: number;
}

// ── Scan today's records ───────────────────────────────────────────────
const keys: string[] = [];
let cursor = "0";
do {
  const [next, batch] = (await redis.scan(cursor, "MATCH", "bookingrecord:*", "COUNT", 500)) as [
    string,
    string[],
  ];
  cursor = next;
  for (const k of batch) if (/^bookingrecord:\d+$/.test(k)) keys.push(k);
} while (cursor !== "0");

console.log(`\nExpress race-day re-verify — ${DATE}${APPLY ? "  (APPLY)" : "  (dry run)"}`);
console.log(`${keys.length} booking records scanned\n${"─".repeat(78)}`);

const waiverCache = new Map<string, boolean>();
async function waiverValid(personId: string): Promise<boolean> {
  const hit = waiverCache.get(personId);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const res = await fetch(`${PANDORA_URL}/bmi/person/${LOC}/${personId}?picture=false&allRelated=false`, {
      headers: { Authorization: `Bearer ${PKEY}` },
    });
    const d = (await res.json()) as { success?: boolean; data?: { waiverExpiry?: string | null } };
    const exp = res.ok && d?.success ? (d.data?.waiverExpiry ?? null) : null;
    ok = !!exp && new Date(exp) > new Date();
  } catch {
    ok = false; // an outage degrades to "not express" — the safe direction
  }
  waiverCache.set(personId, ok);
  return ok;
}

let token: string | null = null;
async function bmiToken(): Promise<string> {
  if (token) return token;
  const res = await fetch(`${BMI_URL}/auth/${CLIENT_KEY}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
    body: JSON.stringify({
      Username: process.env.BMI_USERNAME,
      Password: process.env.BMI_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`BMI auth ${res.status}`);
  const j = (await res.json()) as { AccessToken?: string; accessToken?: string };
  token = (j.AccessToken || j.accessToken) as string;
  return token;
}

/** Lines a previous pass of this sweep (or the express grant) wrote — dropped
 *  before the fresh verdict is prepended so re-runs don't stack headlines. */
const PRIOR_VERDICT_LINE =
  /^\s*(\*\*\s*(EXPRESS LANE|NO VALID WAIVER|NOT EXPRESS LANE)\s*\*\*|Normal check-in)/i;

/** Current BMI project state, for the report and for the "is it still ours" test. */
async function officeStateNow(billId: string): Promise<{ state: string | null; isKiosk: boolean }> {
  try {
    const project = await fetchProject("fasttrax", officeProjectIdFromBillId(billId));
    const state = project?.stateId != null ? String(project.stateId) : null;
    return { state, isKiosk: state === KIOSK_CONFIRMATION_STATE_IDS.fasttrax };
  } catch (err) {
    console.warn(`           (state read failed: ${err instanceof Error ? err.message : err})`);
    return { state: null, isKiosk: false };
  }
}

let express = 0;
let repaired = 0;
for (const key of keys) {
  const raw = await redis.get(key).catch(() => null);
  if (!raw) continue;
  let rec: Rec;
  try {
    rec = JSON.parse(raw) as Rec;
  } catch {
    continue;
  }
  const billId = key.slice("bookingrecord:".length);
  const forced = ONLY_BILL !== null && billId === ONLY_BILL;
  if (!forced) {
    if (ONLY_BILL !== null) continue;
    // Already-revoked rows stay in scope: the memo half may have landed while
    // the state half didn't (every row demoted before 2026-07-28).
    if (rec.fastLane !== true && !rec.expressRevokedAt) continue;
    if ((rec.date ?? "") !== DATE) continue;
  }
  express++;
  const racers = rec.racers ?? [];
  const who = `${rec.reservationNumber ?? billId} ${rec.contact?.firstName ?? ""} ${rec.contact?.lastName ?? ""}`.trim();
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const r of racers) {
    if (!r.personId) {
      bad.push(`${r.racerName ?? "?"} (no personId)`);
      continue;
    }
    if (seen.has(r.personId)) continue;
    seen.add(r.personId);
    if (!(await waiverValid(r.personId))) bad.push(`${r.racerName ?? r.personId} (no valid waiver)`);
  }
  const comboLeg = (rec.bowling?.length ?? 0) > 0 || (rec.attractions?.length ?? 0) > 0;
  if (comboLeg) bad.push("combo leg — still needs the kiosk");
  const st = await officeStateNow(billId);
  if (bad.length === 0) {
    console.log(
      `  ok       ${who} — ${seen.size} racer(s) valid · state ${st.state ?? "?"}` +
        (rec.expressRevokedAt && st.isKiosk
          ? `  ⚠ revoked ${rec.expressRevokedAt} but STILL in the kiosk state — waivers are valid now, so confirm with the desk before moving it`
          : ""),
    );
    continue;
  }
  console.log(`  ✗ STALE  ${who} — ${bad.join("; ")}`);
  console.log(
    `           state ${st.state ?? "?"} ${
      st.isKiosk
        ? "= Confirmation - Kiosk → will revert to -3 (that state means WAIVERS SIGNED)"
        : "— not the kiosk state, leaving it alone"
    }`,
  );
  if (!APPLY) continue;

  // Mark the revocation on the record so a re-run (or a cron) keeps the row in
  // scope until every half of the demotion has landed.
  const revokedAt = new Date().toISOString();
  let next = raw.replace(
    /"fastLane":\s*true/,
    `"fastLane":false,"expressRevokedAt":${JSON.stringify(revokedAt)}`,
  );
  if (next === raw && !rec.expressRevokedAt) {
    // fastLane was already cleared by an earlier pass — add the marker alone.
    // Raw text splice: the record carries 17-digit ids, so it never gets parsed.
    next = raw.replace(/^\s*\{/, `{"expressRevokedAt":${JSON.stringify(revokedAt)},`);
  }
  if (next !== raw) {
    const ttl = await redis.ttl(key);
    if (ttl > 0) await redis.set(key, next, "EX", ttl);
    else await redis.set(key, next);
  }

  // booking/memo OVERWRITES the single memo field, so preserve what's already
  // there (booking link, 3-race pack note, POV codes…) and strip ONLY the
  // express claim. The overview carries 17-digit ids — never JSON.parse it;
  // pull the memo string out of the raw text and unescape just that literal.
  const t = await bmiToken();
  let kept = "";
  try {
    const ovRes = await fetch(`${BMI_URL}/public-booking/${CLIENT_KEY}/order/${billId}/overview`, {
      headers: {
        Authorization: `Bearer ${t}`,
        "BMI-Subscription-Key": SUB,
        "Accept-Language": "en",
      },
    });
    const hit = (await ovRes.text()).match(/"memo"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (hit) {
      kept = (JSON.parse(`"${hit[1]}"`) as string)
        .split("\n")
        .filter((l) => !PRIOR_VERDICT_LINE.test(l))
        .join("\n")
        .trim();
    }
  } catch {
    /* no existing memo readable — the warning below still gets written */
  }

  // Headline the ACTUAL reason — a combo leg is not a waiver problem, and a
  // memo that says otherwise sends the desk chasing a signature that exists.
  const waiverProblem = bad.some((b) => /waiver|personId/i.test(b));
  const memo = [
    waiverProblem
      ? `** NO VALID WAIVER ** ${rec.reservationNumber ?? billId} — ${bad.join("; ")}.`
      : `** NOT EXPRESS LANE ** ${rec.reservationNumber ?? billId} — ${bad.join("; ")}.`,
    waiverProblem
      ? `Normal check-in: send to Guest Services / kiosk to sign before racing.`
      : `Normal check-in at the kiosk (lane open + per-attraction waivers). Racing waivers ARE valid.`,
    kept,
    !kept && typeof rec.totalAmount === "number" && rec.totalAmount > 0
      ? `Paid online: $${rec.totalAmount.toFixed(2)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const memoRes = await fetch(`${BMI_URL}/public-booking/${CLIENT_KEY}/booking/memo`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "BMI-Subscription-Key": SUB,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: `{"orderId":${billId},"memo":${JSON.stringify(memo)}}`,
  });

  // The state half. Without this the memo above is contradicted by the row's own
  // state — "Confirmation - Kiosk" is what staff read as "waivers are signed".
  const stateRes = await revertExpressKioskState({
    billId,
    centerCode: "fasttrax",
    label: `Express revoked — ${waiverProblem ? "no valid waiver" : "needs kiosk check-in"}`,
  });
  const stateNote =
    stateRes.outcome === "reverted"
      ? `state ${stateRes.from} → -3`
      : stateRes.outcome === "left-alone"
        ? `state ${stateRes.state ?? "?"} left alone`
        : `STATE REVERT FAILED (${stateRes.error})`;
  console.log(`           → fastLane:false · memo ${memoRes.status} · ${stateNote}`);
  repaired++;
}

console.log(
  `${"─".repeat(78)}\n${express} express reservation(s) ${ONLY_BILL ? `matching --bill=${ONLY_BILL}` : `on ${DATE}`}` +
    (APPLY ? ` · ${repaired} repaired\n` : `\n`),
);
process.exit(0);
