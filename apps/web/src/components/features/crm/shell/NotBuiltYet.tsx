"use client";

import { TEST_IDS } from "~/features/crm/core/contracts";
import { SCREEN_META } from "~/features/crm/core/nav";
import type { ScreenProps } from "~/features/crm/core/screens";

/**
 * The body every screen shows until its own PR lands: the prototype's title and
 * one-line description (`SCREEN_META`, ported from direction-b.html and
 * crm-shared.js by the contract stage), and nothing that pretends to be data.
 *
 * `core/screens.ts` points every id here in PR1; a feature PR replaces its own
 * line there, and this component keeps serving the rest.
 */
export default function NotBuiltYet({ screen }: ScreenProps) {
  const meta = SCREEN_META[screen];
  return (
    <div className="card" data-testid={TEST_IDS.notBuilt} style={{ maxWidth: 640 }}>
      <div className="pad stack">
        <div className="eyebrow">Coming in a later PR</div>
        <h2 style={{ fontSize: 16 }}>{meta.title}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {meta.description}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Not built yet — this screen arrives in a later PR.
        </p>
      </div>
    </div>
  );
}
