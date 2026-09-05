import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sql, isDbConfigured } from "@/lib/db";
import { settleWaiverSignature } from "@/lib/waiver-signature-store";

/**
 * GET /api/cron/waiver-redrive — every 5 minutes. The thing that makes a captured
 * signature IMPOSSIBLE to strand.
 *
 * ── WHY THIS EXISTS (2026-09-05) ────────────────────────────────────────────
 * Waiver pushes ride Vercel Queues. That consumer retries a closed barrier for
 * ~20 deliveries and then acknowledges — and for a year it did so WITHOUT
 * settling the Neon row, leaving `waiver_signatures.outcome = 'queued'`, which is
 * byte-identical to a push still in flight. At that moment the row has: no queue
 * message (dropped), no `bmi_sync_queue` row (Queues bypasses it), and no cron
 * over the table. Nothing re-drove it. Ever.
 *
 * Pandora outages are longer than that ladder, so the failure is not rare — it is
 * guaranteed, once per outage, for every guest who signed during it:
 *   2026-08-13 — stranded signatures, cleared BY HAND (scripts/sync-redrive-0813.mts)
 *   2026-09-05 — 69 stranded again; 13 guests raced with no waiver record at BMI
 * The 8/13 script's own header says it: "once dropped, NOTHING re-drives them."
 * It was run, it worked, and the hole was left open. This cron is that script
 * promoted to a scheduled owner of the table, which is what should have happened
 * the first time. `bmi_sync_queue` has 19 `lapsed` and 24 `dismissed` rows in
 * statuses NO code writes — every recovery this system has had was a human with
 * SQL, and that is the pattern being retired here.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Almost nothing, deliberately. It does NOT talk to BMI and files no waiver. It
 * finds signatures we hold that BMI does not, and gives each one a durable
 * `bmi_sync_queue` row — the rail that already works: barrier-gated, attempt-aware,
 * 12h of patience, parked rows reported on every run, and a handler that settles
 * `waiver_signatures` with the outcome. One mechanism, not two.
 *
 * ── WHY IT CANNOT DOUBLE-FILE ───────────────────────────────────────────────
 *  - `MIN_AGE_MINUTES` follows the CONSUMER's ladder, not the board's 10-minute
 *    display threshold. A younger signature is still being retried by the topic,
 *    and adding a queue row would put two writers on one BMI entity — both call
 *    `signWaiverDigital`, both consult `skipIfValid`, and two that pass together
 *    file two waivers. House rule: one writer per BMI entity.
 *  - The idempotency key is per SIGNATURE ROW, so re-running is a no-op.
 *  - The handler runs `skipIfValid: true`, so a guest who already holds a valid
 *    waiver is settled `salvaged` — never re-signed, never given a SHORTER expiry.
 *    That is also how the 56 mislabeled rows from 9/5 reconcile themselves.
 *
 * ── WHEN IT GIVES UP ────────────────────────────────────────────────────────
 * On `impossible`, and nothing else (owner 2026-09-05: "it should never
 * completely give up unless reservation is in past and it cant do anything with
 * it"). A waiver is a legal record tied to a PERSON, not a reservation, and is
 * good for a year — a past visit does not make it worthless, so there is no time
 * window on the query at all. A row ends only when it lands (`signed`/`salvaged`)
 * or when the barrier proves it never can (the person does not exist at this
 * center — BMI ids do not cross centers), which this settles `failed` so it stops
 * being re-driven and starts being a work order.
 *
 * Kill switch `WAIVER_REDRIVE=false`. `?token=<ADMIN_CAMERA_TOKEN>` for a manual
 * run, `?dryRun=1` to report without writing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Old enough that the Queues topic has provably let go. The consumer's ladder is
 * 4×10s + 6×30s + 9×120s ≈ 22 minutes on the fast path; the unreachable schedule
 * stretches it to ~85. 25 covers the fast path, and a row still held by a slow
 * ladder simply gets picked up on a later run — late is fine, double-filing is not.
 */
