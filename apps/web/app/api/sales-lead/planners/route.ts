import { NextResponse } from "next/server";
import { listRoster } from "~/features/crm/reps";
import { plannerOptions, type PlannerOption } from "~/features/crm/leads/planners";

/**
 * GET /api/sales-lead/planners — the planner list the PUBLIC lead form shows
 * under "Who would you like to work with?" (B7, owner 2026-09-13 14:05).
 *
 * WHY THIS IS PUBLIC, and why it is HERE. The five `SalesLeadForm.tsx` pages
 * are `"use client"` pages, so there is no server component to hand the list
 * down as a prop; the form has to fetch it. It therefore lives beside the
 * form's own public endpoint (`/api/sales-lead/submit`) rather than under
 * `/api/crm/**`, which the brief reserves for exactly three documented public
 * routes (graph-webhook, 3cx/*, share/[token]) — this adds no fourth.
 *
 * WHAT IT DISCLOSES: a first name and the centres that planner covers, for
 * active people on the roster only. No email, no DID, no Teams chat id, no
 * Office username, no row id — `plannerOptions` is the one projection and a
 * test pins its shape. The guest posts back a SLUG and `createLead` resolves
 * it against the roster, so nothing here can be used to forge an assignment.
 *
 * CACHING: this is a marketing page's dropdown, not a live query — it must
 * never mean a database round trip per keystroke or per form open. Two layers,
 * because neither alone is enough: `Cache-Control` lets the CDN answer for
 * five minutes (and serve stale for an hour while it revalidates), and a
 * five-minute in-process memo keeps a cold, uncached hit off Neon as well. A
 * roster change (a planner added, a centre dropped) appears within five
 * minutes with no deploy. The form fetches this ONCE per mount and filters by
 * centre in the browser, so switching centre costs nothing.
 *
 * It is `force-dynamic` deliberately: a cached-by-default route handler would
 * be evaluated during `next build`, which would mean reading Neon at build
 * time. The header does the caching instead.
 *
 * FAILURE: never fatal to the form. An unconfigured or unreachable database
 * answers `{ ok: true, planners: [] }`, the control hides itself, and the
 * guest submits exactly as they did before this feature existed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";
const MEMO_MS = 300_000;

let memo: { at: number; planners: PlannerOption[] } | null = null;

export async function GET() {
  let planners: PlannerOption[] = memo && Date.now() - memo.at < MEMO_MS ? memo.planners : [];
  if (!memo || Date.now() - memo.at >= MEMO_MS) {
    try {
      planners = plannerOptions(await listRoster());
      memo = { at: Date.now(), planners };
    } catch (err) {
      console.error("[crm] planner list unavailable for the lead form", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({ ok: true, planners }, { headers: { "Cache-Control": CACHE_CONTROL } });
}
