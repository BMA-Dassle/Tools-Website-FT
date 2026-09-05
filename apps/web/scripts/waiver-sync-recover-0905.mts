/**
 * Recover everything stranded by the 2026-09-05 Pandora outage.
 *
 * NEON-ONLY. This makes NO vendor call and files nothing with BMI. All it does is
 * put rows into states the PRODUCTION crons already know how to drive:
 * `/api/cron/bmi-sync-queue` (every 2 min) does the actual Pandora work, barrier-
 * gated, with `skipIfValid: true`. That is deliberate — a recovery script that
 * writes to the vendor itself is a second writer on entities the cron owns, and
 * one-writer-per-BMI-entity is the house rule that keeps duplicate waivers and
 * duplicate memberships from existing.
 *
 * FOUR POPULATIONS, from the 2026-09-05 assessment:
 *
 *  1. 71 signatures at `outcome='queued'` with no `waiver_id`. The Vercel Queues
 *     consumer acknowledged and dropped their messages without settling the row,
 *     so nothing has driven them since. Give each a durable `bmi_sync_queue` row.
 *     The handler then sorts them out by itself:
 *       - already has a valid waiver (56 of them) → settled `salvaged`, no write
 *       - genuinely owed (13)                     → filed
 *       - person not at this center (2)           → settled `failed`
 *     We do NOT pre-classify here. `skipIfValid` re-reads the vendor at run time,
 *     which is the only reading that is true when the write happens.
 *
 *  2. One `add-membership` parked cross-center (#4569, Naples) — a PAID entitlement
 *     never granted. Re-aim it at the center that actually has the person.
 *
 *     AND THEN DO NOT, unless the center name parses UNAMBIGUOUSLY. This row is
 *     why the guard below refuses rather than guesses, and the refusal is the most
 *     important line in this script: the park said Eleanor Seeger's id "does not
 *     exist at this center — their record is at the Fort Myers server". The id DOES
 *     resolve there — to **a different human** (`joseph sibaja`). Eleanor was at
 *     Naples the whole time; the barrier had simply probed before she synced. Had
 *     this re-aimed on an id match, it would have granted her paid licence to a
 *     stranger. BMI person ids are PER-SERVER: an id existing elsewhere says
 *     nothing about whose it is. Re-arm in place and let the barrier re-probe.
 *     (Confirmed 2026-09-05: re-armed at Naples unchanged → membership 8716222.)
 *
 *  3. Seven `repair-person-details` parked with "NO date of birth in Office
 *     either". These can never succeed: the upstream record has no DOB to copy, so
 *     there is nothing to write. They are noise on the work-order board. DISMISS —
 *     a human verdict that it will not land and is not worth chasing — which keeps
 *     the row and its reason readable later without it alarming anyone.
 *
 *  4. Nineteen `lapsed` stamp-confirmation-state rows. NOT TOUCHED, and not a
 *     fault: each says "last heat was Nh ago — the check-in stamp has nothing left
 *     to say". That is the give-up rule working correctly. Listed for confirmation
 *     only.
 *
 * SAFETY
 *  - Idempotency key is per signature row, so re-running is a no-op, never a
 *    second waiver.
 *  - `MIN_AGE_MINUTES` keeps us off any signature the Queues topic may still hold.
 *  - Every barrier still gates every write; nothing fires until Pandora can see
 *    the people.
 *  - Rows with no stored PNG are skipped, never filed with a generated mark.
 *  - BMI ids stay TEXT throughout. Never Number() them.
 *
 * Dry run by default. APPLY=1 to write.
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
const MIN_AGE_MINUTES = 25;

const CENTER: Record<string, string> = {
  LAB52GY480CJF: "FastTrax",
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
const idForName = (n: string) => Object.entries(CENTER).find(([, v]) => v === n)?.[0] ?? null;
const cn = (id: any) => CENTER[String(id)] ?? String(id ?? "—");

console.log(
  `\n════════ waiver/sync recovery (${APPLY ? "APPLY" : "DRY-RUN"}) ${new Date().toLocaleString()} ════════`,
);

// ══ 1. Stranded signatures → give each a durable queue row ═════════════════
console.log(
  `\n─── 1. Stranded signatures (>${MIN_AGE_MINUTES}m, no waiver_id, nothing driving) ───`,
);
const sigs = (await sql`
  SELECT s.id, s.person_id, s.signer_person_id, s.waiver_content_id, s.location_id,
         s.invalidation_date, s.outcome, s.signature_png IS NOT NULL AS has_image,
         ROUND(EXTRACT(EPOCH FROM (now() - s.ts))/60) AS age_min,
         z.id AS queue_id, z.status AS queue_status,
         (SELECT j.display_name FROM kiosk_waiver_joins j
           WHERE j.person_id = s.person_id ORDER BY j.created_at DESC LIMIT 1) AS join_name
  FROM waiver_signatures s
  LEFT JOIN bmi_sync_queue z
    ON z.idempotency_key = 'waiver-redrive-sig-' || s.id::text
  WHERE s.waiver_id IS NULL
    AND (s.outcome IS NULL OR s.outcome IN ('queued','owed'))
    AND s.ts < now() - (${MIN_AGE_MINUTES} * INTERVAL '1 minute')
  ORDER BY s.ts ASC
`) as any[];

let armed = 0;
let skipped = 0;
for (const s of sigs) {
  const pid = String(s.person_id);
  const signer = String(s.signer_person_id || s.person_id);
  const label = s.join_name ? String(s.join_name) : pid;
  const qs = s.queue_status === null ? null : String(s.queue_status);

  if (!s.has_image) {
    console.log(
      `  sig#${s.id} ${pid} — NO stored PNG; refusing to file a generated mark. SKIPPED.`,
    );
    skipped++;
    continue;
  }
  if (qs === "pending" || qs === "done") {
    skipped++;
    continue;
  }

  const ids = [...new Set([pid, signer])];
  console.log(
    `  sig#${String(s.id).padEnd(5)} ${label.padEnd(22)} ${pid.padEnd(20)} ` +
      `${cn(s.location_id).padEnd(20)} age=${String(s.age_min).padStart(4)}m ` +
      `${qs ? `[requeue: was ${qs}]` : "[new]"}${ids.length > 1 ? `  guardian=${signer}` : ""}`,
  );
  armed++;
  if (!APPLY) continue;

  if (qs === "parked") {
    await sql`
      UPDATE bmi_sync_queue
      SET status='pending', attempts=0, next_attempt_at=now(),
          give_up_at=now() + INTERVAL '12 hours', resolved_at=NULL, push_transport=NULL,
          updated_at=now(),
          last_error='re-armed by waiver-sync-recover-0905'
      WHERE id = ${Number(s.queue_id)}
    `;
    continue;
  }

  const payload = {
    personId: pid,
    // Handler guard only — never transmitted, because the real PNG is attached below.
    name: label,
    signerPersonId: signer,
    waiverContentId: String(s.waiver_content_id),
    invalidationDate: s.invalidation_date ? String(s.invalidation_date) : null,
    signatureRowId: Number(s.id),
    // persons-local needs BOTH the subject and the signing guardian.
    personIds: ids,
  };
  // The PNG is copied inside the database rather than round-tripped through here.
  await sql`
    INSERT INTO bmi_sync_queue
      (kind, idempotency_key, barrier, barrier_ref, location_id, payload,
       next_attempt_at, give_up_at, status, last_error)
    SELECT 'push-waiver-signature', ${`waiver-redrive-sig-${s.id}`}, 'persons-local',
           ${pid}, ${String(s.location_id)},
           ${JSON.stringify(payload)}::jsonb
             || jsonb_build_object('signaturePngB64', w.signature_png),
           now(), now() + INTERVAL '12 hours', 'pending',
           'armed by waiver-sync-recover-0905 — the push transport dropped this signature'
    FROM waiver_signatures w
    WHERE w.id = ${Number(s.id)} AND w.signature_png IS NOT NULL
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}
console.log(`  → ${armed} armed, ${skipped} already driven or unfilable.`);

// ══ 2. Cross-center memberships → re-aim at the center that HAS the person ══
console.log(`\n─── 2. Parked cross-center entitlements (re-aim + re-arm) ───`);
const wrong = (await sql`
  SELECT id, kind, location_id, barrier_ref, last_error, payload, attempts
  FROM bmi_sync_queue
  WHERE status='parked'
    AND kind IN ('add-membership','push-waiver-signature')
    AND (last_error LIKE '%do not cross centers%' OR last_error LIKE '%does not exist at this center%')
  ORDER BY id
`) as any[];
let reaimed = 0;
for (const r of wrong) {
  const m = String(r.last_error).match(/(?:they are at|record is at the) ([A-Za-z ]+?)[.,]/);
  const targetName = m?.[1]?.trim() ?? null;
  const target = targetName ? idForName(targetName) : null;
  const who =
    [r.payload?.firstName, r.payload?.lastName].filter(Boolean).join(" ") || r.payload?.name || "";
  if (!target || target === String(r.location_id)) {
    console.log(
      `  #${r.id} ${String(r.kind).padEnd(16)} ${who} — cannot re-aim ` +
        `(parsed center: ${targetName ?? "none"}). LEFT PARKED for a human.`,
    );
    console.log(`        ↳ ${String(r.last_error).slice(0, 160)}`);
    continue;
  }
  console.log(
    `  #${r.id} ${String(r.kind).padEnd(16)} ${who.padEnd(20)} ${cn(r.location_id)} → ${targetName}`,
  );
  reaimed++;
  if (APPLY) {
    await sql`
      UPDATE bmi_sync_queue
      SET location_id=${target}, status='pending', attempts=0, next_attempt_at=now(),
          give_up_at=now() + INTERVAL '12 hours', resolved_at=NULL, push_transport=NULL,
          updated_at=now(),
          last_error=${`re-aimed at ${targetName} by waiver-sync-recover-0905`}
      WHERE id = ${Number(r.id)}
    `;
  }
}
console.log(`  → ${reaimed} re-aimed of ${wrong.length} parked cross-center row(s).`);

// ══ 3. Unfixable birthdate repairs → dismiss (kill the noise) ═══════════════
console.log(`\n─── 3. repair-person-details with no DOB upstream (dismiss) ───`);
const noDob = (await sql`
  SELECT id, barrier_ref, location_id, LEFT(last_error, 90) AS err
  FROM bmi_sync_queue
  WHERE status='parked' AND kind='repair-person-details'
    AND last_error LIKE '%NO date of birth in Office either%'
  ORDER BY id
`) as any[];
for (const r of noDob) {
  console.log(`  #${r.id} ${String(r.barrier_ref).padEnd(20)} ${cn(r.location_id)} — ${r.err}`);
}
if (APPLY && noDob.length > 0) {
  await sql`
    UPDATE bmi_sync_queue
    SET status='dismissed', resolved_at=now(), updated_at=now(),
        last_error = COALESCE(last_error,'') ||
          ' | dismissed 2026-09-05: Office has no DOB to copy, so there is nothing this row can ever write.'
    WHERE status='parked' AND kind='repair-person-details'
      AND last_error LIKE '%NO date of birth in Office either%'
  `;
}
console.log(`  → ${noDob.length} row(s) ${APPLY ? "dismissed" : "would be dismissed"}.`);

// ══ 4. Lapsed stamps — confirm, never touch ════════════════════════════════
const lapsed = (await sql`
  SELECT COUNT(*)::int n FROM bmi_sync_queue WHERE status='lapsed'
`) as any[];
console.log(
  `\n─── 4. Lapsed check-in stamps: ${lapsed[0]?.n ?? 0} — correct, left alone ───\n` +
    `      Each says the last heat had already run, so the stamp had nothing left\n` +
    `      to say. That is the give-up rule working, not a backlog.`,
);

console.log(
  `\n════════ ${APPLY ? "APPLIED" : "DRY RUN — re-run with APPLY=1 to write"} ════════\n` +
    `Production's /api/cron/bmi-sync-queue (every 2 min) does the vendor work from here.\n`,
);
