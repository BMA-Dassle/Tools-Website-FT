import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ListQuerySchema,
  MAX_RANGE_DAYS,
  adaptersFor,
  activeAdapters,
  csvFilename,
  daysBetweenYmd,
  decodeCursor,
  defaultRange,
  listWebSales,
  searchParamsToObject,
  summarizeWebSales,
  toCsv,
} from "~/features/web-sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Admin: every non-reservation sale made on the website, one board.
 *
 * READ-ONLY in this build. The action verbs (resend, refund, void) arrive with
 * the PRs that implement them; there is deliberately no POST handler yet, so an
 * action posted here gets Next's automatic 405 rather than a stub that looks
 * like it did something.
 *
 *   GET ?token=…[&from&to&source&status&venue&q&cursor&limit&format]
 *     → { ok, rows, nextCursor, summary, bySource, sources, errors }
 *     → text/csv when format=csv
 *
 * AUTH is `ADMIN_CAMERA_TOKEN` on the query string, matching every sibling admin
 * route. `middleware.ts` already gates `/api/admin/*` on the same token and fails
 * closed to a 404; this check is defence in depth for the case where the route is
 * reached by some path the middleware does not cover.
 *
 * NOT in the middleware's `apiKeyEligible` allowlist, on purpose. That list is
 * for read-only surfaces the employee portal polls with an `x-api-key`; this
 * route grows refund verbs, so it stays strict-token only.
 *
 * `dynamic = "force-dynamic"` is still a supported segment config here — Next 16
 * only removes it when Cache Components is enabled, and `next.config.ts` does not
 * enable it (checked, not assumed).
 */

function authed(token: string | null | undefined): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
}

/** Hard cap on an export. Large enough for a year of sales, small enough not to OOM. */
const CSV_MAX_ROWS = 5000;

export async function GET(req: NextRequest) {
  if (!authed(req.nextUrl.searchParams.get("token"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = ListQuerySchema.safeParse(searchParamsToObject(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "bad_request", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  // Defaults are applied AFTER validation so an explicit half-range (`from` with
  // no `to`) still gets a sensible partner instead of being rejected.
  const fallback = defaultRange();
  const from = parsed.data.from ?? fallback.from;
  const to = parsed.data.to ?? fallback.to;
  if (from > to) {
    return NextResponse.json(
      { ok: false, error: "bad_request", detail: "from must be on or before to" },
      { status: 400 },
    );
  }
  if (daysBetweenYmd(from, to) > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { ok: false, error: "range_too_wide", detail: `Pick a range of ${MAX_RANGE_DAYS} days or fewer.` },
      { status: 400 },
    );
  }

  const adapters = adaptersFor(parsed.data.source);
  const query = { from, to, q: parsed.data.q, status: parsed.data.status, venue: parsed.data.venue };

  // The export runs the SAME query path as the screen — only the cursor and the
  // page size differ — so a CSV can never disagree with the table above it.
  if (parsed.data.format === "csv") {
    const { rows, errors } = await listWebSales({
      adapters,
      query,
      cursor: null,
      limit: CSV_MAX_ROWS,
    });
    // A partial export is worse than a failed one: it looks complete in a
    // spreadsheet, and nothing in the file records what was missing.
    if (errors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "source_unavailable",
          detail: `Could not read ${errors.map((e) => e.source).join(", ")} — export not written.`,
          errors,
        },
        { status: 502 },
      );
    }
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${csvFilename(from, to)}"`,
        // The row cap is silent in a spreadsheet — say so in a header a curious
        // operator (or a future bug report) can find.
        "x-web-sales-truncated": rows.length >= CSV_MAX_ROWS ? "true" : "false",
      },
    });
  }

  const cursor = decodeCursor(parsed.data.cursor);
  const [page, totals] = await Promise.all([
    listWebSales({ adapters, query, cursor, limit: parsed.data.limit }),
    summarizeWebSales({ adapters, query }),
  ]);

  return NextResponse.json({
    ok: true,
    range: { from, to },
    rows: page.rows,
    nextCursor: page.nextCursor,
    summary: totals.total,
    bySource: totals.bySource,
    // What the board should offer in its filter chips — the live registry, not a
    // hardcoded client-side list, so a killed source disappears from the UI too.
    sources: activeAdapters().map((a) => ({
      id: a.id,
      label: a.label,
      sublabel: a.sublabel,
      statusFilters: a.statusFilters,
      venues: a.venues,
      actions: a.actions,
    })),
    // Surfaced, never swallowed: a source that failed shows as an error banner
    // rather than as a shorter list that looks complete.
    errors: [...page.errors, ...totals.errors],
  });
}
