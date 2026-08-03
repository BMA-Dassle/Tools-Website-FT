import { NextRequest, NextResponse } from "next/server";
import {
  listRetryable,
  listParked,
  recordRetryAttempt,
  computePostableCents,
  MAX_RETRY_ATTEMPTS,
  type ProjectPaymentFailureRow,
} from "@/lib/bmi-project-payment-retry";
import { verifyCron } from "@/lib/cron-auth";
import { sql, isDbConfigured } from "@/lib/db";

/**
 * BMI project-payment retry sweep — drains `bmi_project_payment_failures`.
 *
 * Background: `confirmAndRecordBmiPayment` is non-fatal by design (the card is
 * already charged when it runs), so a BMI failure used to be a `console.error`
 * and nothing else. The 2026-08-03 Office-auth outage dropped two events'
 * payments that way. Failures now land in a table and this cron posts them once
 * BMI is healthy.
 *
 *   GET /api/cron/bmi-payment-retry-sweep
 *       &dryRun=1   — scan + report what WOULD be posted, no BMI writes
 *       &limit=N    — cap rows this run (default 25)
 *
 * ── The safety property ────────────────────────────────────────────
 * This never blind-retries. A failed POST is not proof the write didn't land —
 * a timeout can follow a payment BMI actually recorded, and a blind retry would
 * double-post real money into a center's books. So for each row we re-read the
 * project's live ledger and post only:
 *
 *     min(ourCollected - bmiRecorded, bmiBalance, row.amountCents)
 *
 * If that is <= 0 the row resolves as `already-square` with no write. Capping by
 * the row's own amount is what lets two queued failures on one event (deposit +
 * balance) settle independently and correctly.
 */

const DEFAULT_LIMIT = 25;

interface Attempt {
  ok: boolean;
  resolution?: "recorded" | "already-square";
  reference?: string;
  postedCents?: number;
  error?: string;
}

