/**
 * The two reads behind the Email tab: one lead's messages, and the thread list
 * (one row per lead, newest first).
 *
 * Keyset only, `limit ≤ 200` (R10) — the cursor is the previous page's last
 * `(at, id)` pair, encoded opaquely so a client cannot turn it into an OFFSET.
 * A rep sees their own mailbox's rows; a director sees everything.
 */

import { getLead } from "../../leads";
import type { CrmUser } from "../../core/types";
import { isDirector } from "../../core/identity";
import type { EmailMessageView, EmailThreadView } from "../contracts";
import { listEmailThreads, listLeadEmails } from "../data/email-links-db";
import { toMessageView } from "./view";

/** `<at>|<id>` ⇄ base64url, the same shape B3 uses for leads. */
export function encodeEmailCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeEmailCursor(cursor: string | null | undefined): {
  at: string;
  id: string;
} | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const bar = raw.lastIndexOf("|");
    if (bar <= 0) return null;
    const at = raw.slice(0, bar);
    const id = raw.slice(bar + 1);
    if (!/^\d{1,18}$/.test(id) || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export interface LeadEmailsResult {
  messages: EmailMessageView[];
  nextCursor: string | null;
}

/** Newest first — the prototype sorts the Email tab descending (crm-shared.js:325). */
export async function leadEmails(
  leadId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<LeadEmailsResult> {
  const cur = decodeEmailCursor(opts.cursor);
  const page = await listLeadEmails(leadId, {
    limit: opts.limit,
    before: cur ? { sentAt: cur.at, id: cur.id } : null,
  });
  return {
    messages: page.items.map(toMessageView),
    nextCursor: page.nextCursor
      ? encodeEmailCursor(page.nextCursor.sentAt, page.nextCursor.id)
      : null,
  };
}

export interface EmailThreadsResult {
  threads: EmailThreadView[];
  nextCursor: string | null;
}

/**
 * One row per lead. The lead's name and address come from B3's `getLead`, one
 * read per row on a page of at most 200 — the alternative is a join into
 * `crm_leads`/`crm_contacts` from this sub's data file, which would make the
 * email sub a second reader of B3's tables.
 */
export async function emailThreads(
  user: CrmUser,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<EmailThreadsResult> {
  const cur = decodeEmailCursor(opts.cursor);
  const repId = isDirector(user) ? null : (user.rep?.id ?? null);
  // A rep with no rep row would otherwise see every thread: give them none.
  if (!isDirector(user) && !repId) return { threads: [], nextCursor: null };
  const page = await listEmailThreads({
    repId,
    limit: opts.limit,
    before: cur ? { lastAt: cur.at, leadId: cur.id } : null,
  });
  const threads: EmailThreadView[] = [];
  for (const row of page.items) {
    const lead = await getLead(row.leadId);
    threads.push({
      leadId: row.leadId,
      leadPublicId: lead?.publicId ?? null,
      guestName: lead ? `${lead.guest.first} ${lead.guest.last}`.trim() : null,
      guestEmail: lead?.guest.email ?? null,
      lastAt: row.lastAt,
      count: row.count,
      last: toMessageView(row.last),
    });
  }
  return {
    threads,
    nextCursor: page.nextCursor
      ? encodeEmailCursor(page.nextCursor.lastAt, page.nextCursor.leadId)
      : null,
  };
}
