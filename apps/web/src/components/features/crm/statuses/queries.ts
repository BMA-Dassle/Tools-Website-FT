import type {
  JobsRunBody,
  JobsRunResponse,
  OfficeStatesResponse,
  SettingsPostBody,
  SettingsResponse,
  StatusesMapPostBody,
  StatusesMapPostResponse,
  StatusesPostBody,
  StatusesPostResponse,
  StatusesResponse,
} from "~/features/crm/core/contracts";
import type { CentreCode } from "~/features/crm/core/types";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * React Query keys and fetchers for the Statuses screen (brief §3.4: keys are
 * `["crm", <sub>, …]` tuples; mutations invalidate the sub's root key).
 */
export const statusesKeys = {
  all: ["crm", "statuses"] as const,
  list: () => ["crm", "statuses", "list"] as const,
  officeStates: (centre: CentreCode) => ["crm", "statuses", "office-states", centre] as const,
};

export const settingsKeys = {
  all: ["crm", "settings"] as const,
};

export const fetchStatuses = (f: CrmFetch) => f<StatusesResponse>("/statuses");

export const fetchSettings = (f: CrmFetch) => f<SettingsResponse>("/settings");

export const fetchOfficeStates = (f: CrmFetch, centre: CentreCode) =>
  f<OfficeStatesResponse>(`/statuses/office-states?centre=${encodeURIComponent(centre)}`);

export const postStatuses = (f: CrmFetch, body: StatusesPostBody) =>
  f<StatusesPostResponse>("/statuses", { body: { ...body } });

export const postStatusMap = (f: CrmFetch, body: StatusesMapPostBody) =>
  f<StatusesMapPostResponse>("/statuses/map", { body: { ...body } });

export const postSetting = (f: CrmFetch, body: SettingsPostBody) =>
  f<SettingsResponse>("/settings", { body: { ...body } });

export const runJob = (f: CrmFetch, body: JobsRunBody) =>
  f<JobsRunResponse>("/jobs/run", { body: { ...body } });
