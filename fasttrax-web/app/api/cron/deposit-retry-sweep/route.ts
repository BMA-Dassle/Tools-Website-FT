import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";
import {
  listUnresolved,
  recordRetryAttempt,
  type DepositFailureRow,
} from "@/lib/bmi-deposit-retry";

/**
 * BMI deposit retry sweep — drains the `bmi_deposit_failures` table.
 *
 * Background: when our app calls `POST /bmi/deposit` (race pack
 * sales adding credit, POV voucher claims removing credit) and
 * upstream fails, the caller writes a row to
 * `bmi_deposit_failures` then returns to the customer. This cron
 * runs every 5 min, picks the next batch of unresolved rows, and
 * retries the upstream call. Successes mark the row resolved;
 * failures bump `attempts` + record `last_error`.
 *
 * Replaces the original Redis-driven `pov-deposit-sweep` — same
 * job, broader scope (now covers race-pack add failures too), and
 * persistent across Redis evictions.
 *
 *   GET /api/cron/deposit-retry-sweep
 *       &dryRun=1       — scan + report, no Pandora calls
 *       &limit=N        — cap retries this run (default 50)
 *
 * Bounded by `limit` so a sustained BMA outage can't burn the cron's
 * 60s budget. Remaining rows roll into the next 5-min sweep.
 */

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const SITE_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const PANDORA_INTERNAL_KEY = process.env.SWAGGER_ADMIN_KEY || "";

const DEFAULT_LIMIT = 50;

interface DepositResult {
  ok: boolean;
  depositId?: string;
  status?: number;
  error?: string;
}

/** Re-attempt a deposit through our /api/pandora/deposit proxy. The
 *  proxy enforces the trust gate, so we forward the internal-secret
 *  header. */
async function retryDeposit(row: DepositFailureRow): Promise<DepositResult> {
  if (!PANDORA_INTERNAL_KEY) {
    return { ok: false, error: "SWAGGER_ADMIN_KEY not set" };
  }
  try {
    const res = await fetch(`${SITE_BASE}/api/pandora/deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pandora-internal": PANDORA_INTERNAL_KEY,
        "x-pandora-caller": "deposit-retry-sweep",
      },
      body: JSON.stringify({
        locationId: row.locationId,
        personId: row.personId,
        depositKindId: row.depositKindId,
        amount: row.amount,
      }),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : `HTTP ${res.status}`,
      };
    }
    // Successful proxy response shape: { success: true, data: { depositID } | passthrough }
    let depositId: string | undefined;
    if (typeof parsed === "object" && parsed && "data" in parsed) {
      const d = (parsed as Record<string, unknown>).data;
      if (typeof d === "object" && d && "depositID" in d) {
        depositId = String((d as Record<string, unknown>).depositID);
      } else if (typeof d === "object" && d && "data" in d) {
        const inner = (d as Record<string, unknown>).data;
        if (typeof inner === "object" && inner && "depositID" in inner) {
          depositId = String((inner as Record<string, unknown>).depositID);
        }
      }
    }
    return { ok: true, depositId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** Best-effort: when a POV-claim retry resolves, flip the
 *  `depositDeducted` flag on the matching Redis claim record so the
 *  customer-facing status (admin board / future "your codes" page)
 *  reflects the real BMI state. Not critical — failures are silent. */
async function flipPovClaimRedisFlag(personId: string): Promise<void> {
  if (!REDIS_URL) return;
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const key = `pov:claimed:person:${personId}`;
    const raw = await redis.get(key);
    if (!raw) return;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (rec.depositDeducted === true) return; // already flipped
    rec.depositDeducted = true;
    const ttl = await redis.ttl(key);
    const useTtl = ttl > 0 ? ttl : 90 * 24 * 60 * 60;
    await redis.set(key, JSON.stringify(rec), "EX", useTtl);
  } catch {
    /* silent */
  } finally {
    redis.disconnect();
  }
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.max(
    1,
    Math.min(500, parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  const rows = await listUnresolved(limit);
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, attempted: 0, succeeded: 0, failed: 0, dryRun });
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const failures: { id: number; source: string; reason: string }[] = [];

  for (const row of rows) {
    if (dryRun) continue;
    attempted++;
    const r = await retryDeposit(row);
    if (r.ok) {
      succeeded++;
      await recordRetryAttempt({
        id: row.id,
        success: true,
        resolvedDepositId: r.depositId,
      });
      // POV-claim source: also nudge Redis so customer status is
      // consistent. Race-pack source: sales_log already has the
      // pending flag; we leave it for the admin board to mark
      // "reconciled" out-of-band (or update sales_log row by
      // bill_id — TODO once admin reconcile is wired).
      if (row.source === "pov-claim") {
        await flipPovClaimRedisFlag(row.personId);
      }
    } else {
      failed++;
      failures.push({ id: row.id, source: row.source, reason: r.error ?? "unknown" });
      await recordRetryAttempt({
        id: row.id,
        success: false,
        error: r.error,
      });
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(
    `[deposit-retry-sweep] scanned=${rows.length} attempted=${attempted} succeeded=${succeeded} failed=${failed} elapsed=${elapsedMs}ms dryRun=${dryRun}`,
  );

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    attempted,
    succeeded,
    failed,
    failures: failures.slice(0, 20),
    elapsedMs,
    dryRun,
  });
}
