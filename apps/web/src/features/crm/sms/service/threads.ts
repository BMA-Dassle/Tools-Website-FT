/**
 * ONE ENTRY PER PERSON — the fold from carrier threads to the Conversations
 * screen (owner's shape: one row per person, Text and Email tabs).
 *
 * `crm_sms_threads` is keyed by (rep DID, guest number) because that is all a
 * carrier gives us. A guest who has texted Kelsea and Lori therefore has two
 * rows, and a rep who looks at "Dana Whitfield" wants ONE conversation. The
 * fold is by contact id when we know the person and by number when we do not
 * — never by name, which is not unique and not a key.
 *
 * `foldConversations` is PURE and carries the whole rule; the loaders below
 * are the Neon plumbing around it (one query per collection, never per row).
 *
 * Paging is keyset on `last_message_at` at the THREAD grain (R10), and the
 * cursor is the oldest `last_message_at` in the page. Folding can therefore
 * shorten a page — two threads of one person collapse into one row — which is
 * correct: the cursor still advances monotonically and nothing is skipped.
 */

import type { CrmRep } from "../../core/types";
import {
  hasInboundFrom,
  lastMessagePerThread,
  listMessagesForThreads,
  MESSAGE_PAGE_MAX,
} from "../data/messages-db";
import {
  contactsByIds,
  contactsByPhones,
  contactById,
  contactByPhone,
  leadById,
  leadForContact,
  leadsByContactIds,
} from "../data/links-db";
import {
  listThreads,
  markThreadsRead,
  threadsForContact,
  threadsForGuest,
  unreadTotal,
} from "../data/threads-db";
import { contactKey, e164FromDigits, parseConversationKey, phoneKey } from "../keys";
import type {
  ConversationDetail,
  ConversationSummary,
  LinkedContact,
  LinkedLead,
  SmsMessage,
  SmsThread,
} from "../types";
import { consentFor } from "./consent";

export interface FoldInput {
  threads: readonly SmsThread[];
  lastByThread: ReadonlyMap<string, SmsMessage>;
  contactsById: ReadonlyMap<string, LinkedContact>;
  contactsByPhone: ReadonlyMap<string, LinkedContact>;
  leadsByContact: ReadonlyMap<string, LinkedLead>;
  repsById: ReadonlyMap<string, CrmRep>;
}

function fullName(c: LinkedContact | null): string | null {
  if (!c) return null;
  const name = `${c.firstName} ${c.lastName}`.trim();
  return name || null;
}

/** `leadTitle(l)` (crm-shared.js:83): the business if there is one, else the person. */
function captionFor(contact: LinkedContact | null, name: string | null): string | null {
  return contact?.accountName || name;
}

/**
 * Fold a page of threads into one entry per person, newest activity first.
 * PURE — every lookup is a map the caller filled.
 */
export function foldConversations(input: FoldInput): ConversationSummary[] {
  const byKey = new Map<string, ConversationSummary>();

  for (const t of input.threads) {
    const contact =
      (t.contactId ? input.contactsById.get(t.contactId) : null) ??
      input.contactsByPhone.get(t.guestE164) ??
      null;
    const key = contact ? contactKey(contact.id) : phoneKey(t.guestE164);
    const last = input.lastByThread.get(t.id) ?? null;
    const lead = contact ? (input.leadsByContact.get(contact.id) ?? null) : null;
    const rep = t.repId ? (input.repsById.get(t.repId) ?? null) : null;
    const name = fullName(contact);

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        contactId: contact?.id ?? null,
        name,
        phoneE164: t.guestE164,
        leadId: lead?.id ?? null,
        leadPublicId: lead?.publicId ?? null,
        leadStatus: lead?.statusId ?? null,
        leadTitle: captionFor(contact, name),
        repSlugs: rep ? [rep.slug] : [],
        threadIds: [t.id],
        lastMessageAt: t.lastMessageAt,
        lastBody: last?.body ?? null,
        lastDirection: last?.direction ?? null,
        unread: t.unreadCount,
        stopped: t.stoppedAt !== null,
      });
      continue;
    }

    existing.threadIds.push(t.id);
    if (rep && !existing.repSlugs.includes(rep.slug)) existing.repSlugs.push(rep.slug);
    existing.unread += t.unreadCount;
    existing.stopped = existing.stopped || t.stoppedAt !== null;
    const newer =
      t.lastMessageAt !== null &&
      (existing.lastMessageAt === null || t.lastMessageAt > existing.lastMessageAt);
    if (newer) {
      existing.lastMessageAt = t.lastMessageAt;
      existing.lastBody = last?.body ?? existing.lastBody;
      existing.lastDirection = last?.direction ?? existing.lastDirection;
    }
  }

  return [...byKey.values()].sort((a, b) =>
    (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""),
  );
}

export interface ConversationsPage {
  conversations: ConversationSummary[];
  nextCursor: string | null;
  unread: number;
}

export interface LoadConversationsInput {
  /** A rep sees their own threads; a director may pass null and see the team. */
  repId: string | null;
  reps: readonly CrmRep[];
  limit?: number;
  cursor?: string | null;
  unreadOnly?: boolean;
}

/** The Conversations list: one page of threads, folded. */
export async function loadConversations(input: LoadConversationsInput): Promise<ConversationsPage> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, MESSAGE_PAGE_MAX));
  const threads = await listThreads({
    repId: input.repId,
    limit,
    before: input.cursor ?? null,
    unreadOnly: input.unreadOnly,
  });
  const page = await hydrate(threads, input.reps);
  const oldest =
    threads.length === limit ? (threads[threads.length - 1]?.lastMessageAt ?? null) : null;
  return {
    conversations: page,
    nextCursor: oldest,
    unread: await unreadTotal(input.repId),
  };
}

