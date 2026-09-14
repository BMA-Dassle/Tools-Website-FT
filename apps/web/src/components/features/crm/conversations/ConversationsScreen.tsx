"use client";

import { IconMail, IconMessage } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { lazy, Suspense, useEffect, useMemo, useRef, type LazyExoticComponent } from "react";
import { CRM_BASE } from "~/features/crm/core/contracts";
import type { ScreenProps } from "~/features/crm/core/screens";
import { CONVERSATIONS_POLL_MS, THREAD_POLL_MS, smsKeys } from "~/features/crm/sms/queries";
import {
  SMS_TEST_IDS,
  type ConversationFolder,
  type ConversationRep,
} from "~/features/crm/sms/types";
import { errorMessage } from "../lib/crm-fetch";
import { useStatusIndex } from "../deal/use-deal";
import { useCrmFetch, useCrmUser } from "../lib/use-crm-user";
import { useUrlQuery } from "../lib/use-url-query";
import { Avatar } from "../primitives/Avatar";
import { Chip } from "../primitives/Chip";
import { Folders } from "../primitives/Folders";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { ThreadList } from "./ThreadList";
import {
  CONVERSATION_TABS,
  CONVERSATION_TAB_IDS,
  CONVERSATION_TAB_LABEL,
  activeConversationTab,
  tabCounts,
  type ConversationTabComponent,
  type ConversationTabId,
} from "./tabs";
import {
  conversationHref,
  convFromLine,
  displayName,
  filterConversations,
  folderOptions,
} from "./model";
import { fetchConversation, fetchConversations, postRead } from "./queries";

/**
 * `/admin/crm/conversations[/<key>]` (direction-b.html:113-119) — the split
 * from the prototype: folders and the person list on the left, the selected
 * conversation on the right, Text and Email tabs above it.
 *
 * ONE ENTRY PER PERSON, not per carrier thread: `key` is `c-<contactId>` or
 * `p-<digits>` (`sms/keys.ts`), so a guest who has texted two reps is one row
 * here and the server folds their threads together.
 *
 * At phone width the split becomes one column and shows the list OR the
 * conversation (`data-detail`), which is what the prototype's phone branch did
 * with a back arrow — the shell already draws the arrow from `BACK_HREF`.
 */

/** One lazy component per tab, created ONCE at module scope (never in render). */
const LAZY_TABS = Object.fromEntries(
  CONVERSATION_TAB_IDS.map((id) => [id, lazy(CONVERSATION_TABS[id])]),
) as Record<ConversationTabId, LazyExoticComponent<ConversationTabComponent>>;

