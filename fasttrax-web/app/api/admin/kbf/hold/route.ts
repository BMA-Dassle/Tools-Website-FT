import { NextRequest, NextResponse } from "next/server";
import {
  createReservation,
  deleteReservation,
  type NewReservationInput,
} from "@/lib/qamf-bowling";
import {
  getBowlingExperiences,
  getKbfRedeemedMembers,
} from "@/lib/bowling-db";

/**
 * POST /api/admin/kbf/hold
 *
 * Create a TEMPORARY QAMF reservation to hold a slot.
 * - Bowl Now:  PlayNow — QAMF auto-assigns a lane, no expiry
 * - Book Lane: BookForLater — holds the time slot, 10-min expiry
 *
 * Returns { qamfId, laneNumber?, bookedAt } so the UI can show
 * what was reserved and let staff confirm or cancel.
 *
 * DELETE /api/admin/kbf/hold
 *
 * Cancel a temporary hold (user backed out or changed their mind).
 */

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

interface BowlerInput {
  name: string;
  kbfPassId?: number;
  kbfMemberSlot?: number;
  kbfRelation?: "kid" | "family";
  shoeSize?: string | null;
  bumpers?: boolean;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    centerCode,
    mode,
    bookedAt: rawBookedAt,
    bowlers,
    guestName,
    guestEmail,
    guestPhone,
  } = body as {
    centerCode: string;
    mode: "bowl-now" | "book-lane";
    bookedAt?: string; // Required for book-lane, ignored for bowl-now
    bowlers: BowlerInput[];
    guestName: string;
    guestEmail: string;
    guestPhone?: string;
  };

  const centerId = CENTER_CODE_TO_QAMF[centerCode];
  if (!centerId) {
    return NextResponse.json({ error: "Invalid centerCode" }, { status: 400 });
  }
  if (!bowlers?.length) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }
  if (mode === "book-lane" && !rawBookedAt) {
    return NextResponse.json(
      { error: "bookedAt required for book-lane" },
      { status: 400 },
    );
  }

  try {
    // ── Validate redemption cap ──────────────────────────────────────
    const dateForCheck =
      mode === "book-lane"
        ? new Date(rawBookedAt!).toLocaleDateString("en-CA", {
            timeZone: "America/New_York",
          })
        : new Date().toLocaleDateString("en-CA", {
            timeZone: "America/New_York",
          });

    const kbfPairs = bowlers
      .filter((b) => b.kbfPassId && b.kbfMemberSlot)
      .map((b) => ({ passId: b.kbfPassId!, slot: b.kbfMemberSlot! }));
    if (kbfPairs.length > 0) {
      const redeemed = await getKbfRedeemedMembers(dateForCheck, kbfPairs);
      if (redeemed.length > 0) {
        const names = bowlers
          .filter((b) =>
            redeemed.some(
              (r) =>
                r.passId === b.kbfPassId && r.slot === b.kbfMemberSlot,
            ),
          )
          .map((b) => b.name);
        const msg =
          mode === "bowl-now"
            ? `Already played today: ${names.join(", ")}`
            : `Already booked that day: ${names.join(", ")}`;
        return NextResponse.json({ error: msg }, { status: 409 });
      }
    }

    // ── Load KBF experience ──────────────────────────────────────────
    const experiences = await getBowlingExperiences(centerCode, "kbf");
    const kbfExp = experiences.find(
      (e) => e.slug === "kbf-regular" || (!e.isVip && e.kind === "kbf"),
    );
    if (!kbfExp || !kbfExp.qamfWebOfferId) {
      return NextResponse.json(
        { error: "KBF experience not configured for this center" },
        { status: 500 },
      );
    }

    // ── Build bookedAt ───────────────────────────────────────────────
    let bookedAt: string;
    if (mode === "bowl-now") {
      const now = new Date();
      now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
      bookedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    } else {
      const d = new Date(rawBookedAt!);
      d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
      bookedAt = d.toISOString().replace(/\.\d{3}Z$/, "Z");
    }

    // ── Build QAMF options block ─────────────────────────────────────
    const optionsBlock: NewReservationInput["WebOffer"]["Options"] =
      kbfExp.qamfOptionType === "Game"
        ? { Game: [{ Id: kbfExp.qamfOptionId! }] }
        : kbfExp.qamfOptionType === "Unlimited"
          ? { Unlimited: [{ Id: kbfExp.qamfOptionId! }] }
          : { Time: [{ Id: kbfExp.qamfOptionId! }] };

    // ── Create TEMPORARY QAMF reservation ────────────────────────────
    const service = mode === "bowl-now" ? "PlayNow" : "BookForLater";
    const qamfInput: NewReservationInput = {
      BookedAt: bookedAt,
      Title: `${guestName} (${bowlers.length}p)`,
      Notes: `KBF: ${bowlers.filter((b) => b.kbfRelation === "kid").length} kids free${bowlers.some((b) => b.kbfRelation === "family") ? `, ${bowlers.filter((b) => b.kbfRelation === "family").length} family free (FBF)` : ""} | Admin ${mode === "bowl-now" ? "walk-in" : "booking"}`,
      Customer: {
        Guest: {
          Name: guestName,
          PhoneNumber: guestPhone || "0000000000",
          Email: guestEmail,
        },
      },
      WebOffer: {
        Id: kbfExp.qamfWebOfferId,
        Options: optionsBlock,
        Services: [service],
      },
      TotalPlayers: bowlers.length,
      // No Lanes — QAMF auto-assigns for PlayNow, no lane for BookForLater
    };

    const qamfRes = await createReservation(centerId, qamfInput);
    const assignedLane = qamfRes.Lanes?.[0]?.LaneNumber ?? null;

    return NextResponse.json({
      ok: true,
      qamfId: qamfRes.Id,
      laneNumber: assignedLane,
      bookedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Hold failed";
    console.error(`[admin/kbf/hold] failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** DELETE — cancel a temporary hold */
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { centerCode, qamfId } = body as {
    centerCode: string;
    qamfId: string;
  };

  const centerId = CENTER_CODE_TO_QAMF[centerCode];
  if (!centerId || !qamfId) {
    return NextResponse.json(
      { error: "centerCode and qamfId required" },
      { status: 400 },
    );
  }

  try {
    await deleteReservation(centerId, qamfId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Best-effort — temp reservations auto-expire anyway
    console.warn(`[admin/kbf/hold] delete failed:`, err);
    return NextResponse.json({ ok: true });
  }
}
