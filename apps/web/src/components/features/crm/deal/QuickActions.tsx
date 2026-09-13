"use client";

import { Suspense, lazy, useMemo, type ComponentType, type LazyExoticComponent } from "react";
import type { LeadView } from "~/features/crm/leads/contracts";
import { useCrmSheet } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { LoadingState } from "../primitives/States";
import {
  QUICK_ACTION_IDS,
  QUICK_ACTION_SHEETS,
  quickActionsFor,
  type QuickActionId,
  type QuickActionSheetProps,
} from "./actions";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 *
 * The rail itself is dumb — every button comes from the slot registry in
 * `./actions.ts`, so C1 / C2 / C3 / B4 swap in the real rail by editing one
 * line there rather than this component. A slot resolves to a device hand-off
 * (`tel:` / `sms:` / `mailto:`), to one of the registry's own sheets, or to
 * null, which renders the button disabled with its reason.
 *
 * `QUICK_ACTION_SHEETS` is empty today, so every button behaves exactly as it
 * did before this component learned to open sheets; the four PRs that own the
 * five slots add their key and get the sheet for free.
 */

/** One lazy component per registered sheet, created ONCE at module scope. */
const LAZY_SHEETS = Object.fromEntries(
  QUICK_ACTION_IDS.filter((id) => QUICK_ACTION_SHEETS[id]).map((id) => [
    id,
    lazy(QUICK_ACTION_SHEETS[id]!.load),
  ]),
) as Partial<Record<QuickActionId, LazyExoticComponent<ComponentType<QuickActionSheetProps>>>>;

export interface QuickActionsProps {
  lead: LeadView;
  /** Re-read the deal after a sheet changed something. */
  onDone?: () => void;
}

export function QuickActions({ lead, onDone }: QuickActionsProps) {
  const { openSheet, closeSheet } = useCrmSheet();
  const actions = useMemo(() => quickActionsFor(lead), [lead]);

  const go = (href: string) => {
    if (typeof window !== "undefined") window.location.assign(href);
  };

  const open = (id: QuickActionId) => {
    const slot = QUICK_ACTION_SHEETS[id];
    const Body = LAZY_SHEETS[id];
    if (!slot || !Body) return;
    openSheet({
      title: slot.title(lead),
      wide: slot.wide,
      testId: slot.testId,
      body: (
        <Suspense fallback={<LoadingState />}>
          <Body
            lead={lead}
            onCancel={closeSheet}
            onDone={() => {
              closeSheet();
              onDone?.();
            }}
          />
        </Suspense>
      ),
    });
  };

  return (
    <div className="quick">
      {actions.map(({ slot, target }) => (
        <button
          key={slot.id}
          type="button"
          disabled={!target}
          title={target ? undefined : slot.disabledTitle}
          onClick={
            target ? () => (target.kind === "href" ? go(target.href) : open(target.id)) : undefined
          }
        >
          <slot.Icon {...ICON} />
          {slot.label}
        </button>
      ))}
    </div>
  );
}
