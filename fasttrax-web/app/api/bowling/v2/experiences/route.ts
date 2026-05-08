import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingExperiences,
  type BowlingExperienceKind,
} from "@/lib/bowling-db";

const CENTER_ID_TO_CODE: Record<string, string> = {
  "9172": "TXBSQN0FEKQ11",
  "3148": "PPTR5G2N0QXF7",
};

/**
 * GET /api/bowling/v2/experiences
 *
 * Returns active experiences for a center, with bundled Square items
 * (the combo) and the center-specific QAMF web offer ID resolved.
 *
 * Query params:
 *   centerCode  — Square location code, e.g. 'TXBSQN0FEKQ11'
 *   centerId    — QAMF center ID (9172 / 3148) — alternative to centerCode
 *   kind        — optional: 'kbf' | 'open' | 'hourly'
 *
 * Response: BowlingExperienceWithDetails[]
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  let centerCode = searchParams.get("centerCode") ?? "";
  const centerId = searchParams.get("centerId") ?? "";
  if (!centerCode && centerId) {
    centerCode = CENTER_ID_TO_CODE[centerId] ?? "";
  }

  if (!centerCode) {
    return NextResponse.json(
      { error: "centerCode or centerId is required" },
      { status: 400 },
    );
  }

  const kind = (searchParams.get("kind") ?? undefined) as BowlingExperienceKind | undefined;
  const validKinds: BowlingExperienceKind[] = ["kbf", "open", "hourly"];
  if (kind && !validKinds.includes(kind)) {
    return NextResponse.json(
      { error: `invalid kind: ${kind}. Must be one of: ${validKinds.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const experiences = await getBowlingExperiences(centerCode, kind);
    return NextResponse.json(experiences);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
