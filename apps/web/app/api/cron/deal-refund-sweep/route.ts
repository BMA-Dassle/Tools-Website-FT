import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { sq } from "~/features/cancellation/square-actions";
import { giftCardBalanceCents } from "~/features/deals/service/refund-square";
import { sweepDealRefunds } from "~/features/deals/service/refund-sweep";

/**
 * GET /api/cron/deal-refund-sweep
 *
 * Drives stalled deal-refund attempts to a terminal state.
 *
 * The state this exists for is `crediting`: a gift-card refund whose credit posts
 * in Square's batch a minute or two later. Without a sweep it parks forever and
 * the board keeps showing an unfinished refund whose money has actually landed.
 *
 * IT NEVER RE-ISSUES MONEY. It re-reads Square and records what it finds — a
 * sweep that decided to "retry the refund" would be the one component in this
 * feature capable of paying twice. An attempt it cannot resolve is parked and
 * reported for a human, never guessed at.
 *
 * The response always carries the full outcome list, including on a run that
 * resolved nothing: a sweep that goes quiet when it gives up is indistinguishable
 * from a sweep with nothing to do.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  try {
    const result = await sweepDealRefunds({
      deps: {
        giftCardBalanceCents,
        refundStatus: async (refundId) => {
          const res = await sq("GET", `/refunds/${refundId}`);
          if (!res.ok || !res.json?.refund) return null;
          return {
            status: String(res.json.refund.status ?? "UNKNOWN"),
            amountCents: Number(res.json.refund.amount_money?.amount ?? 0),
          };
        },
      },
    });

    // Log the ones a human has to look at, so they exist somewhere other than an
    // HTTP response nobody reads.
    for (const o of result.outcomes.filter((x) => x.action === "needs_human")) {
      console.error(`[deal-refund-sweep] refund ${o.refundId} needs a human: ${o.detail}`);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[deal-refund-sweep] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep failed" },
      { status: 500 },
    );
  }
}
