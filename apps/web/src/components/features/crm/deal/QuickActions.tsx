"use client";

import { Suspense, lazy, useMemo } from "react";
import type { LeadView } from "~/features/crm/leads/contracts";
import { useCrmSheet } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { LoadingState } from "../primitives/States";
import { leadName } from "../leads/model";
import {
  QUICK_ACTION_SHEETS,
  QUICK_ACTION_SHEET_TITLE,
  quickActionsFor,
  type QuickActionId,
} from "./actions";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 *
 * The rail itself is dumb — every button comes from the slot registry in
 * `./actions.ts`, so C1 / C2 / B4 swap in the real rail by editing one line
 * there rather than this component. A slot with no target renders disabled with
 * its reason; a `{kind:"sheet"}` slot opens its registered sheet in the shell's
 * root sheet (a sibling of the board, so no ancestor `transform` can trap it —
 * lesson 175-222).
 */
export function QuickActions({ lead }: { lead: LeadView }) {
  const { openSheet, closeSheet } = useCrmSheet();

  // Lazy per id, memoised so the same slot is not re-created on every render
  // (a fresh `lazy()` each time remounts the sheet and loses its draft).
  const lazySheets = useMemo(
    () =>
      new Map(
        Object.entries(QUICK_ACTION_SHEETS).map(([id, loader]) => [
          id as QuickActionId,
          lazy(loader),
        ]),
      ),
    [],
  );

  const go = (href: string) => {
    if (typeof window !== "undefined") window.location.assign(href);
  };

  const open = (id: QuickActionId) => {
    const Body = lazySheets.get(id);
    if (!Body) return;
    const title = QUICK_ACTION_SHEET_TITLE[id]?.(leadName(lead)) ?? leadName(lead);
    openSheet({
      title,
      wide: true,
      testId: `crm-deal-action-${id}`,
      body: (
        <Suspense fallback={<LoadingState label="Opening…" />}>
          <Body lead={lead} onDone={closeSheet} />
        </Suspense>
      ),
    });
  };

  return (
    <div className="quick">
      {quickActionsFor(lead).map(({ slot, target }) => {
        const usable = target && (target.kind === "href" || lazySheets.has(slot.id));
        return (
          <button
            key={slot.id}
            type="button"
            disabled={!usable}
            title={usable ? undefined : slot.disabledTitle}
            onClick={
              usable && target
                ? () => (target.kind === "href" ? go(target.href) : open(slot.id))
                : undefined
            }
          >
            <slot.Icon {...ICON} />
            {slot.label}
          </button>
        );
      })}
    </div>
  );
}