async function hydrate(
  threads: readonly SmsThread[],
  reps: readonly CrmRep[],
): Promise<ConversationSummary[]> {
  const threadIds = threads.map((t) => t.id);
  const contactIds = [...new Set(threads.map((t) => t.contactId).filter((v): v is string => !!v))];
  const phones = [...new Set(threads.map((t) => t.guestE164))];
  const [lastByThread, byId, byPhone] = await Promise.all([
    lastMessagePerThread(threadIds),
    contactsByIds(contactIds),
    contactsByPhones(phones),
  ]);
  const allContactIds = [...new Set([...contactIds, ...[...byPhone.values()].map((c) => c.id)])];
  const leadsByContact = await leadsByContactIds(allContactIds);
  return foldConversations({
    threads,
    lastByThread,
    contactsById: byId,
    contactsByPhone: byPhone,
    leadsByContact,
    repsById: new Map(reps.map((r) => [r.id, r])),
  });
}

export interface LoadConversationInput {
  key: string;
  /** The signed-in person's rep row; null for a director with none. */
  rep: CrmRep | null;
  reps: readonly CrmRep[];
  smsEnabled: boolean;
  limit?: number;
  cursor?: string | null;
}

export class UnknownConversationError extends Error {
  constructor(key: string) {
    super(`unknown conversation ${key}`);
    this.name = "UnknownConversationError";
  }
}

/**
 * One person's conversation: every thread they have, every message across
 * those threads, and what this rep may do about it.
 */
export async function loadConversation(input: LoadConversationInput): Promise<ConversationDetail> {
  const parsed = parseConversationKey(input.key);
  if (!parsed) throw new UnknownConversationError(input.key);

  let contact: LinkedContact | null = null;
  let threads: SmsThread[] = [];
  let phone: string | null = null;

  if (parsed.kind === "contact") {
    contact = await contactById(parsed.contactId);
    if (!contact) throw new UnknownConversationError(input.key);
    phone = contact.phoneE164;
    threads = await threadsForContact(contact.id);
    if (threads.length === 0 && phone) threads = await threadsForGuest(phone);
  } else {
    phone = e164FromDigits(parsed.digits);
    if (!phone) throw new UnknownConversationError(input.key);
    threads = await threadsForGuest(phone);
    contact = await contactByPhone(phone);
  }
  if (!phone) phone = threads[0]?.guestE164 ?? null;
  if (!phone) throw new UnknownConversationError(input.key);

  const lead: LinkedLead | null = contact
    ? await leadForContact(contact.id)
    : threads[0]?.leadId
      ? await leadById(threads[0].leadId)
      : null;

  const threadIds = threads.map((t) => t.id);
  const [lastByThread, messages, hasInbound] = await Promise.all([
    lastMessagePerThread(threadIds),
    listMessagesForThreads(threadIds, { limit: input.limit ?? 50, before: input.cursor ?? null }),
    hasInboundFrom(threadIds),
  ]);

  const summaries = foldConversations({
    threads,
    lastByThread,
    contactsById: contact ? new Map([[contact.id, contact]]) : new Map(),
    contactsByPhone: contact && phone ? new Map([[phone, contact]]) : new Map(),
    leadsByContact: contact && lead ? new Map([[contact.id, lead]]) : new Map(),
    repsById: new Map(input.reps.map((r) => [r.id, r])),
  });

  const summary: ConversationSummary = summaries[0] ?? {
    key: input.key,
    contactId: contact?.id ?? null,
    name: fullName(contact),
    phoneE164: phone,
    leadId: lead?.id ?? null,
    leadPublicId: lead?.publicId ?? null,
    leadStatus: lead?.statusId ?? null,
    leadTitle: captionFor(contact, fullName(contact)),
    repSlugs: [],
    threadIds: [],
    lastMessageAt: null,
    lastBody: null,
    lastDirection: null,
    unread: 0,
    stopped: false,
  };

  const myThread = input.rep ? (threads.find((t) => t.repId === input.rep!.id) ?? null) : null;
  const consent = consentFor({
    lead,
    hasInbound,
    stopped: myThread?.stoppedAt != null,
    repDid: input.rep?.voxDid ?? null,
    smsEnabled: input.smsEnabled,
    hasRep: input.rep !== null,
  });

  const oldest = messages.length > 0 ? messages[messages.length - 1].occurredAt : null;
  return {
    summary,
    // Oldest first: a thread reads downwards, and the composer sits at the end.
    messages: [...messages].reverse(),
    nextCursor: messages.length === (input.limit ?? 50) ? oldest : null,
    myDid: input.rep?.voxDid ?? null,
    myThreadId: myThread?.id ?? null,
    consent,
    contact,
    lead,
  };
}

/** The rep opened this person's conversation: clear their unread counts. */
export async function markConversationRead(
  key: string,
  rep: CrmRep | null,
): Promise<{ unread: number }> {
  const parsed = parseConversationKey(key);
  if (!parsed) throw new UnknownConversationError(key);
  let threads: SmsThread[] = [];
  if (parsed.kind === "contact") {
    threads = await threadsForContact(parsed.contactId);
    if (threads.length === 0) {
      const contact = await contactById(parsed.contactId);
      if (contact?.phoneE164) threads = await threadsForGuest(contact.phoneE164);
    }
  } else {
    const phone = e164FromDigits(parsed.digits);
    if (phone) threads = await threadsForGuest(phone);
  }
  // A rep clears their OWN unread; a director reading over a shoulder does not
  // mark someone else's conversation as read for them.
  const mine = rep ? threads.filter((t) => t.repId === rep.id) : threads;
  await markThreadsRead(mine.map((t) => t.id));
  return { unread: await unreadTotal(rep?.id ?? null) };
}