export default function ConversationsScreen({ view, query }: ScreenProps) {
  const crmFetch = useCrmFetch();
  const qc = useQueryClient();
  const { isDirector } = useCrmUser();
  const statuses = useStatusIndex();
  const [urlQuery, setUrlQuery] = useUrlQuery(query);
  const readRef = useRef<string | null>(null);

  const selectedKey = view[0] ?? null;
  const folder = (urlQuery.folder as ConversationFolder) || "all";
  const teamWide = isDirector && urlQuery.all === "1";

  const list = useQuery({
    queryKey: smsKeys.conversations({ folder, all: teamWide ? "1" : "0" }),
    queryFn: () => fetchConversations(crmFetch, { folder, all: teamWide }),
    refetchInterval: CONVERSATIONS_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const detail = useQuery({
    queryKey: smsKeys.conversation(selectedKey ?? ""),
    queryFn: () => fetchConversation(crmFetch, selectedKey as string),
    enabled: selectedKey !== null,
    // The open conversation polls faster than the list beside it — it is the
    // thing being read, and an inbound reply that takes half a minute to appear
    // reads as a broken screen.
    refetchInterval: THREAD_POLL_MS,
    refetchIntervalInBackground: false,
  });

  // CANONICALISE THE URL. A deal links with the contact key when it knows the
  // contact, but a bookmark or an older link may name the number — and the list
  // keys a known contact as `c-<id>`. Once the detail resolves, the server has
  // told us which key this person really is; adopt it so the row on the left is
  // highlighted and the address bar matches what a rep would copy. `replace`,
  // never `push`: it is the same conversation, not a step in the history.
  const canonicalKey = detail.data?.summary.key ?? null;
  useEffect(() => {
    if (!selectedKey || !canonicalKey || canonicalKey === selectedKey) return;
    // Keep the query string: the folder and the tab live there (§3.1, "a link
    // is a saved view"), and swapping only the path would drop them.
    window.history.replaceState(
      null,
      "",
      `${conversationHref(canonicalKey)}${window.location.search}`,
    );
  }, [selectedKey, canonicalKey]);
  const activeKey = canonicalKey ?? selectedKey;

  // Opening a conversation clears its unread count. Once per key per mount:
  // the poll above re-runs the query every 30 s and a POST on each of those
  // would be a write loop.
  const unreadHere = detail.data?.summary.unread ?? 0;
  useEffect(() => {
    if (!selectedKey || unreadHere === 0) return;
    if (readRef.current === selectedKey) return;
    readRef.current = selectedKey;
    void postRead(crmFetch, selectedKey)
      .then(() => qc.invalidateQueries({ queryKey: smsKeys.all }))
      .catch(() => {
        // A failed read-receipt is cosmetic: the badge stays up and the next
        // open tries again.
        readRef.current = null;
      });
  }, [crmFetch, qc, selectedKey, unreadHere]);

  const conversations = useMemo(
    () => filterConversations(list.data?.conversations ?? [], folder),
    [list.data, folder],
  );
  const counts = tabCounts(detail.data ?? null);
  // Resolved AFTER the detail so it can fall back to the channel this person
  // actually uses; an explicit `?tab=` still wins.
  const tab = activeConversationTab(urlQuery, detail.data ?? null);
  const leadStatusId = detail.data?.summary.leadStatus ?? null;
  const leadStatus = leadStatusId ? (statuses.get(leadStatusId) ?? null) : null;
  const TabBody = LAZY_TABS[tab];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: smsKeys.all });
  };

  return (
    <div
      className="split conv-split"
      data-detail={selectedKey ? "1" : "0"}
      data-testid={SMS_TEST_IDS.conversations}
    >
      <div className="split-list" data-testid={SMS_TEST_IDS.threadList}>
        <Folders
          label="Conversation folders"
          options={folderOptions(list.data?.unread ?? 0).map((o) => ({
            value: o.value,
            label: o.label,
            ...(o.badge !== undefined ? { badge: o.badge } : {}),
          }))}
          value={folder}
          onChange={(next) => setUrlQuery({ folder: next === "all" ? null : next })}
        />
        {list.isPending ? <LoadingState label="Loading conversations…" /> : null}
        {list.isError ? (
          <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        ) : null}
        {list.data && conversations.length === 0 ? (
          <EmptyState icon={<IconMessage {...ICON} />}>{emptyFor(folder)}</EmptyState>
        ) : null}
        <ThreadList conversations={conversations} activeKey={activeKey} />
      </div>

      <div className="split-detail" style={{ padding: 0, gap: 0 }}>
        {!selectedKey ? (
          <EmptyState icon={<IconMessage {...ICON} />}>
            Pick someone on the left to see the conversation.
          </EmptyState>
        ) : null}
        {selectedKey && detail.isPending ? <LoadingState label="Loading the thread…" /> : null}
        {selectedKey && detail.isError ? (
          <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
        ) : null}
        {selectedKey && detail.data ? (
          <>
            {/* The prototype's header, in its order (direction-b.html:119):
                rep avatar · name · number · status chip · Open deal. The avatar
                is whose conversation this is — the only thing that says so on a
                director's team-wide view — and the chip is where the deal has
                got to, so a rep can answer without opening it. */}
            <div className="card-h" style={{ background: "var(--card)" }}>
              <ConversationRepAvatar rep={detail.data.summary.reps[0] ?? null} />
              <h2>{displayName(detail.data.summary)}</h2>
              <span className="muted small">{detail.data.summary.phoneE164}</span>
              <div className="right">
                {leadStatus ? (
                  <Chip kind={leadStatus.kind} st={leadStatus.id}>
                    {leadStatus.label}
                  </Chip>
                ) : null}
                {detail.data.summary.leadPublicId ? (
                  <Link
                    className="btn btn-sm"
                    href={`${CRM_BASE}/deal/${detail.data.summary.leadPublicId}`}
                  >
                    Open deal
                  </Link>
                ) : null}
              </div>
            </div>

            {/* Toggle buttons, not ARIA tabs: the CRM's own `.folders` / `.seg`
                controls use `aria-pressed` and the prototype's CSS keys off it
                (`crm-core.css` `.conv-tabs button[aria-pressed="true"]`). A
                real tablist would also owe us `role="tabpanel"` and roving
                focus for a control that is really two filters. */}
            <div className="conv-tabs" role="group" aria-label="Conversation channels">
              {CONVERSATION_TAB_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={id === tab}
                  data-testid={SMS_TEST_IDS.convTab(id)}
                  onClick={() => setUrlQuery({ tab: id === "sms" ? null : id })}
                >
                  {id === "sms" ? <IconMessage {...ICON} /> : <IconMail {...ICON} />}
                  {CONVERSATION_TAB_LABEL[id]} <span className="n">{counts[id]}</span>
                </button>
              ))}
              <span className="conv-from">
                {convFromLine(detail.data.summary.phoneE164, detail.data.myDid)}
              </span>
            </div>

            <Suspense fallback={<LoadingState />}>
              <TabBody detail={detail.data} refresh={refresh} />
            </Suspense>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** `U.repAvatar(l.rep)` in the header — whose conversation this is. */
function ConversationRepAvatar({ rep }: { rep: ConversationRep | null }) {
  if (!rep) return null;
  return <Avatar initials={rep.initials} repSlug={rep.slug} name={rep.name} />;
}

function emptyFor(folder: ConversationFolder): string {
  if (folder === "unread") return "Nothing unread.";
  if (folder === "email") return "No email yet. Email a guest from their deal to start one.";
  return "No conversations yet. Text a guest from their deal to start one.";
}