async function settleRow(row: ProjectPaymentFailureRow, dryRun: boolean): Promise<Attempt> {
  const { fetchProject, recordProjectPayment, appendProjectPrivateNote, noteTimestamp } =
    await import("@/lib/bmi-office-actions");

  let project: Record<string, unknown> | null = null;
  try {
    project = (await fetchProject(row.centerCode, row.projectId)) as Record<string, unknown> | null;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "fetch failed" };
  }
  if (!project) return { ok: false, error: "project fetch returned null" };

  const payments = ((project.payments as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (p) => !p.voidedDate,
  );
  const recordedCents = Math.round(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100);
  const balanceCents = Math.round(Number(project.balance ?? 0) * 100);

  // Our side's truth. Prefer the quote's collected_cents — it is what we actually
  // took from the card. Fall back to the queued amount when the row has no quote.
  let collectedCents: number | null = null;
  if (row.quoteId !== null && isDbConfigured()) {
    const q = sql();
    const found = (await q`
      SELECT collected_cents FROM group_function_quotes WHERE id = ${row.quoteId}
    `) as Array<{ collected_cents: number }>;
    if (found[0]) collectedCents = Number(found[0].collected_cents) || 0;
  }
  const postCents = computePostableCents({
    collectedCents,
    recordedCents,
    balanceCents,
    amountCents: row.amountCents,
  });

  if (postCents <= 0) {
    console.log(
      `[bmi-payment-retry-sweep] #${row.id} project=${row.projectId} already square ` +
        `(collected=${collectedCents} bmiRecorded=${recordedCents} bal=${balanceCents}) — resolving without a write`,
    );
    return { ok: true, resolution: "already-square", postedCents: 0 };
  }

  if (dryRun) {
    console.log(
      `[bmi-payment-retry-sweep] DRY RUN #${row.id} project=${row.projectId} would post ${(postCents / 100).toFixed(2)}`,
    );
    return { ok: false, error: "dryRun" };
  }

  try {
    const { paymentReference } = await recordProjectPayment({
      centerCode: row.centerCode,
      projectId: row.projectId,
      amountDollars: postCents / 100,
    });
    // Explain the date discrepancy for whoever reads the project later — the
    // payment date is today, the charge happened when the row was created.
    await appendProjectPrivateNote({
      centerCode: row.centerCode,
      projectId: row.projectId,
      note:
        `[${noteTimestamp()}] Recorded $${(postCents / 100).toFixed(2)} collected ${row.createdAt} — ` +
        `card was charged then, but BMI could not be updated at the time (${row.lastError ?? "upstream error"}). ` +
        `Backfilled by the payment retry sweep; the payment date above is the backfill date, not the charge date.`,
    }).catch(() => {
      /* note is best-effort — the payment is what matters */
    });
    console.log(
      `[bmi-payment-retry-sweep] #${row.id} posted ${(postCents / 100).toFixed(2)} to project ${row.projectId}`,
    );
    return {
      ok: true,
      resolution: "recorded",
      reference: paymentReference,
      postedCents: postCents,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "post failed" };
  }
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.max(
    1,
    Math.min(
      200,
      parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
    ),
  );

  const rows = await listRetryable(limit);
  // Parked rows are reported on EVERY run, including the idle one — a row that
  // gave up is money the center's books are still missing, and a silent quiet
  // path would make "gave up" look exactly like "all clear".
  const parked = await listParked();
  const parkedReport = () => {
    if (parked.length === 0) return;
    console.warn(
      `[bmi-payment-retry-sweep] ${parked.length} row(s) PARKED after ${MAX_RETRY_ATTEMPTS} attempts — need a human: ` +
        parked
          .map(
            (p) =>
              `#${p.id} quote=${p.quoteId ?? "?"} project=${p.projectId} $${(p.amountCents / 100).toFixed(2)} (${p.lastError ?? "?"})`,
          )
          .join("; "),
    );
  };

  if (rows.length === 0) {
    parkedReport();
    return NextResponse.json({
      ok: true,
      scanned: 0,
      attempted: 0,
      recorded: 0,
      alreadySquare: 0,
      failed: 0,
      postedCents: 0,
      parked: parked.length,
      parkedRows: parked.map((p) => ({
        id: p.id,
        quoteId: p.quoteId,
        projectId: p.projectId,
        amountCents: p.amountCents,
        attempts: p.attempts,
        lastError: p.lastError,
      })),
      dryRun,
    });
  }

  let attempted = 0;
  let recorded = 0;
  let alreadySquare = 0;
  let failed = 0;
  let postedCents = 0;
  const failures: { id: number; projectId: string; reason: string }[] = [];

  for (const row of rows) {
    attempted++;
    const r = await settleRow(row, dryRun);
    if (dryRun) continue;
    if (r.ok) {
      if (r.resolution === "already-square") alreadySquare++;
      else {
        recorded++;
        postedCents += r.postedCents ?? 0;
      }
      await recordRetryAttempt({
        id: row.id,
        success: true,
        resolvedReference: r.reference,
        resolution: r.resolution,
      });
    } else {
      failed++;
      failures.push({ id: row.id, projectId: row.projectId, reason: r.error ?? "unknown" });
      await recordRetryAttempt({ id: row.id, success: false, error: r.error });
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[bmi-payment-retry-sweep] scanned=${rows.length} attempted=${attempted} recorded=${recorded} ` +
      `alreadySquare=${alreadySquare} failed=${failed} posted=$${(postedCents / 100).toFixed(2)} ` +
      `parked=${parked.length} elapsed=${elapsedMs}ms dryRun=${dryRun}`,
  );
  parkedReport();

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    attempted,
    recorded,
    alreadySquare,
    failed,
    postedCents,
    failures: failures.slice(0, 20),
    parked: parked.length,
    elapsedMs,
    dryRun,
  });
}
