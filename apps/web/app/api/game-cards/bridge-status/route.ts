/**
 * Per-center bridge liveness for the reload UI: {"12":true,"6":false,...}.
 * Driven by the Redis heartbeat each authenticated bridge claim stamps.
 * Public + harmless (reveals only "instant loading available here or not");
 * fails closed to all-false so the UI just uses its softer wording.
 */
import { NextResponse } from "next/server";
import { bridgeStatus } from "~/features/game-cards/service/bridge-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const centers = await bridgeStatus();
    return NextResponse.json({ ok: true, centers }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { ok: true, centers: {} },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
