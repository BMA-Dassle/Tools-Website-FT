/**
 * What the two cold screens need, each in ONE round trip.
 *
 * `/admin/crm/cold`        → every list with its conversion counters
 * `/admin/crm/cold/<id>`   → one list, a keyset page of its rows, and the next
 *                            row worth ringing ("Dial next", `crm-shared.js:439`)
 *
 * Cold lists are a TEAM surface, not a personal one: the prototype's list
 * screen shows every list with its owner's name beside it, and a rep covering
 * for somebody on holiday has to be able to work their list. So there is no
 * per-rep scoping here — unlike the Calls screen, where `rep=` is director-only
 * because a call belongs to the person who made it.
 */

import { publicRoster } from "~/features/crm/reps";
import type { CrmUser } from "../../core/types";
import {
  COLD_ROWS_PAGE,
  type ColdListResponse,
  type ColdListsResponse,
  type ColdRowFilter,
} from "../contracts";
import { getColdList, listColdLists } from "../data/lists-db";
import { listColdRows, nextColdRow } from "../data/rows-db";
import { ColdListNotFoundError } from "./import";

/**
 * `Omit<…Response, "ok">` rather than a hand-written interface: a mapped type
 * carries the implicit index signature `withCrmRoute`'s `Record<string,
 * unknown>` return needs, and it can never drift from the wire contract.
 */
export type ColdListsBoard = Omit<ColdListsResponse, "ok">;

export interface ColdListsQuery {
  includeArchived?: boolean;
  ownerRepId?: string | null;
}

export async function loadColdListsBoard(
  _user: CrmUser,
  query: ColdListsQuery = {},
): Promise<ColdListsBoard> {
  const [lists, reps] = await Promise.all([
    listColdLists({ includeArchived: query.includeArchived, ownerRepId: query.ownerRepId ?? null }),
    publicRoster(),
  ]);
  return { lists, reps };
}

export type ColdListBoard = Omit<ColdListResponse, "ok">;

export interface ColdListQuery {
  filter?: ColdRowFilter;
  cursor?: string | null;
  limit?: number;
}

export async function loadColdListBoard(
  listId: string,
  query: ColdListQuery = {},
): Promise<ColdListBoard> {
  const list = await getColdList(listId);
  if (!list) throw new ColdListNotFoundError(listId);
  const [page, next, reps] = await Promise.all([
    listColdRows(listId, {
      filter: query.filter ?? "all",
      cursor: query.cursor ?? null,
      limit: query.limit ?? COLD_ROWS_PAGE,
    }),
    nextColdRow(listId),
    publicRoster(),
  ]);
  return { list, rows: page.rows, nextCursor: page.nextCursor, next, reps };
}
