import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  ActionSchema,
  ListQuerySchema,
  MAX_RANGE_DAYS,
  adaptersFor,
  activeAdapters,
  csvFilename,
  daysBetweenYmd,
  decodeCursor,
  defaultRange,
  getAdapter,
  listWebSales,
  searchParamsToObject,
  summarizeWebSales,
  toCsv,
} from "~/features/web-sales";
import { isAdminCredential } from "@/lib/admin-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Admin: every non-reservation sale made on the website, one board.
 *
 *   GET  ?token=…[&from&to&source&status&venue&q&cursor&limit&format]
 *     → { ok, rows, nextCursor, summary, bySource, sources, errors }
 *     → text/csv when format=csv
 *   GET  ?token=…&detail=<source>:<ref>   → { ok, detail }
 *   POST { action: "preview_resend" }     → what the message would say
 *   POST { action: "resend" }             → send it, optionally somewhere else
 *   POST { action: "void" }               → kill the value, leave the money
 *   POST { action: "refund_dryrun" }      → what a refund would do (no money)
 *   POST { action: "refund_execute" }     → do it
 *
 * An action this build does not know is a 400 from the zod union rather than a
 * stub that looks like it did something.
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

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function authed(token: string | null | undefined): Promise<boolean> {
  return isAdminCredential(token);
}

/** Hard cap on an export. Large enough for a year of sales, small enough not to OOM. */
const CSV_MAX_ROWS = 5000;

export async function GET(req: NextRequest) {
  if (!(await authed(req.nextUrl.searchParams.get("token")))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // `?detail=deals:412` — one sale's legs, timeline and facts for the drawer.
  // A GET rather than a POST action because it is a read, and because it makes
  // the `?sale=` deep link a single round trip on first paint.
  const detailKey = req.nextUrl.searchParams.get("detail");
  if (detailKey) {
    const sep = detailKey.indexOf(":");
    if (sep < 1) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const adapter = getAdapter(detailKey.slice(0, sep));
    if (!adapter) return NextResponse.json({ ok: false, error: "unknown_source" }, { status: 404 });
    const detail = await adapter.detail(detailKey.slice(sep + 1));
    if (!detail) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, detail });
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
      {
        ok: false,
        error: "range_too_wide",
        detail: `Pick a range of ${MAX_RANGE_DAYS} days or fewer.`,
      },
      { status: 400 },
    );
  }

  const adapters = adaptersFor(parsed.data.source);
  const query = {
    from,
    to,
    q: parsed.data.q,
    status: parsed.data.status,
    venue: parsed.data.venue,
  };

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
      resendChannels: a.resendChannels,
    })),
    // Surfaced, never swallowed: a source that failed shows as an error banner
    // rather than as a shorter list that looks complete.
    errors: [...page.errors, ...totals.errors],
  });
}

export async function POST(req: NextRequest) {
  // Token on the QUERY STRING as well as the body: the middleware gate runs
  // before this handler and cannot read a body, so a body-only token 404s.
  if (!(await authed(req.nextUrl.searchParams.get("token")))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "bad_request", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  if (!(await authed(parsed.data.token))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const adapter = getAdapter(parsed.data.source);
  if (!adapter) {
    return NextResponse.json({ ok: false, error: "unknown_source" }, { status: 404 });
  }

  // One shared admin token, no per-user identity — see web-sales-audit-db.ts.
  const actor = "admin";

  try {
    if (parsed.data.action === "preview_resend") {
      if (!adapter.previewResend) {
        return NextResponse.json({ ok: false, error: "unsupported" }, { status: 409 });
      }
      const preview = await adapter.previewResend({
        ref: parsed.data.ref,
        channel: parsed.data.channel,
      });
      return NextResponse.json({ ok: true, preview });
    }

    if (parsed.data.action === "refund_dryrun") {
      if (!adapter.planRefund) {
        return NextResponse.json({ ok: false, error: "unsupported" }, { status: 409 });
      }
      // ALWAYS allowed, even with the kill switch off — the plan carries
      // `blocked` so the refusal is visible in the preview rather than at the
      // moment someone clicks the money button.
      const plan = await adapter.planRefund({
        ref: parsed.data.ref,
        unitKeys: parsed.data.unitKeys,
      });
      return NextResponse.json({ ok: true, plan });
    }

    if (parsed.data.action === "refund_execute") {
      if (!adapter.executeRefund || !adapter.actions.includes("refund")) {
        return NextResponse.json({ ok: false, error: "unsupported" }, { status: 409 });
      }
      const result = await adapter.executeRefund({
        ref: parsed.data.ref,
        unitKeys: parsed.data.unitKeys,
        destination: parsed.data.destination,
        reason: parsed.data.reason,
        planHash: parsed.data.planHash,
        notifyGuest: false,
        actor,
      });
      return NextResponse.json({ ok: true, result });
    }

    if (parsed.data.action === "void") {
      if (!adapter.void || !adapter.actions.includes("void")) {
        return NextResponse.json({ ok: false, error: "unsupported" }, { status: 409 });
      }
      const result = await adapter.void({
        ref: parsed.data.ref,
        unitKeys: null,
        reason: parsed.data.reason,
        actor,
      });
      return NextResponse.json({ ok: true, result });
    }

    if (!adapter.resend || !adapter.actions.includes("resend")) {
      return NextResponse.json({ ok: false, error: "unsupported" }, { status: 409 });
    }
    const result = await adapter.resend({
      ref: parsed.data.ref,
      channel: parsed.data.channel,
      overrideEmail: parsed.data.overrideEmail,
      overridePhone: parsed.data.overridePhone,
      actor,
    });
    // A partial failure is still a 200 with per-channel truth in the body — the
    // same contract the videos resend route uses, and what the modal reads.
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "not_found") {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    // The plan the operator saw no longer describes reality — usually a guest
    // redeemed a leg while the modal was open. The client refetches and shows
    // the new picture instead of executing against a stale world.
    if (message === "plan_stale") {
      return NextResponse.json({ ok: false, error: "plan_stale" }, { status: 409 });
    }
    console.error("[web-sales] action failed:", err);
    return NextResponse.json(
      { ok: false, error: "action_failed", detail: message },
      { status: 502 },
    );
  }
}
