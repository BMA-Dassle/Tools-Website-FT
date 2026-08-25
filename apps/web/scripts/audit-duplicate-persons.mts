/**
 * READ-ONLY: which BMI person records are duplicates of each other, and which one
 * should survive a merge.
 *
 * WHY THIS EXISTS. The cloud-first mint (`POST /api/pandora` → `createOfficePerson`)
 * creates a record on every call, and several kiosk paths call it as though it were
 * an upsert ("resolve their SHORT id"). Between 2026-08-12 and 2026-08-24 that put
 * ~250 excess person records on ~190 guests, and 342 waiver signatures landed on
 * records that are not the guest's main one — so the guest is asked to sign again
 * on their NEXT visit, which mints yet another record.
 *
 * `fix/cloud-mint-dedupe` stops the bleeding. This script is the other half: the
 * work order for the records already created.
 *
 * It reads ONLY our own `bmi_sync_queue` (one `add-membership` row per cloud mint,
 * carrying the person id and name) plus the tables that say what each record is
 * WORTH — waivers signed on it, check-ins, waiver joins, licence grants. It never
 * writes, and it never calls BMI: merging is an Office-side job for a human, and
 * the point of this output is to tell them which id to keep.
 *
 * ── THIS COUNT IS A FLOOR, NOT A TOTAL ─────────────────────────────────────
 * The census is "mints that left an `add-membership` row", and three real mint
 * paths never leave one:
 *   - A MINOR minted with a `guardianID` takes the legacy Pandora rail
 *     (`mintViaPandora`), which returns before any enqueue runs.
 *   - Any mint while `PERSON_MINT_CLOUD_FIRST=false` takes that same rail.
 *   - Web booking's `registerContactPerson` with no personId mints a cloud
 *     person without touching `/api/pandora` at all.
 * So every number below undercounts, and a guest can appear here with fewer
 * records than they really have. Treat the output as a work order to start
 * from, never as the complete list — and do not report it as one.
 *
 *   npx tsx scripts/audit-duplicate-persons.mts                # groups, worst first
 *   npx tsx scripts/audit-duplicate-persons.mts --csv          # CSV for the merge pass
 *   SINCE=2026-08-12 npx tsx scripts/audit-duplicate-persons.mts
 *
 * KEEP-RECORD RULE, in order: the record with a real waiver beats one without; more
 * activity beats less; and a tie goes to the OLDEST, because that is the one the
 * guest's history is already attached to.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const CSV = process.argv.includes("--csv");
const SINCE = process.env.SINCE || "2026-08-12";

const CENTER: Record<string, string> = {
  LAB52GY480CJF: "FastTrax",
  TXBSQN0FEKQ11: "HeadPinz FM",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};

interface Rec {
  personId: string;
  firstName: string;
  lastName: string;
  locationId: string;
  mintedAt: string;
  waivers: number;
  signedFor: number;
  joins: number;
  checkins: number;
  licences: number;
  noDob: boolean;
}

/** Everything that makes a record worth keeping, in one number. A waiver dominates
 *  because re-signing is the cost the guest actually feels. */
const worth = (r: Rec): number =>
  r.waivers * 1000 + r.signedFor * 500 + r.licences * 100 + r.checkins * 10 + r.joins * 10;

const etStamp = (iso: string): string =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "America/New_York" }).slice(0, 16);

