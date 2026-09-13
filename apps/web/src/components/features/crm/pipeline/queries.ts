import type { PipelineResponse } from "~/features/crm/statuses/contracts";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * The board's one read. Keys live in `~/features/crm/statuses/queries`
 * (`pipelineKeys`); the status mutation lives in `../deal/queries`, because
 * the drawer over the board and the deal page use the same one.
 */
export const fetchPipeline = (f: CrmFetch, params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return f<PipelineResponse>(`/pipeline${qs ? `?${qs}` : ""}`);
};
