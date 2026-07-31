import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { clientKeyForLocation } from "~/features/daily-events/service";
import {
  listAttachBackfillCandidates,
  setJoinAttachStatus,
  type KioskWaiverJoinRow,
} from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import { billIdFromOfficeProjectId } from "@/lib/bmi-office-actions";
import { rosterCacheKey } from "~/features/kiosk/waiver/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/admin/waiver-attach-backfill?token=…&dryRun=1&limit=25&attachedBefore=…
 *
 * One-time remediation for the poisoned kiosk_waiver_joins rows: the pre-fix
 * attach (before 2026-07-30, commits 3fc3fdf1/717b117b) sent BMI the PROJECT id
 * where the endpoint wants a BILL id, and recorded the resulting
 * 200 {"success":false} as 'attached' — so those rows claim an attach that BMI
 * never received, and both the join route's alreadyAttached shortcut and
 * check-in's re-attach guard trust them forever. This route re-runs the attach
 * (with the corrected projectId→billId conversion) for:
 *   - every 'failed' row, and
 *   - every 'attached' row last touched before `attachedBefore`
 *     (default 2026-07-30T00:00:00Z — pass the actual fix DEPLOY time for a
 *     tighter sweep; a too-early cutoff misses poisoned rows, which a re-run
 *     with a later cutoff picks up, while a too-late one re-attaches genuinely
 *     attached people, whose BMI-side behavior is unverified).
 *
 * dryRun defaults ON — it reports exactly which rows would be re-attached and
 * mutates nothing. Run dark first, read the list, then re-run with dryRun=0.
 * Manual/admin-triggered on purpose: this touches BMI Office per row, and the
 * owner should watch the first live run (the A3 attach probe history).
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";
const DEFAULT_ATTACHED_BEFORE = "2026-07-30T00:00:00Z";
const MAX_LIMIT = 100;

interface RowOutcome {
  projectId: string;
  personId: string;
  displayName: string;
  priorStatus: string;
  outcome: "would-reattach" | "attached" | "failed" | "skipped-no-billid" | "skipped-no-clientkey";
  detail?: string;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (!ADMIN_TOKEN || sp.get("token") !== ADMIN_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const dryRun = sp.get("dryRun") !== "0"; // mutating is the explicit opt-in
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit") ?? "25") || 25));
  const attachedBefore = sp.get("attachedBefore") ?? DEFAULT_ATTACHED_BEFORE;
  if (Number.isNaN(Date.parse(attachedBefore))) {
    return NextResponse.json({ ok: false, error: "attachedBefore must be ISO" }, { status: 400 });
  }

  let candidates: KioskWaiverJoinRow[];
  try {
    candidates = await listAttachBackfillCandidates({ attachedBefore, limit });
  } catch (err) {
    console.error("[waiver-attach-backfill] candidate query failed:", err);
    return NextResponse.json({ ok: false, error: "query failed" }, { status: 500 });
  }

  const outcomes: RowOutcome[] = [];
  const touchedProjects = new Set<string>();

  for (const row of candidates) {
    const base = {
      projectId: row.projectId,
      personId: row.personId,
      displayName: row.displayName,
      priorStatus: row.bmiAttachStatus,
    };
    const clientKey = clientKeyForLocation(row.locationId);
    if (!clientKey) {
      outcomes.push({ ...base, outcome: "skipped-no-clientkey" });
      continue;
    }
    const orderId = billIdFromOfficeProjectId(row.projectId);
    if (!orderId) {
      outcomes.push({ ...base, outcome: "skipped-no-billid" });
      continue;
    }
    if (dryRun) {
      outcomes.push({ ...base, outcome: "would-reattach" });
      continue;
    }
    try {
      const result = await registerProjectPersonServer({
        clientKey,
        orderId,
        personId: row.personId,
        // Old rows may predate the first/last name columns — the display name's
        // leading token is the best available fallback for BMI's required field.
        firstName: row.firstName ?? row.displayName.split(" ")[0] ?? "Guest",
        lastName: row.lastName ?? "",
      });
      if (result.ok) {
        await setJoinAttachStatus(row.projectId, row.personId, "attached").catch(() => {});
        touchedProjects.add(row.projectId);
        outcomes.push({ ...base, outcome: "attached" });
      } else {
        const detail = `${result.status}: ${result.body.slice(0, 300)}`;
        await setJoinAttachStatus(row.projectId, row.personId, "failed", detail).catch(() => {});
        outcomes.push({ ...base, outcome: "failed", detail });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "attach error";
      await setJoinAttachStatus(row.projectId, row.personId, "failed", detail).catch(() => {});
      outcomes.push({ ...base, outcome: "failed", detail });
    }
  }

  // Bust roster caches for every project whose attach state changed.
  for (const pid of touchedProjects) {
    redis.del(rosterCacheKey(pid)).catch(() => {});
  }

  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    dryRun,
    attachedBefore,
    candidates: candidates.length,
    counts,
    outcomes,
  });
}
