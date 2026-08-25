/**
 * Settle waiver rows the vendor can be ASKED about, and leave the rest alone.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `APPLY=1`.
 *
 * THE PROBLEM. `waiver_signatures` rows are shown on the sync board with a
 * DERIVED status: `failed` reads as parked, and so does anything still unsettled
 * ten minutes after it was captured. That second rule is the honest default —
 * a push we never heard back about might genuinely have been lost. But it is a
 * guess, and on 2026-08-25 it was wrong thirteen times: every one of those rows
 * turned out to have a valid waiver sitting in BMI. The push HAD landed; only the
 * settle write was missing. The board was reporting a bookkeeping hole as a
 * guest with no waiver.
 *
 * The other half of the same board was real: guests whose record 404s at the
 * center they signed at, and guests whose record answers 500 because it has no
 * birth date. Those are gaps a person must close, and they must keep asking.
 *
 * ── THE RULE, DELIBERATELY NARROW ──────────────────────────────────────────
 * A row is settled ONLY when the vendor says, at write time, that the waiver is
 * valid AT THE CENTER THE ROW NAMES. Nothing else qualifies:
 *
 *   valid at that center      → `salvaged`. BMI has it; there is nothing to do.
 *   404 at that center        → LEFT ALONE. A BMI person id does not cross
 *                               servers, so this guest is not covered HERE, and
 *                               a valid waiver on their home-center record does
 *                               NOT make the center they walked into able to see
 *                               it. Marking these would launder a real gap.
 *   500 (null birth date)     → LEFT ALONE. The record is unreadable, so the
 *                               waiver is unknowable — and "unknown" must never
 *                               be written down as "fine".
 *   no waiver on the record   → LEFT ALONE. This is the gap the board exists for.
 *
 * `salvaged` rather than `signed` because we are not claiming our push is what
 * landed — only that BMI holds a valid waiver now. And rather than `dismissed`,
 * which is a human writing off work that cannot land: this work DID land.
 *
 * Nothing is ever deleted. The signature PNG stays in Neon, which is the only
 * evidence the guest signed at all — the same rule waiver-dismiss-unlandable
 * follows.
 *
 *   npx tsx scripts/waiver-settle-verified.mts          # report only
 *   APPLY=1 npx tsx scripts/waiver-settle-verified.mts  # write
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.env.APPLY === "1";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";

if (!PKEY) {
  console.error("SWAGGER_ADMIN_KEY missing — refusing to settle without re-verifying.");
  process.exit(1);
}

type Verdict = { settle: true; detail: string } | { settle: false; detail: string };

/**
 * Ask the center named on the row. Read as TEXT and pull the expiry with a
 * regex rather than JSON.parse: these payloads carry 17-digit person ids, and
 * the house rule is that such a body is never handed to a standard parser.
 */
async function verdictFor(locationId: string, personId: string): Promise<Verdict> {
  let res: Response;
  try {
    res = await fetch(
      `${BASE}/bmi/person/${encodeURIComponent(locationId)}/${encodeURIComponent(personId)}`,
      {
        headers: { Authorization: `Bearer ${PKEY}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return { settle: false, detail: "vendor unreachable — asking again later beats guessing" };
  }
  if (res.status === 404) {
    return {
      settle: false,
      detail: "404 at this center — the guest is not covered HERE; needs a person",
    };
  }
  if (res.status === 500) {
    return {
      settle: false,
      detail: "500 unreadable (null birth date) — waiver unknowable, not 'fine'",
    };
  }
  if (!res.ok) return { settle: false, detail: `HTTP ${res.status}` };

  const body = await res.text();
  const m = body.match(/"waiverExpiry"\s*:\s*"([^"]+)"/);
  if (!m) return { settle: false, detail: "record readable but NO waiver on file — a real gap" };
  const expiry = m[1];
  if (Date.parse(expiry) <= Date.now()) {
    return { settle: false, detail: `waiver EXPIRED ${expiry.slice(0, 10)} — still a gap` };
  }
  return { settle: true, detail: `BMI holds a valid waiver to ${expiry.slice(0, 10)}` };
}

async function main() {
  /**
   * The same population the board calls "parked" on its waiver half: a hard
   * failure, or nothing heard back well past any plausible sync window.
   */
  const rows = (await sql`
    SELECT id::text AS id, person_id, signer_person_id, location_id, outcome,
           (signature_png IS NOT NULL) AS has_png,
           to_char(ts AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS t
    FROM waiver_signatures
    WHERE outcome = 'failed'
       OR (outcome IS NULL AND ts < now() - INTERVAL '10 minutes')
    ORDER BY ts DESC
  `) as any[];

  console.log(
    `\n════ ${rows.length} flagged waiver row(s) — ${APPLY ? "APPLYING" : "DRY RUN"} ════\n`,
  );

  let settled = 0;
  let left = 0;

  for (const r of rows) {
    const v = await verdictFor(String(r.location_id), String(r.person_id));
    const who =
      r.person_id === r.signer_person_id
        ? `${r.person_id}`
        : `${r.person_id} (signed by ${r.signer_person_id})`;
    console.log(`#${r.id} ${r.t} ${r.outcome ?? "unsettled"} person=${who} @${r.location_id}`);

    if (!v.settle) {
      console.log(`   LEFT ALONE: ${v.detail}`);
      left++;
      continue;
    }

    console.log(`   ${APPLY ? "settling" : "would settle"} salvaged: ${v.detail}`);
    if (APPLY) {
      /**
       * Guarded on the outcome we read, so a push that settled itself between
       * the read and this write is never overwritten.
       */
      await sql`
        UPDATE waiver_signatures
        SET outcome = 'salvaged',
            settled_at = now(),
            last_error = ${`verified 2026-08-25: ${v.detail}`}
        WHERE id = ${Number(r.id)}
          AND (outcome = 'failed' OR outcome IS NULL)
      `;
    }
    settled++;
  }

  console.log(
    `\n${settled} ${APPLY ? "settled" : "would settle"} as salvaged, ${left} left for a human.\n`,
  );
  if (!APPLY && settled > 0) console.log("Re-run with APPLY=1 to write.\n");
  if (left > 0) {
    console.log(
      "The rows left are the point of the board: a guest whose record does not\n" +
        "exist at the center they signed at, or cannot be read at all. Those need\n" +
        "a person, not a sweep.\n",
    );
  }
}

await main();
