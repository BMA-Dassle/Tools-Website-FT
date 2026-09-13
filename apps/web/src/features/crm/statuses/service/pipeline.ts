/**
 * `loadPipeline()` — what `GET /api/admin/crm/pipeline` answers.
 *
 * Reads the board's three inputs (statuses, reps, one keyset page of leads)
 * and hands them to the pure `buildBoard`. A REP sees their own leads; a
 * DIRECTOR sees the team's, and may group them by rep (`?by=rep`).
 *
 * The page is capped at `PIPELINE_LEAD_LIMIT` (R10: keyset, `limit ≤ 200`).
 * A board is a glance, not an archive — when there are more open leads than
 * that, `truncated` is true and the screen says so rather than quietly showing
 * a short column. The filters (centre, search) narrow the read itself, so
 * narrowing is how a busy month is made legible.
 */

import { publicRoster } from "~/features/crm/reps";
import { listLeads } from "~/features/crm/leads";
import type { CentreCode } from "../../core/types";
import { listStatuses } from "../data/statuses-db";
import { PIPELINE_LEAD_LIMIT } from "../contracts";
import { buildBoard, type BoardView } from "./board";

export interface LoadPipelineInput {
  /**
   * "mine" = only `repId`'s leads — and when `repId` is null (a signed-in
   * salesperson who has no `crm_reps` row yet) that means NO leads, never
   * everyone's. A missing rep row must not widen the scope.
   */
  scope: "mine" | "team";
  repId: string | null;
  byRep: boolean;
  centre?: CentreCode;
  q?: string;
  now?: Date;
}

export interface PipelineData extends BoardView {
  statuses: Awaited<ReturnType<typeof listStatuses>>;
  reps: Awaited<ReturnType<typeof publicRoster>>;
  byRep: boolean;
  truncated: boolean;
}

export interface PipelineDeps {
  listStatuses: typeof listStatuses;
  listLeads: typeof listLeads;
  publicRoster: typeof publicRoster;
}

export function defaultPipelineDeps(): PipelineDeps {
  return { listStatuses, listLeads, publicRoster };
}

export async function loadPipeline(
  input: LoadPipelineInput,
  deps: PipelineDeps = defaultPipelineDeps(),
): Promise<PipelineData> {
  const ownerless = input.scope === "mine" && !input.repId;
  const [statuses, reps, page] = await Promise.all([
    deps.listStatuses(),
    deps.publicRoster(),
    ownerless
      ? Promise.resolve({ leads: [], nextCursor: null })
      : deps.listLeads({
          limit: PIPELINE_LEAD_LIMIT,
          repId: input.repId ?? undefined,
          centre: input.centre,
          q: input.q,
        }),
  ]);
  const board = buildBoard({
    leads: page.leads,
    statuses,
    reps,
    byRep: input.byRep,
    now: input.now ?? new Date(),
  });
  return {
    ...board,
    statuses,
    reps,
    byRep: input.byRep,
    truncated: page.nextCursor !== null,
  };
}
