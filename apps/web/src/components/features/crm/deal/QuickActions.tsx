"use client";

import type { LeadView } from "~/features/crm/leads/contracts";
import { ICON } from "../primitives/icon-props";
import { quickActionsFor, type QuickActionSheet } from "./actions";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 *
 * The rail itself is dumb — every button comes from the slot registry in
 * `./actions.ts`, so C1 / C2 / C3 swap in the real channel by editing one line
 * there rather than this component. A slot with no target renders disabled
 * with its reason; a slot that opens one of our own sheets calls `onSheet`.
 */
export function QuickActions({
  lead,
  onSheet,
}: {
  lead: LeadView;
  onSheet: (sheet: QuickActionSheet) => void;
}) {
  const go = (href: string) => {
    if (typeof window !== "undefined") window.location.assign(href);
  };
  return (
    <div className="quick">
      {quickActionsFor(lead).map(({ slot, target }) => (
        <button
          key={slot.id}
          type="button"
          disabled={!target}
          title={target ? undefined : slot.disabledTitle}
          onClick={
            target
              ? () => (target.kind === "href" ? go(target.href) : onSheet(target.sheet))
              : undefined
          }
        >
          <slot.Icon {...ICON} />
          {slot.label}
        </button>
      ))}
    </div>
  );
}
