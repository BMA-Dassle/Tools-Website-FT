import { NextRequest, NextResponse } from "next/server";
import {
  getAllBowlingExperiences,
  upsertBowlingExperience,
  upsertBowlingExperienceOffer,
  setBowlingExperienceItems,
  type BowlingExperienceKind,
} from "@/lib/bowling-db";

/**
 * Admin endpoints for the bowling experience catalog.
 * Protected by x-admin-token header (same pattern as other admin routes).
 *
 * GET  /api/admin/bowling/v2/experiences
 *   Returns all experiences (all centers, all kinds) with their offers and items.
 *
 * POST /api/admin/bowling/v2/experiences
 *   Upsert a single experience including its per-center QAMF offers and
 *   bundled Square items. Body:
 *   {
 *     slug: string               — unique key, e.g. 'fun-4-all-vip'
 *     label: string              — display name
 *     kind: 'kbf'|'open'|'hourly'
 *     isVip?: boolean            — default false
 *     description?: string
 *     sortOrder?: number         — default 0
 *     isActive?: boolean         — default true
 *
 *     // Per-center QAMF web offer mappings
 *     offers: Array<{
 *       centerCode: string       — 'TXBSQN0FEKQ11' | 'PPTR5G2N0QXF7'
 *       qamfWebOfferId: number
 *       qamfOptionType?: 'Game'|'Time'|'Unlimited'
 *       qamfOptionId?: number
 *     }>
 *
 *     // Bundled Square products (replaces all existing items for this experience)
 *     items?: Array<{
 *       squareProductId: number
 *       quantity?: number        — default 1
 *       labelOverride?: string
 *       sortOrder?: number
 *     }>
 *   }
 */

const ADMIN_TOKEN = process.env.ADMIN_SECRET_TOKEN;

function isAuthorized(req: NextRequest): boolean {
  if (!ADMIN_TOKEN) return false;
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const experiences = await getAllBowlingExperiences();
    return NextResponse.json(experiences);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface OfferInput {
  centerCode: string;
  qamfWebOfferId: number;
  qamfOptionType?: string;
  qamfOptionId?: number;
}

interface ItemInput {
  squareProductId: number;
  quantity?: number;
  labelOverride?: string;
  sortOrder?: number;
}

interface UpsertBody {
  slug: string;
  label: string;
  kind: BowlingExperienceKind;
  isVip?: boolean;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
  /** 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat. Default: all days. */
  daysOfWeek?: number[];
  /** Square catalog modifier list IDs (e.g. pizza toppings, soda choice). Default: []. */
  squareModifierListIds?: string[];
  offers: OfferInput[];
  items?: ItemInput[];
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: UpsertBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { slug, label, kind, offers } = body;
  if (!slug || !label || !kind || !Array.isArray(offers) || offers.length === 0) {
    return NextResponse.json(
      { error: "slug, label, kind, and at least one offer are required" },
      { status: 400 },
    );
  }

  const validKinds: BowlingExperienceKind[] = ["kbf", "open", "hourly"];
  if (!validKinds.includes(kind)) {
    return NextResponse.json(
      { error: `invalid kind: ${kind}. Must be one of: ${validKinds.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    // 1. Upsert the experience
    const experience = await upsertBowlingExperience({
      slug,
      label,
      kind,
      isVip: body.isVip ?? false,
      description: body.description ?? null,
      sortOrder: body.sortOrder ?? 0,
      isActive: body.isActive ?? true,
      daysOfWeek: Array.isArray(body.daysOfWeek)
        ? (body.daysOfWeek as number[])
        : [0, 1, 2, 3, 4, 5, 6],
      squareModifierListIds: Array.isArray(body.squareModifierListIds)
        ? (body.squareModifierListIds as string[])
        : [],
    });

    // 2. Upsert all per-center offer mappings
    const upsertedOffers = await Promise.all(
      offers.map((o) =>
        upsertBowlingExperienceOffer({
          experienceId: experience.id,
          centerCode: o.centerCode,
          qamfWebOfferId: o.qamfWebOfferId,
          qamfOptionType: o.qamfOptionType ?? null,
          qamfOptionId: o.qamfOptionId ?? null,
          isActive: true,
        }),
      ),
    );

    // 3. Replace bundled items if provided
    if (body.items) {
      await setBowlingExperienceItems(experience.id, body.items);
    }

    return NextResponse.json({ experience, offers: upsertedOffers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
