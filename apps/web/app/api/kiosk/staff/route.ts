import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { kioskStaffOk } from "~/features/kiosk/admin-auth";
import { buildGrid, findGridGaps } from "~/features/lane-plan/grid.server";
import {
  flattenLaneGrid,
  type StaffLaneBoard,
  type StaffLaneCenter,
} from "~/features/kiosk/staff/lanes";
import {
  FASTTRAX_QAMF_CENTER_ID,
  HEADPINZ_FM_CENTER_ID,
  HEADPINZ_NAPLES_CENTER_ID,
} from "@/lib/qamf-centers";
import { isValidLocationCode } from "~/config/intercard-centers";
import { clearAccount, verifyAccount } from "~/features/game-cards/data/intercard-router";
import { probeOnsite } from "~/features/game-cards/data/intercard-onsite";
import { listKioskLoads } from "~/features/game-cards/data/transactions-log";
import { logStaffClear } from "~/features/game-cards/data/staff-actions-log";

/**
 * Kiosk STAFF API — the floor tools behind /kiosk/staff. PIN-gated by
 * `kioskStaffOk` (staff PIN or the admin PIN, via x-kiosk-pin) — a narrower
 * tier than /api/kiosk/admin, which stays admin-PIN-only.
 *
 * GET  ?action=ping                        → 200 {} (the client PIN check)
 *      ?action=lanes&center=&brand=        → bowling + duckpin lane boards
 *      ?action=loads&kioskId=&locationCode=&centerWide=&sinceHours=
 *                                          → this kiosk's card-load ledger rows
 *      ?action=card&account=&locationCode= → live balance + Intercard history
 * POST { action:"clear-card", accountNumber, confirmAccount, locationCode,
 *        kioskId?, override? }             → TPI_ClearAccount, money-safe
 *
 * The lane window is now-15min → now+3h: current occupancy plus what lands
 * next. buildGrid already widens its search read internally so a session that
 * started before the window is not missed.
 */

const LANE_WINDOW_BACK_MS = 15 * 60_000;
const LANE_WINDOW_FORWARD_MS = 3 * 60 * 60_000;

/** Which QAMF houses a kiosk's venue covers. FastTrax and HeadPinz Fort Myers
 *  share one complex, so any FM kiosk shows both; Naples has one house. */
function laneCentersFor(center: string): StaffLaneCenter[] {
  if (center === "naples") {
    return [{ centerId: HEADPINZ_NAPLES_CENTER_ID, label: "HeadPinz Naples" }];
  }
  return [
    { centerId: HEADPINZ_FM_CENTER_ID, label: "HeadPinz bowling" },
    { centerId: FASTTRAX_QAMF_CENTER_ID, label: "FastTrax duckpin" },
  ];
}

