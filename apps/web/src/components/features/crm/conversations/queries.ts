"use client";

import type {
  TemplatesResponse,
  ThreadDetailResponse,
  ThreadReadResponse,
  ThreadSendResponse,
  ThreadsListResponse,
} from "~/features/crm/sms/types";
import type { CrmFetch } from "../lib/crm-fetch";

/**
 * The Conversations screen's calls. Thin wrappers so the components never
 * build a path or a body by hand and the query keys (`sms/queries.ts`) stay
 * the only other place that knows about `/sms`.
 */

export function fetchConversations(
  crmFetch: CrmFetch,
  params: { cursor?: string | null; folder?: string; all?: boolean } = {},
): Promise<ThreadsListResponse> {
  const qs = new URLSearchParams();
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.folder) qs.set("folder", params.folder);
  if (params.all) qs.set("all", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return crmFetch<ThreadsListResponse>(`/sms/threads${suffix}`);
}

export function fetchConversation(
  crmFetch: CrmFetch,
  key: string,
  cursor: string | null = null,
): Promise<ThreadDetailResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return crmFetch<ThreadDetailResponse>(`/sms/threads/${key}${qs}`);
}

export function postSend(
  crmFetch: CrmFetch,
  key: string,
  body: { body: string; templateId?: string | null; leadId?: string | null },
): Promise<ThreadSendResponse> {
  return crmFetch<ThreadSendResponse>(`/sms/threads/${key}`, {
    method: "POST",
    body: { action: "send", ...body },
  });
}

export function postRead(crmFetch: CrmFetch, key: string): Promise<ThreadReadResponse> {
  return crmFetch<ThreadReadResponse>(`/sms/threads/${key}`, {
    method: "POST",
    body: { action: "read" },
  });
}

export function fetchTemplates(
  crmFetch: CrmFetch,
  params: { kind: "sms" | "email"; key?: string | null },
): Promise<TemplatesResponse> {
  const qs = new URLSearchParams({ kind: params.kind });
  if (params.key) qs.set("key", params.key);
  return crmFetch<TemplatesResponse>(`/templates?${qs.toString()}`);
}