const MIN_AGE_MINUTES = 25;

/** Batch ceiling. An outage backlog is tens of rows, not thousands. */
const BATCH = 200;

/** Reasons a parked queue row must NOT be re-armed — re-arming reproduces the park. */
function isImpossible(lastError: string | null): boolean {
  if (!lastError) return false;
  return /do not cross centers|does not exist at this center|another center|no handler for kind/i.test(
    lastError,
  );
}

interface Outcome {
  signatureRowId: number;
  personId: string;
  action: string;
  detail?: string;
}

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const denied = verifyCron(req);
    if (denied) return denied;
  }
  if (process.env.WAIVER_REDRIVE === "false") {
    return NextResponse.json({ ok: true, disabled: true });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: true, skipped: "no database" });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const started = Date.now();
  const q = sql();
  const counts = { owed: 0, armed: 0, rearmed: 0, impossible: 0, noImage: 0, alreadyDriven: 0 };
  const outcomes: Outcome[] = [];

  /**
   * Everything we captured that BMI does not have.
   *
   * `waiver_id IS NULL` is the real test — outcome is bookkeeping and has been
   * wrong before, but a null waiver id means no vendor record, full stop.
   * `failed` and `dismissed` are excluded because both are verdicts that a human
   * (or the impossible barrier) already reached; re-driving them would loop.
   *
   * The LEFT JOIN pulls the redrive row's state in the same read, so a row already
   * being driven costs no extra query.
   */
  const rows = (await q`
    SELECT s.id, s.person_id, s.signer_person_id, s.waiver_content_id, s.location_id,
           s.invalidation_date, s.outcome, s.signature_png IS NOT NULL AS has_image,
           ROUND(EXTRACT(EPOCH FROM (now() - s.ts)) / 60) AS age_min,
           z.id AS queue_id, z.status AS queue_status, z.last_error AS queue_error,
           (SELECT j.display_name FROM kiosk_waiver_joins j
             WHERE j.person_id = s.person_id ORDER BY j.created_at DESC LIMIT 1) AS join_name
    FROM waiver_signatures s
    LEFT JOIN bmi_sync_queue z
      ON z.idempotency_key = 'waiver-redrive-sig-' || s.id::text
    WHERE s.waiver_id IS NULL
      AND (s.outcome IS NULL OR s.outcome IN ('queued', 'owed'))
      AND s.ts < now() - (${MIN_AGE_MINUTES} * INTERVAL '1 minute')
    ORDER BY s.ts ASC
    LIMIT ${BATCH}
  `) as Array<Record<string, unknown>>;

  counts.owed = rows.length;

  for (const r of rows) {
    const sigId = Number(r.id);
    // BMI ids are TEXT end-to-end and exceed MAX_SAFE_INTEGER — never Number() them.
    const personId = String(r.person_id);
    const signerId = String(r.signer_person_id || r.person_id);
    const label = r.join_name ? String(r.join_name) : personId;
    const queueStatus = r.queue_status === null ? null : String(r.queue_status);
    const queueError = r.queue_error === null ? null : String(r.queue_error);
    const push = (action: string, detail?: string) =>
      outcomes.push({ signatureRowId: sigId, personId, action, detail });

    // A parked row whose barrier can never open is a work order, not a retry.
    // Settle the signature so it leaves this sweep and lands on the board.
    if (queueStatus === "parked" && isImpossible(queueError)) {
      counts.impossible++;
      push("settled-failed", queueError ?? undefined);
      if (!dryRun) {
        await settleWaiverSignature(sigId, "failed", null, queueError);
      }
      continue;
    }

    if (queueStatus === "pending" || queueStatus === "done") {
      counts.alreadyDriven++;
      continue;
    }

    /**
     * No stored PNG — refuse to file. `signWaiverDigital` would RENDER a
     * substitute mark from the name, and a generated signature on a legal record
     * is worse than an absent one. Report it every run so it stays visible.
     */
    if (!r.has_image) {
      counts.noImage++;
      push("skipped-no-image", "no stored signature image — will not file a generated mark");
      continue;
    }

    // A parked row that merely ran out of patience (the outage case) gets re-armed.
    if (queueStatus === "parked") {
      counts.rearmed++;
      push("re-armed", queueError ?? undefined);
      if (!dryRun) {
        await q`
          UPDATE bmi_sync_queue
          SET status = 'pending', attempts = 0, next_attempt_at = now(),
              give_up_at = now() + INTERVAL '12 hours', resolved_at = NULL,
              push_transport = NULL, updated_at = now(),
              last_error = 're-armed by waiver-redrive (was parked, barrier may have opened)'
          WHERE id = ${Number(r.queue_id)}
        `;
      }
      continue;
    }

    // Nothing driving it at all — the stranded case. Give it a durable row.
    counts.armed++;
    push("armed", `age=${r.age_min}m outcome=${r.outcome ?? "null"}`);
    if (dryRun) continue;

    const payload = {
      personId,
      /** Handler guard only. `signWaiverDigital` uses `name` solely to RENDER a
       *  substitute mark, and every row here has its real PNG, so it is never
       *  transmitted — rows without an image were skipped above. */
      name: label,
      signerPersonId: signerId,
      signaturePngB64: null as string | null,
      waiverContentId: String(r.waiver_content_id),
      invalidationDate: r.invalidation_date ? String(r.invalidation_date) : null,
      signatureRowId: sigId,
      /** The persons-local barrier needs BOTH the subject and the signer: Pandora's
       *  write names the minor and the signing adult, so both must resolve locally. */
      personIds: [...new Set([personId, signerId])],
    };

    /**
     * The PNG is copied INSIDE the database rather than round-tripped through this
     * function. A signature is 8-60 KB of base64 and an outage backlog is dozens of
     * rows; pulling them all into a 60-second serverless function to immediately
     * write them back is a needless megabyte and a needless timeout risk.
     */
    await q`
      INSERT INTO bmi_sync_queue
        (kind, idempotency_key, barrier, barrier_ref, location_id, payload,
         next_attempt_at, give_up_at, status, last_error)
      SELECT
        'push-waiver-signature',
        ${`waiver-redrive-sig-${sigId}`},
        'persons-local',
        ${personId},
        ${String(r.location_id)},
        ${JSON.stringify(payload)}::jsonb || jsonb_build_object('signaturePngB64', s.signature_png),
        now(),
        now() + INTERVAL '12 hours',
        'pending',
        'armed by waiver-redrive — the push transport dropped this signature'
      FROM waiver_signatures s
      WHERE s.id = ${sigId} AND s.signature_png IS NOT NULL
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[waiver-redrive] dryRun=${dryRun} owed=${counts.owed} armed=${counts.armed} ` +
      `rearmed=${counts.rearmed} alreadyDriven=${counts.alreadyDriven} ` +
      `impossible=${counts.impossible} noImage=${counts.noImage} elapsedMs=${elapsedMs}`,
  );
  /**
   * SHOUT when a signature cannot be driven. A silent give-up reads exactly like
   * success in a log — the lesson that cost us the swallowed $2,113.95 and, here,
   * 69 stranded waivers nobody saw for a day.
   */
  if (counts.noImage > 0 || counts.impossible > 0) {
    console.error(
      `[waiver-redrive] NEEDS A HUMAN: ${counts.noImage} signature(s) with no stored image, ` +
        `${counts.impossible} that can never file. ` +
        outcomes
          .filter((o) => o.action !== "armed" && o.action !== "re-armed")
          .slice(0, 10)
          .map((o) => `sig#${o.signatureRowId} ${o.personId} ${o.action}`)
          .join(" | "),
    );
  }

  return NextResponse.json({ ok: true, dryRun, elapsedMs, ...counts, outcomes });
}
