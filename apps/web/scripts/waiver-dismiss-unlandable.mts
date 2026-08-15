/**
 * Mark a waiver signature `dismissed` — a human's verdict that it cannot land.
 *
 * WHY THIS EXISTS INSTEAD OF A DELETE. When BMI has refused a signature, the PNG
 * in `waiver_signatures` is the ONLY evidence the guest ever signed. Deleting the
 * row to clear the board destroys that evidence; `dismissed` clears the board and
 * keeps it. The row reads as finished on the admin board and stops asking for
 * help, while `guestAddStatus` still refuses to call the guest waivered — because
 * they are not.
 *
 * Used 2026-08-14 for two HeadPinz Naples signatures whose person id 404s at
 * Naples while the SIGNER resolves there. A BMI person id never crosses centers,
 * so no retry can ever land these: the push is aimed at a center where the person
 * does not exist. Verified per-center before dismissing, at write time.
 *
 *   npx tsx scripts/waiver-dismiss-unlandable.mts           # dry run
 *   APPLY=1 npx tsx scripts/waiver-dismiss-unlandable.mts   # write
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

/** Person ids whose signature is being dismissed. Explicit — never a wildcard. */
const PERSON_IDS = ["57674392", "27644106"];

if (!PKEY) {
  console.error("SWAGGER_ADMIN_KEY missing — refusing to dismiss without re-verifying.");
  process.exit(1);
}

const rows = (await sql`
  SELECT id, person_id, signer_person_id, location_id, outcome,
         (signature_png IS NOT NULL) AS has_png,
         EXTRACT(EPOCH FROM (now() - ts)) / 60 AS age_min
  FROM waiver_signatures
  WHERE person_id = ANY(${PERSON_IDS}) AND outcome IS DISTINCT FROM 'dismissed'
  ORDER BY id
`) as Array<Record<string, any>>;

console.log(`\n════ dismiss unlandable signatures (${APPLY ? "APPLY" : "DRY-RUN"}) ════\n`);
if (!rows.length) console.log("  nothing matching — already dismissed?\n");

for (const r of rows) {
  // Re-verify AT WRITE TIME: the person must still be absent at the target
  // center. If they have since appeared, this row is landable and must NOT be
  // dismissed — it should be re-driven instead.
  const res = await fetch(`${BASE}/bmi/person/${r.location_id}/${r.person_id}`, {
    headers: { Authorization: `Bearer ${PKEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  const status = res?.status ?? 0;
  const absent = status === 404;

  console.log(
    `  sig#${String(r.id).padEnd(6)} person ${String(r.person_id).padEnd(20)} ` +
      `outcome=${String(r.outcome).padEnd(8)} age=${Math.round(Number(r.age_min))}m ` +
      `png=${r.has_png ? "kept" : "NONE"}  person@center=${status || "ERR"}`,
  );

  if (!absent) {
    console.log(
      `      ↳ SKIP — person is ${status} at this center, not 404. This may be landable; re-drive instead.`,
    );
    continue;
  }
  if (APPLY) {
    await sql`UPDATE waiver_signatures SET outcome = 'dismissed', settled_at = now() WHERE id = ${r.id}`;
    console.log(`      ↳ dismissed (signature PNG retained)`);
  } else {
    console.log(`      ↳ would dismiss (signature PNG retained)`);
  }
}
console.log(APPLY ? "\n  done.\n" : "\n  DRY RUN — re-run with APPLY=1.\n");
