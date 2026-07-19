import { NextRequest, NextResponse } from "next/server";
import {
  prepareStandalonePackPurchase,
  finalizeStandalonePackPurchase,
  RacePackHttpError,
  type StandalonePackInput,
} from "~/features/booking/service/race-pack-terminal.server";

/**
 * Standalone kiosk race-pack purchase (attract-screen flow) — thin shell over
 * race-pack-terminal.server.ts. POST { phase: "prepare" | "finalize", ... }.
 * All prices/kinds re-derive server-side; the client carries pointers only.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body?.phase === "prepare") {
      const packs: StandalonePackInput[] = Array.isArray(body.packs)
        ? body.packs.map((p: Record<string, unknown>) => ({
            slug: String(p.slug ?? ""),
            personId: String(p.personId ?? ""),
            memberName: String(p.memberName ?? "").slice(0, 80),
          }))
        : [];
      const result = await prepareStandalonePackPurchase(packs);
      return NextResponse.json(result);
    }
    if (body?.phase === "finalize") {
      const ep = body.externalPayment ?? {};
      const result = await finalizeStandalonePackPurchase({
        purchaseKey: String(body.purchaseKey ?? ""),
        externalPayment: {
          paymentId: String(ep.paymentId ?? ""),
          orderId: String(ep.orderId ?? ""),
          amountCents: Number(ep.amountCents ?? 0),
        },
      });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unknown phase" }, { status: 400 });
  } catch (err) {
    if (err instanceof RacePackHttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[race-pack] terminal route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Race pack purchase failed" },
      { status: 500 },
    );
  }
}
