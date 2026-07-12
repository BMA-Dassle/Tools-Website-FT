/**
 * Pricing-stamp backfill — derive booking_metadata.bowling for reservations
 * booked before PR 0 introduced the stamp (all pre-branch production rows).
 *
 * Pure offline derivation from stored lines + player_count + the experience
 * tables (resolveBookedPricing — the exact fallback buildEditPlan runs),
 * then an ADDITIVE jsonb merge so heats/worldCup keys are never clobbered.
 * Idempotent by construction: only rows missing the stamp are scanned, and
 * the UPDATE re-checks the stamp is still absent. Rows that can't derive
 * (zero lines, ambiguous primaries, unknown experience, non-sane multiplier)
 * are skipped WITH their reason — never guessed.
 */
import { isDbConfigured, sql } from "@/lib/db";
import {
  ensureBowlingSchema,
  getBowlingSquareProducts,
  type BowlingExperienceWithDetails,
  type BowlingSquareProduct,
  type ReservationProductKind,
} from "@/lib/bowling-db";
import { resolveCenter } from "~/features/cancellation/centers";
import { loadExperiencesForCenter, matchExperienceForRow } from "./experience-resolve";
import { resolveBookedPricing } from "./reprice";
import type { BowlingBookedStamp, StoredLine } from "./types";

interface ScanRow {
  id: number;
  center_code: string;
  product_kind: ReservationProductKind;
  player_count: number | null;
  guest_name: string | null;
  booked_at: string;
}

interface LineRow {
  square_product_id: number | null;
  label: string;
  quantity: number;
  unit_price_cents: number;
}

export interface StampBackfillResult {
  dryRun: boolean;
  scanned: number;
  stamped: Array<{
    neonId: number;
    guestName: string | null;
    bookedAt: string;
    stamp: BowlingBookedStamp;
  }>;
  skipped: Array<{ neonId: number; reason: string }>;
  /**
   * Keyset cursor: pass as `beforeId` on the next call. null = the scan is
   * exhausted. Without this, permanently-skipped rows pin the batch window
   * and repeated runs re-scan the same rows forever.
   */
  nextBeforeId: number | null;
  /** Rows with NO priced lines (admin/POS/league placeholders) — excluded
   *  from the scan entirely; they have no money model to stamp. */
  zeroLineRows: number;
}

/**
 * Derive the stamp for one row — pure given its lines and the center's
 * experiences. Throws EditGuardError (pricing_unresolvable) when derivation
 * doesn't reconcile; the caller records the message as the skip reason.
 */
export const deriveStampForRow = (params: {
  playerCount: number;
  lines: StoredLine[];
  experiences: BowlingExperienceWithDetails[];
}): BowlingBookedStamp => {
  const experience = matchExperienceForRow({
    experiences: params.experiences,
    stored: params.lines,
  });
  const booked = resolveBookedPricing({
    bookingMetadata: null,
    playerCount: params.playerCount,
    lines: params.lines,
    experienceKind: experience?.kind ?? null,
    experienceSlug: experience?.slug ?? null,
  });
  // Strip the resolution `source` marker — only the stamp shape is stored.
  return {
    experienceSlug: booked.experienceSlug,
    laneCount: booked.laneCount,
    durationMultiplier: booked.durationMultiplier,
    pricingMode: booked.pricingMode,
  };
};

