import { NextRequest, NextResponse } from "next/server";
import { upsertMemberPref } from "@/lib/kbf-prefs";

/**
 * POST /api/kbf/prefs
 *
 * Body:
 *   {
 *     prefs: [
 *       {
 *         passId: number,            // skipped if 0 (parent pseudo-bowler)
 *         memberSlot: number,
 *         relation: "kid" | "family",
 *         shoeSizeId: number | null,
 *         shoeSizeLabel: string | null,
 *         wantShoes: boolean,
 *         wantBumpers: boolean,
 *         lastUsedCenter: "fortmyers" | "naples" | null
 *       },
 *       ...
 *     ]
 *   }
 *
 * Persists per-member shoe size + bumper preferences to
 * `kbf_member_prefs` so the next visit can pre-fill the bowler-
 * selection step. Called from the wizard's "Continue" handler so a
 * parent who picks sizes but bails before completing the reservation
 * still has those sizes saved for next time.
 *
 * The /api/kbf/reserve route ALSO writes prefs after a successful
 * reservation. That stays as the canonical post-reservation save —
 * this endpoint is the early-save belt for the bail-out case.
 *
 * Best-effort: any individual upsert failure is logged + swallowed.
 * The wizard fire-and-forgets this call; UX must not depend on it.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const prefs = Array.isArray(body?.prefs) ? body.prefs : [];
    if (prefs.length === 0) {
      return NextResponse.json({ ok: true, saved: 0 });
    }

    let saved = 0;
    for (const p of prefs) {
      const passId = Number(p?.passId);
      const memberSlot = Number(p?.memberSlot);
      const relation = p?.relation;

      // Skip parent pseudo-bowler (passId 0) and any malformed input.
      if (!Number.isFinite(passId) || passId <= 0) continue;
      if (!Number.isFinite(memberSlot) || memberSlot < 0) continue;
      if (relation !== "kid" && relation !== "family") continue;

      try {
        await upsertMemberPref({
          passId,
          memberSlot,
          relation,
          shoeSizeId: typeof p.shoeSizeId === "number" ? p.shoeSizeId : null,
          shoeSizeLabel: typeof p.shoeSizeLabel === "string" ? p.shoeSizeLabel : null,
          wantShoes: typeof p.wantShoes === "boolean" ? p.wantShoes : null,
          wantBumpers: typeof p.wantBumpers === "boolean" ? p.wantBumpers : null,
          lastUsedCenter: typeof p.lastUsedCenter === "string" ? p.lastUsedCenter : null,
        });
        saved++;
      } catch (err) {
        console.warn(
          `[kbf/prefs] upsert failed for pass=${passId} slot=${memberSlot}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return NextResponse.json(
      { ok: true, saved },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[kbf/prefs] error:", err);
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }
}
