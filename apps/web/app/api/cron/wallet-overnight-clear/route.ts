import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { clearStaleLicenceFieldsOvernight } from "~/features/racing/wallet/licence-clear";

/**
 * 3am ET failsafe — wipe any live field still sitting on a racing licence.
 *
 * The per-minute clear-down inside `checkin-alerts` is evidence-based: it clears
 * a field only once BMI records the heat starting or ending. That is right while
 * the centre is open, but every one of its failure modes is a "clear nothing"
 * failure — Pandora unreachable, a session on a day it did not query, a heat
 * that never got an `actualEnd` because it was cancelled or abandoned. Each is
 * correct in the moment and leaves the field set indefinitely.
 *
 * This is the backstop (owner, 2026-08-06: "if for some reason races are still
 * left in the morning, clear them — need a failback, maybe 3am"). By 3am nothing
 * on a pass can still be true, so it clears without consulting the schedule at
 * all.
 *
 * SCHEDULED `0 7,8 * * *` — Vercel crons are UTC and ET is not. 07:00Z is 3am
 * EDT; 08:00Z is 3am EST. Both fire year-round and the handler itself refuses
 * any ET hour outside 2-5am, so exactly one of the two does the work whichever
 * side of the DST change we are on. Belt and braces on purpose: the failure this
 * must never have is wiping "Check in now" off a pass while its racer is at the
 * desk, so the time check lives in the code and not only in the schedule.
 *
 *   ?dryRun=1 — report what WOULD be cleared without writing (still honours the
 *               window, so it tells you the truth about when it can act)
 */
export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  if (dryRun) {
    const { getPassesWithLiveFields } = await import("~/features/racing/data/racer-wallet-db");
    const { etHour } = await import("~/features/racing/wallet/licence-clear");
    const rows = await getPassesWithLiveFields();
    const hour = etHour();
    return NextResponse.json(
      {
        ok: true,
        dryRun: true,
        etHour: hour,
        wouldRun: hour >= 2 && hour <= 5,
        live: rows.length,
        rows: rows.map((r) => ({
          personId: r.personId,
          checkinStatus: r.checkinStatus,
          nextRace: r.nextRace,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await clearStaleLicenceFieldsOvernight();
  if (result.checkinCleared || result.nextRaceCleared) {
    console.log(
      `[wallet-overnight-clear] cleared ${result.checkinCleared} check-in, ` +
        `${result.nextRaceCleared} next-race (of ${result.checked} live)`,
    );
  }
  return NextResponse.json(
    { ok: true, elapsedMs: Date.now() - started, ...result },
    { headers: { "Cache-Control": "no-store" } },
  );
}
