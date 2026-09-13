"use client";

import { useRouter } from "next/navigation";
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
  type QuickActionTarget,
} from "./actions";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 *
 * The rail itself is dumb — every button comes from the slot registry in
 * `./actions.ts`, so C1 / C2 / C3 / B4 swap in the real rail by editing one
 * line there rather than this component. A slot with no target renders
 * disabled with its reason.
 *
 * THREE KINDS OF TARGET, and the differences matter:
 *
 *   href   a device hand-off — `tel:` / `mailto:` — which belongs in
 *          `location.assign`.
 *   route  (C1) a CRM path, which goes through the router. Sending an in-app
 *          path through `location.assign` reloads the application — cache
 *          gone, API token re-minted, SSO gate re-run, the drawer the rep was
 *          standing in closed.
 *   sheet  (C2/C3) one of the registry's own sheets, opened over the drawer.
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
  const router = useRouter();
  const { openSheet, closeSheet } = useCrmSheet();
  const actions = useMemo(() => quickActionsFor(lead), [lead]);

  const go = (target: QuickActionTarget) => {
    if (target.kind === "route") {
      router.push(target.href);
      return;
    }
    if (target.kind === "href" && typeof window !== "undefined") {
      window.location.assign(target.href);
    }
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
            target ? () => (target.kind === "sheet" ? open(target.id) : go(target)) : undefined
          }
        >
          <slot.Icon {...ICON} />
          {slot.label}
        </button>
      ))}
    </div>
  );
}
