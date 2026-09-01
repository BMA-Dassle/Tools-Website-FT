/**
 * Per-center ONSITE liveness for the public reload UI: {"12":true,"6":false,…}.
 *
 * Was driven by a Redis heartbeat the on-prem EIS bridge stamped on each claim.
 * That bridge is retired, so this now probes the onsite Intercard proxy per
 * center — the same question ("can this center's card system take a load right
 * now?"), answered against the path we actually use.
 *
 * Public + harmless (reveals only "instant loading available here or not");
 * fails closed to all-false so the UI just uses its softer wording.
 */
import { NextResponse } from "next/server";
import { CENTER_LIST } from "~/config/intercard-centers";
import { probeOnsite } from "~/features/game-cards/data/intercard-onsite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const results = await Promise.all(
      CENTER_LIST.map(async (c) => {
        const { status } = await probeOnsite(c.code, 5_000);
        return [String(c.code), status === "onsite"] as const;
      }),
    );
    const centers = Object.fromEntries(results);
    return NextResponse.json({ ok: true, centers }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ok: true, centers: {} },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
