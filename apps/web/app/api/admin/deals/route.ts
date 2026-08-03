import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DEAL_CATALOG,
  getDeal,
  getDealPurchase,
  listDealPurchases,
  markDealPurchaseRefunded,
} from "~/features/deals";
import { fulfilDealPurchase } from "~/features/deals/service/purchase";
import { voidNativeVoucher } from "~/features/game-cards/service/native-voucher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Admin: prepaid deal-pack purchases.
 *
 * Auth is `ADMIN_CAMERA_TOKEN` in the request body / query, matching the sibling
 * admin voucher route — not a header, because the existing admin clients post it
 * that way.
 *
 *   GET  ?token=…[&deal=slug]      → purchases, newest first, + per-deal totals
 *   POST { action: "resend" }      → re-run mint/email for a paid purchase
 *   POST { action: "void" }        → void this purchase's unspent vouchers
 *                                    (spent items stay spent) and mark refunded
 *
 * "resend" is the same idempotent fulfilment the reconcile cron calls, so it is
 * safe to hit repeatedly: an already-minted purchase re-sends the email without
 * cutting new codes.
 */

function authed(token: string | null | undefined): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
}

export async function GET(req: NextRequest) {
  if (!authed(req.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const deal = req.nextUrl.searchParams.get("deal") ?? undefined;
  const rows = await listDealPurchases({ dealSlug: deal, limit: 300 });

  // Per-deal rollup for the board header. Refunded rows are excluded from
  // revenue but still counted as sold, so a refund never silently disappears.
  const totals = DEAL_CATALOG.map((d) => {
    const mine = rows.filter((r) => r.dealSlug === d.slug);
    const paid = mine.filter((r) => r.status !== "pending" && r.status !== "charge_failed");
    const live = paid.filter((r) => !r.refundedAt);
    return {
      slug: d.slug,
      name: d.name,
      packsSold: live.reduce((n, r) => n + r.qty, 0),
      grossCents: live.reduce((n, r) => n + r.totalCents, 0),
      refunded: paid.length - live.length,
      unfulfilled: live.filter((r) => r.status === "charged" || r.status === "minted").length,
    };
  });

  return NextResponse.json({ ok: true, purchases: rows, totals });
}

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resend"), token: z.string(), purchaseId: z.number().int() }),
  z.object({
    action: z.literal("void"),
    token: z.string(),
    purchaseId: z.number().int(),
    reason: z.string().min(3).max(300),
  }),
]);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!authed(parsed.data.token)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const row = await getDealPurchase(parsed.data.purchaseId);
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  if (parsed.data.action === "resend") {
    if (row.status === "pending" || row.status === "charge_failed") {
      return NextResponse.json(
        { ok: false, error: "That purchase was never charged — nothing to send." },
        { status: 409 },
      );
    }
    const res = await fulfilDealPurchase(row);
    return NextResponse.json({ ok: true, ...res });
  }

  // void: kill the unspent value and record why. Spent items stay spent — the
  // guest already had that value, and rewriting history would desync Intercard.
  const deal = getDeal(row.dealSlug);
  for (const code of row.codes) {
    await voidNativeVoucher(code, `admin void: ${parsed.data.reason}`).catch((err: unknown) =>
      console.error(`[admin/deals] could not void ${code}:`, err),
    );
  }
  await markDealPurchaseRefunded(row.id, parsed.data.reason);
  return NextResponse.json({
    ok: true,
    voided: row.codes.length,
    // The MONEY is not touched here. Square refunds must be itemised through a
    // return order (never amount-only), so that stays a deliberate separate act
    // in Square rather than something this button does as a side effect.
    note: `Vouchers voided for ${deal?.name ?? row.dealSlug}. Refund the card in Square separately — itemised, not amount-only.`,
  });
}