export const runStampBackfill = async (params: {
  dryRun: boolean;
  limit: number;
  neonId: number | null;
  /** Keyset cursor from the previous call's nextBeforeId. */
  beforeId?: number | null;
}): Promise<StampBackfillResult> => {
  if (!isDbConfigured()) throw new Error("stamp-backfill: DATABASE_URL not configured");
  await ensureBowlingSchema();
  const q = sql();
  const beforeId = params.beforeId ?? null;

  // Batch scan notes:
  //  - Zero-line rows (league/admin/POS placeholders — 4.7k in prod, some
  //    dated YEARS out) can never stamp; they'd pin a booked_at-ordered
  //    window forever. Exclude them in SQL and report the count instead.
  //  - ORDER BY id DESC (creation order, newest first) + keyset `beforeId`
  //    so rows that skip (ambiguous pricing) can't pin the window either.
  const rows = (params.neonId != null
    ? await q`
          SELECT id, center_code, product_kind, player_count, guest_name, booked_at
          FROM bowling_reservations
          WHERE id = ${params.neonId}
            AND product_kind IN ('open', 'kbf')
            AND status != 'cancelled'
            AND booking_metadata -> 'bowling' IS NULL
        `
    : await q`
          SELECT id, center_code, product_kind, player_count, guest_name, booked_at
          FROM bowling_reservations r
          WHERE product_kind IN ('open', 'kbf')
            AND status != 'cancelled'
            AND booking_metadata -> 'bowling' IS NULL
            AND EXISTS (
              SELECT 1 FROM bowling_reservation_lines l WHERE l.reservation_id = r.id
            )
            AND (${beforeId}::bigint IS NULL OR id < ${beforeId})
          ORDER BY id DESC
          LIMIT ${params.limit}
        `) as unknown as ScanRow[];

  let zeroLineRows = 0;
  if (params.neonId == null) {
    const counted = (await q`
      SELECT COUNT(*)::int AS n
      FROM bowling_reservations r
      WHERE product_kind IN ('open', 'kbf')
        AND status != 'cancelled'
        AND booking_metadata -> 'bowling' IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM bowling_reservation_lines l WHERE l.reservation_id = r.id
        )
    `) as unknown as Array<{ n: number }>;
    zeroLineRows = counted[0]?.n ?? 0;
  }

  // One catalog/experience fetch per distinct center, not per row.
  const productCache = new Map<string, Map<number, BowlingSquareProduct>>();
  const experienceCache = new Map<string, BowlingExperienceWithDetails[]>();

  const productsFor = async (row: ScanRow): Promise<Map<number, BowlingSquareProduct>> => {
    const cached = productCache.get(row.center_code);
    if (cached) return cached;
    // Dual-namespace probe (same as buildEditPlan): raw center_code first,
    // then the resolved slug for legacy Square-location-id rows.
    let products = await getBowlingSquareProducts(row.center_code);
    const slug = resolveCenter(row.center_code, row.product_kind).slug;
    if (products.length === 0 && slug !== row.center_code) {
      products = await getBowlingSquareProducts(slug);
    }
    const byId = new Map(products.map((p) => [p.id, p]));
    productCache.set(row.center_code, byId);
    return byId;
  };

  const experiencesFor = async (row: ScanRow): Promise<BowlingExperienceWithDetails[]> => {
    const cached = experienceCache.get(row.center_code);
    if (cached) return cached;
    const experiences = await loadExperiencesForCenter(row.center_code, row.product_kind);
    experienceCache.set(row.center_code, experiences);
    return experiences;
  };

  const stamped: StampBackfillResult["stamped"] = [];
  const skipped: StampBackfillResult["skipped"] = [];

  for (const row of rows) {
    try {
      const lineRows = (await q`
        SELECT square_product_id, label, quantity, unit_price_cents
        FROM bowling_reservation_lines
        WHERE reservation_id = ${row.id}
        ORDER BY id
      `) as unknown as LineRow[];
      const productsById = await productsFor(row);
      const lines: StoredLine[] = lineRows.map((l) => {
        const product =
          l.square_product_id != null ? productsById.get(l.square_product_id) : undefined;
        return {
          squareProductId: l.square_product_id,
          label: l.label,
          quantity: l.quantity,
          unitPriceCents: l.unit_price_cents,
          productKind: product?.productKind ?? null,
          catalogPriceCents: product?.priceCents ?? null,
          squareCatalogObjectId: product?.squareCatalogObjectId ?? null,
        };
      });

      const stamp = deriveStampForRow({
        playerCount: row.player_count ?? 0,
        lines,
        experiences: await experiencesFor(row),
      });

      if (!params.dryRun) {
        // Additive merge — never clobbers other booking_metadata keys; the
        // re-check keeps concurrent runs idempotent.
        await q`
          UPDATE bowling_reservations
          SET booking_metadata = COALESCE(booking_metadata, '{}'::jsonb)
              || jsonb_build_object('bowling', ${JSON.stringify(stamp)}::jsonb)
          WHERE id = ${row.id}
            AND booking_metadata -> 'bowling' IS NULL
        `;
      }
      stamped.push({ neonId: row.id, guestName: row.guest_name, bookedAt: row.booked_at, stamp });
    } catch (err) {
      skipped.push({
        neonId: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dryRun: params.dryRun,
    scanned: rows.length,
    stamped,
    skipped,
    // A full batch means there may be more — hand back the cursor. A short
    // batch means the scan is exhausted.
    nextBeforeId:
      params.neonId == null && rows.length === params.limit
        ? (rows[rows.length - 1]?.id ?? null)
        : null,
    zeroLineRows,
  };
};
