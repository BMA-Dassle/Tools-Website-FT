/**
 * What `/admin/crm/calls` loads in one round trip (`crm-shared.js:422-425`):
 * the missed-caller banner, the call list, the three tiles — plus the honest
 * connectivity report the prototype could not have (it assumed 3CX was wired).
 *
 * SCOPE. A rep sees their own calls; a director sees everyone's, and may narrow
 * to one rep with `?rep=`. That mirrors every other CRM board.
 *
 * THE TRAY is "not in your leads" from the prototype's banner, generalised:
 * every call with no `lead_id`, newest first, capped — the screen shows them as
 * a row of chips with Create lead / Link to a lead. It is deliberately NOT
 * limited to missed calls: an answered call from a stranger needs claiming just
 * as much.
 */

import { easternRangeToUtc, todayEasternYmd } from "../../core/dates";
import { crmCallsEnabled } from "../../core/flags";
import { publicRoster } from "../../reps";
import type { CrmUser } from "../../core/types";
import { callStats, listCalls, type CallListFilter, EMPTY_CALL_STATS } from "../data/calls-db";
import type { CallsConnectivity, CallsListResponse } from "../contracts";
import { threecxSecretConfigured } from "./secret";
import { threecxConfigured } from "./threecx";

/** How many unclaimed callers the tray shows before it stops. */
export const TRAY_MAX = 12;

export interface CallsBoardQuery {
  cursor?: string | null;
  limit?: number;
  /** Director only; ignored for a rep, who always sees their own. */
  repId?: string | null;
  direction?: "in" | "out";
  needsDisposition?: boolean;
  missedOnly?: boolean;
}

export interface BoardDeps {
  list: typeof listCalls;
  stats: typeof callStats;
  roster: typeof publicRoster;
  apiConfigured: typeof threecxConfigured;
  journalConfigured: typeof threecxSecretConfigured;
  callsEnabled: typeof crmCallsEnabled;
  now: () => Date;
}

export const defaultBoardDeps: BoardDeps = {
  list: listCalls,
  stats: callStats,
  roster: publicRoster,
  apiConfigured: threecxConfigured,
  journalConfigured: threecxSecretConfigured,
  callsEnabled: crmCallsEnabled,
  now: () => new Date(),
};

/** Whose calls this request is allowed to see. A rep with no rep row sees none. */
export function scopeRepId(user: CrmUser, asked: string | null | undefined): string | null {
  if (user.role === "director") return asked ?? null;
  return user.rep?.id ?? "-1";
}

export function connectivityFor(
  user: CrmUser,
  deps: Pick<BoardDeps, "apiConfigured" | "journalConfigured" | "callsEnabled">,
): CallsConnectivity {
  return {
    apiConfigured: deps.apiConfigured(),
    journalConfigured: deps.journalConfigured(),
    clickToCallEnabled: deps.callsEnabled(),
    myExtension: user.rep?.threecxExtension ?? null,
  };
}

export async function loadCallsBoard(
  user: CrmUser,
  query: CallsBoardQuery = {},
  deps: BoardDeps = defaultBoardDeps,
): Promise<Omit<CallsListResponse, "ok">> {
  const repId = scopeRepId(user, query.repId);
  const filter: CallListFilter = {
    cursor: query.cursor ?? null,
    limit: query.limit,
    repId,
    direction: query.direction,
    needsDisposition: query.needsDisposition,
    missedOnly: query.missedOnly,
  };

  // "Calls today" is the ET calendar day, not the server's: a 9 pm Fort Myers
  // call is tomorrow in UTC (memory `project_rainyday_20_off_tonight`).
  const today = todayEasternYmd(deps.now());
  const { startUtc, endUtc } = easternRangeToUtc(today, today);

  const [page, tray, stats, reps] = await Promise.all([
    deps.list(filter),
    // The tray is never scoped to a rep: an unclaimed caller belongs to nobody
    // yet, and hiding them behind a rep filter is how they stay unclaimed.
    deps.list({ unlinked: true, limit: TRAY_MAX }),
    deps
      .stats({ since: new Date(startUtc), until: new Date(endUtc), repId })
      .catch(() => EMPTY_CALL_STATS),
    deps.roster(),
  ]);

  return {
    calls: page.calls,
    nextCursor: page.nextCursor,
    tray: tray.calls,
    stats,
    connectivity: connectivityFor(user, deps),
    reps,
  };
}
