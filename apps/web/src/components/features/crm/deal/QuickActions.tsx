"use client";

import { useRouter } from "next/navigation";
import type { LeadView } from "~/features/crm/leads/contracts";
import { ICON } from "../primitives/icon-props";
import { quickActionsFor, type QuickActionTarget } from "./actions";

/**
 * `quickActions(l)` (crm-shared.js:245): Call · Text · Email · Note · Snooze.
 *
 * The rail itself is dumb — every button comes from the slot registry in
 * `./actions.ts`, so C1 / C2 / C3 / B4 swap in the real rail by editing one
 * line there rather than this component. A slot with no target renders
 * disabled with its reason.
 *
 * TWO KINDS OF TARGET, and the difference matters (C1): a `href` hands the
 * device a `tel:` / `sms:` / `mailto:` and belongs in `location.assign`; a
 * `route` is a CRM path and goes through the router. Sending an in-app path
 * through `location.assign` reloads the application — cache gone, API token
 * re-minted, SSO gate re-run, the drawer the rep was in closed.
 */
export function QuickActions({ lead }: { lead: LeadView }) {
  const router = useRouter();
  const go = (target: QuickActionTarget) => {
    if (target.kind === "route") {
      router.push(target.href);
      return;
    }
    if (typeof window !== "undefined") window.location.assign(target.href);
  };
  return (
    <div className="quick">
      {quickActionsFor(lead).map(({ slot, target }) => (
        <button
          key={slot.id}
          type="button"
          disabled={!target}
          title={target ? undefined : slot.disabledTitle}
          onClick={target ? () => go(target) : undefined}
        >
          <slot.Icon {...ICON} />
          {slot.label}
        </button>
      ))}
    </div>
  );
}