async function main() {
  // One add-membership row per cloud mint. `payload->>'personId'` is TEXT the whole
  // way — never Number() a BMI id (house rule; these are 17 digits).
  const rows = (await sql`
    SELECT q.payload->>'personId'  AS person_id,
           q.payload->>'firstName' AS first_name,
           q.payload->>'lastName'  AS last_name,
           q.location_id,
           q.created_at,
           EXISTS (SELECT 1 FROM bmi_sync_queue r
                    WHERE r.kind = 'repair-person-details'
                      AND r.payload->>'personId' = q.payload->>'personId') AS no_dob,
           (SELECT count(*) FROM waiver_signatures w
             WHERE w.person_id = q.payload->>'personId'
               AND w.outcome IN ('signed','salvaged'))                     AS waivers,
           (SELECT count(*) FROM waiver_signatures w
             WHERE w.signer_person_id = q.payload->>'personId'
               AND w.person_id <> q.payload->>'personId')                  AS signed_for,
           (SELECT count(*) FROM kiosk_waiver_joins j
             WHERE j.person_id = q.payload->>'personId')                   AS joins,
           (SELECT count(*) FROM kiosk_checkin_people k
             WHERE k.person_id = q.payload->>'personId'
                OR k.pandora_person_id = q.payload->>'personId')           AS checkins,
           (SELECT count(*) FROM race_license_grants g
             WHERE g.person_id = q.payload->>'personId')                   AS licences
    FROM bmi_sync_queue q
    WHERE q.kind = 'add-membership'
      AND q.created_at >= ${SINCE}
      AND q.payload->>'personId' IS NOT NULL
    ORDER BY q.created_at
  `) as any[];

  const byKey = new Map<string, Rec[]>();
  for (const r of rows) {
    const rec: Rec = {
      personId: String(r.person_id),
      firstName: String(r.first_name ?? ""),
      lastName: String(r.last_name ?? ""),
      locationId: String(r.location_id ?? ""),
      mintedAt: String(r.created_at),
      waivers: Number(r.waivers),
      signedFor: Number(r.signed_for),
      joins: Number(r.joins),
      checkins: Number(r.checkins),
      licences: Number(r.licences),
      noDob: r.no_dob === true,
    };
    // Name + center, case- and space-insensitive. Deliberately NOT fuzzy: a merge
    // proposal that guesses is worse than one a human has to extend by hand.
    const key = `${rec.firstName.trim().toLowerCase()}|${rec.lastName.trim().toLowerCase()}|${rec.locationId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), rec]);
  }

  const groups = [...byKey.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const ranked = [...g].sort(
        (a, b) => worth(b) - worth(a) || Date.parse(a.mintedAt) - Date.parse(b.mintedAt),
      );
      return { keep: ranked[0], merge: ranked.slice(1) };
    })
    .sort((a, b) => b.merge.length - a.merge.length);

  if (CSV) {
    console.log(
      "center,firstName,lastName,action,personId,mintedAtET,waivers,signedFor,checkins,licences,noDob",
    );
    for (const { keep, merge } of groups) {
      const all: Array<readonly ["KEEP" | "MERGE", Rec]> = [
        ["KEEP", keep],
        ...merge.map((m) => ["MERGE", m] as const),
      ];
      for (const [action, r] of all) {
        console.log(
          [
            CENTER[r.locationId] ?? r.locationId,
            JSON.stringify(r.firstName),
            JSON.stringify(r.lastName),
            action,
            r.personId,
            etStamp(r.mintedAt),
            r.waivers,
            r.signedFor,
            r.checkins,
            r.licences,
            r.noDob ? "no-dob" : "",
          ].join(","),
        );
      }
    }
    return;
  }

  const excess = groups.reduce((n, g) => n + g.merge.length, 0);
  const strandedWaivers = groups.reduce(
    (n, g) => n + g.merge.reduce((m, r) => m + r.waivers + r.signedFor, 0),
    0,
  );
  const noDobRecords = groups.reduce((n, g) => n + g.merge.filter((r) => r.noDob).length, 0);
  /**
   * A keeper that itself has no birth date is the WORST case in this report and the
   * easiest to miss: it wins the group on waiver count, so the merge looks done —
   * but Pandora answers 500 for it, every waiver check reads "no waiver", and the
   * guest gets asked to sign again on their next visit, minting the next duplicate.
   * Merging onto it without adding a DOB restarts the loop this report exists to end.
   */
  const keepersNoDob = groups.filter((g) => g.keep.noDob).map((g) => g.keep);

  console.log(`\n═══ duplicate BMI person records since ${SINCE} ═══`);
  console.log(`  (a FLOOR, not a total — guardian-linked minors and web-booking`);
  console.log(`   mints leave no queue row and cannot be seen from here)`);
  console.log(`  ${rows.length} cloud mints → ${groups.length} guests with more than one record`);
  console.log(`  ${excess} records to merge away`);
  console.log(
    `  ${strandedWaivers} waiver signature(s) stranded on a record that is not the keeper`,
  );
  console.log(
    `  ${noDobRecords} of the merge-away records have NO birth date (they read 500 on Pandora)`,
  );
  if (keepersNoDob.length > 0) {
    console.log(
      `\n  ⚠ ${keepersNoDob.length} KEEP record(s) have no birth date — add one in BMI Office BEFORE\n` +
        `    merging, or the keeper stays unreadable and the guest re-signs into a new duplicate:`,
    );
    for (const r of keepersNoDob) {
      console.log(
        `      ${r.personId}  ${r.firstName} ${r.lastName} · ${CENTER[r.locationId] ?? r.locationId}`,
      );
    }
  }
  console.log();

  for (const { keep, merge } of groups) {
    const who = `${keep.firstName} ${keep.lastName}`.trim();
    console.log(
      `── ${who} · ${CENTER[keep.locationId] ?? keep.locationId} · ${merge.length + 1} records`,
    );
    const line = (tag: string, r: Rec) => {
      const bits = [
        r.waivers ? `${r.waivers} waiver` : "",
        r.signedFor ? `signed for ${r.signedFor}` : "",
        r.licences ? `${r.licences} licence` : "",
        r.checkins ? `${r.checkins} check-in` : "",
        r.noDob ? "NO DOB (reads 500)" : "",
      ].filter(Boolean);
      console.log(
        `   ${tag} ${r.personId}  ${etStamp(r.mintedAt).slice(5)}  ${bits.join(", ") || "nothing attached"}`,
      );
    };
    line("KEEP ", keep);
    for (const m of merge) line("merge", m);
    console.log();
  }

  console.log(`Merging is an Office-side job: move the waiver + history onto the KEEP id, then
retire the others. This script never writes. Re-run it after the merge pass to confirm.
The root cause is fixed separately in fix/cloud-mint-dedupe — merging without that fix
just makes room for tomorrow's duplicates.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
