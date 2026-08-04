/**
 * READ-ONLY forensics on Adam Houghtaling (BMI personId 56177017) — the W53940
 * false-express guest. Answers: did he EVER have a waiver, and does he have
 * duplicate BMI records (one of which might carry the signature)?
 *
 * Dumps: full Pandora person object, BMI Office person detail (waiver /
 * document / membership fields), and every same-name Office search hit with its
 * own Pandora waiver state.
 *
 * Usage (from apps/web):  npx tsx scripts/w53940-person-forensics.mts [personId] [name]
 * NO WRITES.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const PID = process.argv[2] || "56177017";
const NAME = process.argv[3] || "Houghtaling";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "TXBSQN0FEKQ11";

// ── Pandora person, full object ────────────────────────────────────────
const pRes = await fetch(`${PANDORA_URL}/bmi/person/${LOC}/${PID}?picture=false&allRelated=true`, {
  headers: { Authorization: `Bearer ${PKEY}` },
});
const pJson = (await pRes.json()) as { data?: Record<string, unknown> };
console.log(`\n══ Pandora person ${PID} (full) ══`);
console.log(JSON.stringify(pJson.data ?? pJson, null, 1));

// ── BMI Office: person detail + same-name search ────────────────────────
// `searchOfficePersons` may or may not exist depending on when this ran — the
// typeof guard below is the real check, so the import stays deliberately loose.
const { searchOfficePersons, fetchOfficePerson } = (await import("@/lib/bmi-office-actions").catch(
  () => ({}),
)) as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;
if (typeof searchOfficePersons === "function") {
  const hits = (await searchOfficePersons("fort-myers", NAME, 25).catch((e: Error) => {
    console.log(`office search failed: ${e.message}`);
    return [];
  })) as Array<Record<string, unknown>>;
  console.log(`\n══ Office search "${NAME}" → ${hits.length} hit(s) ══`);
  for (const h of hits) {
    console.log(JSON.stringify(h));
  }
  if (typeof fetchOfficePerson === "function") {
    const detail = await fetchOfficePerson("fort-myers", PID).catch((e: Error) => {
      console.log(`office person detail failed: ${e.message}`);
      return null;
    });
    console.log(`\n══ Office person detail ${PID} ══`);
    console.log(JSON.stringify(detail, null, 1));
  }
} else {
  console.log("\n(bmi-office-actions exports not available under this name — see below)");
  const mod = await import("@/lib/bmi-office-actions");
  console.log(`exports: ${Object.keys(mod).join(", ")}`);
}
process.exit(0);
