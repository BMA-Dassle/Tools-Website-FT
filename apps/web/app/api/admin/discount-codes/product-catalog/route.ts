import { NextResponse } from "next/server";
import { ATTRACTION_LIST } from "@/lib/attractions-data";
import { sql, isDbConfigured } from "@ft/db";

/**
 * GET /api/admin/discount-codes/product-catalog
 *
 * Returns the available product slugs across all three booking domains, so
 * the admin UI's "Where it applies" picker can show real options instead of
 * a hard-coded list that drifts. Admin token gate via middleware.
 */

interface CatalogResponse {
  bowling: Array<{ slug: string; label: string }>;
  racing: Array<{ slug: string; label: string }>;
  attractions: Array<{ slug: string; label: string }>;
}

export async function GET() {
  const out: CatalogResponse = {
    bowling: [],
    racing: [],
    attractions: ATTRACTION_LIST.filter((a) => a.slug !== "racing").map((a) => ({
      slug: a.slug,
      label: a.name,
    })),
  };

  if (isDbConfigured()) {
    const q = sql();
    try {
      const rows = (await q`
        SELECT slug, label FROM bowling_experiences
        WHERE is_active = TRUE
        ORDER BY sort_order, label
      `) as Array<{ slug: string; label: string }>;
      out.bowling = rows;
    } catch (err) {
      console.warn("[discount-codes/product-catalog] bowling fetch failed:", err);
    }
  }

  // Racing products are statically defined elsewhere; for the discount-code
  // picker we expose the two top-level race types the marketing team uses.
  // When the racing wizard wires up (PR-D), this can grow to read from a
  // canonical source.
  out.racing = [
    { slug: "adult-arrive-drive", label: "Adult Arrive & Drive" },
    { slug: "junior-arrive-drive", label: "Junior Arrive & Drive" },
    { slug: "race-pack", label: "Race Pack" },
  ];

  return NextResponse.json(out);
}
