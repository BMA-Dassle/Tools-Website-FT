import { withCrmRoute } from "~/features/crm/core/http";
import { EmptySchema } from "~/features/crm/leads";
import { callStats } from "~/features/crm/calls";
import { easternRangeToUtc, todayEasternYmd } from "~/features/crm/core/dates";

/**
 * GET /api/admin/crm/calls/badges → `{ok, missedCalls}`
 *
 * The sidebar / "More" badge for Calls: inbound calls nobody has claimed — no
 * lead, not answered. A rep sees the whole unclaimed pile, not just their own,
 * because an unclaimed caller belongs to nobody yet and hiding them behind a
 * rep filter is exactly how they stay unclaimed.
 *
 * Polled while the tab is visible, like the leads badges.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCrmRoute(EmptySchema, async () => {
  // The ET window only bounds the tiles `callStats` also computes; the
  // unclaimed count it returns is deliberately not windowed — a missed caller
  // from Friday evening is still unclaimed on Monday morning.
  const today = todayEasternYmd();
  const { startUtc, endUtc } = easternRangeToUtc(today, today);
  const stats = await callStats({
    since: new Date(startUtc),
    until: new Date(endUtc),
    repId: null,
  });
  return { missedCalls: stats.missedUnlinked };
});
