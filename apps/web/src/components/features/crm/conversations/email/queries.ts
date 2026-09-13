/**
 * The email tab's transport — `crmFetch` calls only, no React, so the
 * composer and the thread can be tested apart from the network.
 */

import type {
  EmailContextResponse,
  EmailSendBody,
  EmailSendResponse,
  EmailThreadsResponse,
} from "~/features/crm/email/contracts";
import type { CrmFetch } from "../../lib/crm-fetch";

export function fetchEmailContext(
  crmFetch: CrmFetch,
  leadId: string,
  opts: { cursor?: string | null } = {},
): Promise<EmailContextResponse> {
  const qs = new URLSearchParams({ leadId });
  if (opts.cursor) qs.set("cursor", opts.cursor);
  return crmFetch<EmailContextResponse>(`/email?${qs.toString()}`);
}

export function fetchEmailThreads(
  crmFetch: CrmFetch,
  opts: { cursor?: string | null } = {},
): Promise<EmailThreadsResponse> {
  const qs = new URLSearchParams();
  if (opts.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString();
  return crmFetch<EmailThreadsResponse>(`/email/threads${suffix ? `?${suffix}` : ""}`);
}

export function postEmail(crmFetch: CrmFetch, body: EmailSendBody): Promise<EmailSendResponse> {
  return crmFetch<EmailSendResponse>("/email", {
    method: "POST",
    body: body as unknown as Record<string, unknown>,
  });
}
