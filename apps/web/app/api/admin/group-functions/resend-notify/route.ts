import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import { notifyDepositPaid, notifyContractSent } from "@/lib/group-function-notify";

/**
 * POST /api/admin/group-functions/resend-notify
 *
 * Resend a notification email for a group function quote.
 * Body: { shortId, type: "deposit_paid" | "contract_sent", token }
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { shortId, type, token } = body as {
    shortId: string;
    type: "deposit_paid" | "contract_sent";
    token: string;
  };

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!shortId || !type) {
    return NextResponse.json({ error: "shortId and type required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  try {
    if (type === "deposit_paid") {
      await notifyDepositPaid(quote);
    } else if (type === "contract_sent") {
      await notifyContractSent(quote);
    }
    console.log(`[admin/resend-notify] sent ${type} for shortId=${shortId}`);
    return NextResponse.json({ ok: true, type, shortId });
  } catch (err) {
    console.error(`[admin/resend-notify] error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send" },
      { status: 500 },
    );
  }
}
