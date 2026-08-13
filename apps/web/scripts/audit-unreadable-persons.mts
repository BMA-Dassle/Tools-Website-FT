/**
 * Who signed a waiver we cannot read back?
 *
 * THE SILENT FAILURE THIS CATCHES. A person with no birth date exists on the
 * center's local server but Pandora answers HTTP 500 "Response Validator Error"
 * for them — the record is present and UNREADABLE. Writes still work, so the guest
 * signs successfully and nothing fails today. The cost lands on their NEXT visit:
 * every consumer treats a 500 as "no waiver", so they are sent back to a signature
 * pad for a waiver they already hold. (Eric's was valid until 2027-08-08 the whole
 * time we were telling him to sign.)
 *
 * Nothing else surfaces this. `waiver_sign_attempts` says `signed`, the sync queue
 * is empty, the admin board is green — because from every angle we log, it worked.
 *
 * WHY THEY EXIST. `public-booking registerContactPerson` has no birthDate field at
 * all, so anyone minted by an online booking is DOB-less by construction. The
 * cloud-first mint (`createOfficePerson`) does carry it, so kiosk-minted guests land
 * readable — which is why this shows up as a trickle rather than a flood.
 *
 * WHY IT IS NOT SELF-HEALING. `repair-person-details` is only ever enqueued at MINT
 * time, and only when that mint had no birth date — and its payload carries no birth
 * date either, so it parks with "nothing to repair with". Nothing detects an existing
 * 500-ing person. A human has to add the DOB in BMI Office.
 *
 * Read-only. Never writes. Exits 0 with a clean report, 1 when it finds someone, so
 * a scheduler can treat a finding as actionable.
 *
 *   npx tsx scripts/audit-unreadable-persons.mts [hoursBack=24]
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const HOURS = Number(process.argv[2] ?? 24);
const sql = neon(process.env.DATABASE_URL!);
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const CENTRES: Record<string, string> = {
  LAB52GY480CJF: "FastTrax",
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};

/** Two attempts, because a vendor timeout is "unknown" and must never read as "fine". */
async function probe(personId: string, loc: string): Promise<{ status: number; name: string }> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${BASE}/bmi/person/${loc}/${personId}?picture=false&allRelated=false`, {
        headers: { Authorization: `Bearer ${KEY}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      let d: any = null;
      try {
        d = JSON.parse(await res.text());
      } catch {}
      const name = [d?.data?.firstName, d?.data?.lastName].filter(Boolean).join(" ");
      return { status: res.status, name };
    } catch {
      /* retry once */
    }
  }
  return { status: 0, name: "" };
}

const people = (await sql`
  SELECT DISTINCT ON (person_id) person_id, location_id, ts
  FROM waiver_signatures
  WHERE ts > now() - (${HOURS} * INTERVAL '1 hour')
  ORDER BY person_id, ts DESC
`) as any[];

/** Same ceiling the kiosk uses for its own bulk waiver checks — polite to the vendor,
 *  and the difference between a 3-minute audit and a 20-second one. */
const CONCURRENCY = 5;
const unreadable: any[] = [];
const unknown: string[] = [];
for (let i = 0; i < people.length; i += CONCURRENCY) {
  await Promise.all(
    people.slice(i, i + CONCURRENCY).map(async (p) => {
      const loc = p.location_id || "LAB52GY480CJF";
      const r = await probe(String(p.person_id), loc);
      if (r.status === 500) unreadable.push({ ...p, ...r, loc });
      else if (r.status === 0) unknown.push(String(p.person_id));
    }),
  );
}
unreadable.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

console.log(
  `\n[unreadable-persons] ${people.length} signer(s) in the last ${HOURS}h — ` +
    `${unreadable.length} unreadable, ${unknown.length} could not be checked\n`,
);
for (const u of unreadable) {
  console.log(
    `  ${u.person_id}  ${(u.name || "(name unreadable)").padEnd(24)} ${CENTRES[u.loc] ?? u.loc}\n` +
      `      signed ${new Date(u.ts).toISOString().slice(0, 16)} — Pandora 500, NO birth date.\n` +
      `      FIX: add a birth date to this person in BMI Office. Often a DUPLICATE record —\n` +
      `           check for another with the same name/phone; that one usually has the DOB.`,
  );
}
if (unknown.length) console.log(`  could not check (vendor timeout): ${unknown.join(", ")}`);
if (!unreadable.length && !unknown.length) console.log("  clean — every signer today reads back fine.");
console.log("");

process.exit(unreadable.length ? 1 : 0);