export async function GET(req: NextRequest) {
  if (!kioskStaffOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    if (action === "ping") {
      // Cheap authed GET — verifyKioskStaffPin's target. Reaching here IS the answer.
      return NextResponse.json({ ok: true });
    }

    if (action === "lanes") {
      const center = searchParams.get("center") || "fort-myers";
      const now = Date.now();
      // Per-house isolation: buildGrid fails loudly (a silently partial grid
      // would read as free lanes), so one house's vendor error becomes an error
      // BOARD while the other still renders.
      const boards = await Promise.all(
        laneCentersFor(center).map(
          async (
            c,
          ): Promise<StaffLaneBoard | { centerId: number; label: string; error: string }> => {
            try {
              const grid = await buildGrid(
                c.centerId,
                now - LANE_WINDOW_BACK_MS,
                now + LANE_WINDOW_FORWARD_MS,
              );
              return {
                centerId: c.centerId,
                label: c.label,
                readAtMs: grid.readAtMs,
                lanes: flattenLaneGrid(grid, now),
                gaps: findGridGaps(grid, now),
              };
            } catch (err) {
              return {
                centerId: c.centerId,
                label: c.label,
                error: err instanceof Error ? err.message : "lane read failed",
              };
            }
          },
        ),
      );
      return NextResponse.json({ boards, atMs: now });
    }

    if (action === "loads") {
      const kioskId = searchParams.get("kioskId") || "";
      const locationCode = Number(searchParams.get("locationCode"));
      if (!kioskId || !isValidLocationCode(locationCode)) {
        return NextResponse.json({ error: "kioskId + locationCode required" }, { status: 400 });
      }
      const sinceHours = Math.min(Math.max(Number(searchParams.get("sinceHours")) || 24, 1), 168);
      const rows = await listKioskLoads({
        kioskId,
        locationCode,
        centerWide: searchParams.get("centerWide") === "1",
        sinceMs: Date.now() - sinceHours * 60 * 60_000,
        limit: 100,
      });
      return NextResponse.json({ rows });
    }

    if (action === "card") {
      const account = (searchParams.get("account") || "").trim();
      const locationCode = Number(searchParams.get("locationCode"));
      if (!/^\d{3,20}$/.test(account) || !isValidLocationCode(locationCode)) {
        return NextResponse.json({ error: "account + locationCode required" }, { status: 400 });
      }
      // verifyAccount carries balance AND history on either transport (the
      // router fetches the onsite history half in parallel; cloud returns both
      // from one op). probeOnsite feeds the onsite/cloud chip only, so its
      // failure degrades to "error" rather than sinking the lookup.
      const [verify, onsite] = await Promise.all([
        verifyAccount(account, locationCode),
        probeOnsite(locationCode).catch(() => ({ status: "error" as const })),
      ]);
      return NextResponse.json({
        verify,
        // null = the history read FAILED (say so); [] = genuinely no activity.
        transactions: verify.transactions ?? null,
        historyTransport: verify.transport,
        onsiteStatus: onsite.status,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Staff API error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!kioskStaffOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    if (action === "clear-card") {
      // De-registers the account in Intercard — the guest's value is GONE.
      // Money-safe sequence, all server-side (the client's checks are UX only):
      //  1. re-read the live balance;
      //  2. refuse a card holding value unless `override` is explicit;
      //  3. require the typed account to match (staff typed it, not tapped it);
      //  4. ONE call, never retried — an ambiguous outcome is logged 'unknown'
      //     and staff re-read the account instead (the call has no transaction
      //     id upstream, so a blind retry could clear a card re-sold in between).
      // Every attempt — refusals included — writes an audit row.
      const accountNumber = String(body.accountNumber || "").trim();
      const confirmAccount = String(body.confirmAccount || "").trim();
      const locationCode = Number(body.locationCode);
      const kioskId = typeof body.kioskId === "string" ? body.kioskId.slice(0, 120) : null;
      const override = body.override === true;
      if (!/^\d{3,20}$/.test(accountNumber) || !isValidLocationCode(locationCode)) {
        return NextResponse.json(
          { error: "accountNumber + locationCode required" },
          { status: 400 },
        );
      }
      const attemptId = `staffclear-${randomUUID()}`;

      const refuse = async (reason: string, pre: { t: number | null; b: number | null }) => {
        await logStaffClear({
          id: attemptId,
          locationCode,
          accountNumber,
          kioskId,
          preTokens: pre.t,
          preBonusTokens: pre.b,
          outcome: "refused",
          detail: reason,
        });
        return NextResponse.json({ error: reason, refused: true }, { status: 409 });
      };

      if (confirmAccount !== accountNumber) {
        return refuse("Confirmation number does not match the account.", { t: null, b: null });
      }

      let pre: { t: number | null; b: number | null } = { t: null, b: null };
      try {
        const v = await verifyAccount(accountNumber, locationCode);
        if (!v.exists && v.notFound === "confirmed") {
          return refuse("Account does not exist — nothing to clear.", pre);
        }
        pre = { t: v.balance?.tokens ?? null, b: v.balance?.bonusTokens ?? null };
        const holdsValue =
          (v.balance?.tokens ?? 0) > 0 ||
          (v.balance?.bonusTokens ?? 0) > 0 ||
          (v.balance?.eTickets ?? 0) > 0 ||
          (v.balance?.timeMinutes ?? 0) > 0 ||
          (v.cashBalance ?? 0) > 0;
        if (holdsValue && !override) {
          return refuse(
            "Card still holds value — clearing would destroy it. Read the balance to the guest first; override only if a manager approves.",
            pre,
          );
        }
      } catch {
        // Balance unreadable → we cannot prove the card is empty. Fail closed
        // (even with override: an override attests "the value shown is OK to
        // destroy", and nothing was shown).
        return refuse("Could not read the card's balance — not clearing blind.", pre);
      }

      try {
        const res = await clearAccount({
          locationCode,
          accountNumbers: [accountNumber],
          tpiTransactionID: attemptId,
        });
        const ok = res.code === 0;
        await logStaffClear({
          id: attemptId,
          locationCode,
          accountNumber,
          kioskId,
          preTokens: pre.t,
          preBonusTokens: pre.b,
          outcome: ok ? "cleared" : "failed",
          detail: `code ${res.code} via ${res.transport}`,
        });
        if (!ok) {
          return NextResponse.json(
            { error: `Intercard refused the clear (code ${res.code}).` },
            { status: 502 },
          );
        }
        return NextResponse.json({ ok: true, transport: res.transport });
      } catch (err) {
        // NEVER retried — log 'unknown' and tell staff to re-read the account.
        await logStaffClear({
          id: attemptId,
          locationCode,
          accountNumber,
          kioskId,
          preTokens: pre.t,
          preBonusTokens: pre.b,
          outcome: "unknown",
          detail: err instanceof Error ? err.message : "clear call errored",
        });
        return NextResponse.json(
          {
            error:
              "The clear call did not come back — it may or may not have applied. Look the card up again before doing anything else.",
          },
          { status: 502 },
        );
      }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Staff API error" },
      { status: 500 },
    );
  }
}
