/**
 * Close the work orders standing on the BMI sync board on 2026-08-24.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `APPLY=1`.
 *
 * WHY. 33 rows were parked — "gave up, a human is needed" — and an investigation
 * that day found not one of them was a live fault:
 *
 *   16 × stamp-confirmation-state  the party raced; they were moved to another
 *                                  heat, or raced under a duplicate person
 *                                  record, so the exact-heat gate never opened.
 *   16 × repair-person-details     a duplicate record minted with no birth date.
 *                                  The message says "add a DOB in BMI Office",
 *                                  but it names the DUPLICATE, not the guest's
 *                                  real record — doing what it says would make
 *                                  the wrong record readable.
 *    1 × add-membership            a Naples registration for a person whose
 *                                  record lives at Fort Myers. Ids do not cross
 *                                  servers; this one can never land here.
 *
 * The causes are fixed elsewhere (fix/cloud-mint-dedupe stops the duplicates,
 * fix/party-seated-lapse widens the gate and lets a stamp lapse instead of
 * parking). This script deals with the rows already on the board, so the badge
 * can go quiet for the right reason instead of being ignored.
 *
 * ── IT RE-VERIFIES BEFORE IT WRITES ────────────────────────────────────────
 * The house rule for this kind of sweep (scripts/waiver-dismiss-unlandable.mts)
 * is that a row is only closed if it is STILL unlandable at write time. A row
 * that has since become landable must be re-driven, never buried. So each stamp
 * row is re-probed against Pandora's live grid, and anything that would now
 * OPEN is left alone for the queue to finish.
 *
 *   npx tsx scripts/syncboard-clear-parked-0824.mts          # report only
 *   APPLY=1 npx tsx scripts/syncboard-clear-parked-0824.mts  # write
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
const WHO = process.env.BY || "sync-board cleanup 2026-08-24";

/**
 * The barrier is loaded INSIDE main(), not at module scope.
 *
 * `next build` type-checks everything under the app, scripts included, and a
 * top-level await here fails that build — which is a real cost for a file the
 * app never imports. (It did: this script broke the build on first write.)
 * The app's .ts also compiles to CJS under tsx, so a named ESM import would not
 * surface the exports; hence the interop dance rather than a plain import.
 */
async function loadBarrier() {
  const mod: any = await import("../lib/bmi-sync-barriers");
  const { partySeatedBarrier, nyWallClockKey } = mod.default ?? mod;
  return { partySeatedBarrier, nyWallClockKey };
}

/** Why each kind is being closed. Kept ON the row, so it explains itself later. */
const REASON: Record<string, string> = {
  "stamp-confirmation-state":
    "party raced (moved heat, or raced under a duplicate record) — stamp no longer meaningful; " +
    "gate widened + lapse added in fix/party-seated-lapse",
  "repair-person-details":
    "no-DOB DUPLICATE person record — repairing it would fix the wrong record; " +
    "see scripts/audit-duplicate-persons.mts for the record to keep",
  "add-membership":
    "person's record lives at the other center — a BMI person id does not cross servers, " +
    "so this can never land here",
};

async function main() {
  const { partySeatedBarrier, nyWallClockKey } = await loadBarrier();
  const rows = (await sql`
    SELECT id::text AS id, kind, reservation_ref, location_id, payload, last_error,
           to_char(created_at AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS created,
           created_at
    FROM bmi_sync_queue
    WHERE status = 'parked'
    ORDER BY created_at
  `) as any[];

  console.log(`\n═══ ${rows.length} parked row(s) — ${APPLY ? "APPLYING" : "DRY RUN"} ═══\n`);

  let closed = 0;
  let skipped = 0;
  let landable = 0;

  for (const r of rows) {
    const kind = String(r.kind);
    const reason = REASON[kind];
    if (!reason) {
      console.log(`#${r.id} ${r.created} ${kind} — no rule for this kind, LEFT ALONE`);
      skipped++;
      continue;
    }

    /**
     * RE-VERIFY THE STAMPS. A stamp row is the only kind here whose verdict can
     * have changed on its own (a racer seated late), and it is cheap to ask.
     * Anything that would now open is left for the queue to land properly.
     */
    if (kind === "stamp-confirmation-state") {
      const payload = r.payload as Record<string, unknown>;
      const ids = ((payload.personIds as string[]) ?? []).map(String);
      const seats = ((payload.seats as any[]) ?? []).map((s) => ({
        personId: String(s.personId),
        heatStart: String(s.heatStart),
      }));
      const verdict = await partySeatedBarrier(
        String(r.location_id || "LAB52GY480CJF"),
        ids,
        seats,
        nyWallClockKey(String(r.created_at)),
      );
      if (verdict.verdict === "open") {
        console.log(
          `#${r.id} ${r.created} ${kind} — WOULD LAND NOW (${verdict.detail.slice(0, 70)})\n` +
            `   left alone: re-drive it rather than closing it`,
        );
        landable++;
        continue;
      }
    }

    console.log(`#${r.id} ${r.created} ${kind} rez=${r.reservation_ref ?? "—"}`);
    console.log(`   was: ${String(r.last_error ?? "").slice(0, 100)}`);
    console.log(`   ${APPLY ? "closing" : "would close"}: ${reason.slice(0, 100)}`);

    if (APPLY) {
      await sql`
        UPDATE bmi_sync_queue
        SET status = 'dismissed', resolved_at = now(), updated_at = now(),
            last_error = ${`${WHO}: ${reason}`.slice(0, 500)}
        WHERE id = ${Number(r.id)} AND status = 'parked'
      `;
    }
    closed++;
  }

  console.log(
    `\n${closed} ${APPLY ? "closed" : "would close"}, ` +
      `${landable} left to re-drive (would land now), ${skipped} untouched.`,
  );
  if (!APPLY) console.log(`\nRe-run with APPLY=1 to write.`);
  console.log(
    `\nThis closes ROWS, not causes. The duplicate person records behind the\n` +
      `repair rows still need a merge pass — scripts/audit-duplicate-persons.mts.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
