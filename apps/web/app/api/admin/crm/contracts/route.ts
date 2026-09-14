import {
  ContractsListQuerySchema,
  EMPTY_COUNTS,
  contractCounts,
  listContracts,
  type ContractListPage,
} from "~/features/crm/contracts";
import { withCrmRoute } from "~/features/crm/core/http";

/**
 * GET /api/admin/crm/contracts
 *   ?win=attention|7|30|90|past|all   (default: attention — what needs a human)
 *   &status=&centre=&rep=&q=&closed=1&cursor=&limit=
 *   → `{ok, rows, nextCursor, total, counts}`
 *
 * `?counts=1` answers the same envelope with NO rows and no page COUNT: it is
 * the sidebar badge's poll, and a badge must not cost a page of contracts
 * every minute.
 *
 * Keyset on (event_date ASC, id ASC) — the screen's own order — 25 a page,
 * `limit ≤ 200` (R10). The "Needs attention" predicate is evaluated in SQL, so
 * the count on the tile, the badge and the rows in the list are the same set
 * rather than three approximations of it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isOn = (v: string | undefined) => v === "1" || v === "true";

export const GET = withCrmRoute(
  ContractsListQuerySchema,
  async ({ input }): Promise<ContractListPage> => {
    if (isOn(input.counts)) {
      // The badge poll. It carries the SAME filters as the list, because a
      // count that ignores them is a count of somebody else's work — with a
      // rep selected the badge read the whole team's 81 over that rep's list
      // (owner, 2026-09-14: "That number is not honooring the filter").
      // `listContracts` owns the slug → planner-email resolution, so a rep
      // filter goes through it rather than being resolved a second way here.
      if (input.rep) {
        const page = await listContracts({
          win: "attention",
          centre: input.centre,
          rep: input.rep,
          q: input.q,
          closed: isOn(input.closed),
          past: isOn(input.past),
          limit: 1,
        });
        return { rows: [], nextCursor: null, total: 0, counts: page.counts };
      }
      const counts = await contractCounts(new Date(), {
        centre: input.centre,
        q: input.q,
        closed: isOn(input.closed),
        past: isOn(input.past),
      }).catch(() => EMPTY_COUNTS);
      return { rows: [], nextCursor: null, total: 0, counts };
    }
    return listContracts({
      win: input.win,
      status: input.status,
      centre: input.centre,
      rep: input.rep,
      q: input.q,
      closed: isOn(input.closed),
      past: isOn(input.past),
      cursor: input.cursor ?? null,
      limit: input.limit,
    });
  },
);
