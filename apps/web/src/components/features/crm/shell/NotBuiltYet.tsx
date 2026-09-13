"use client";

import { TEST_IDS } from "~/features/crm/core/contracts";
import { SCREEN_META } from "~/features/crm/core/nav";
import type { ScreenProps } from "~/features/crm/core/screens";

/**
 * The body every screen shows until its own PR lands: the prototype's title and
 * one-line description, and nothing that pretends to be data.
 *
 * `core/screens.ts` points every id here in PR1; a feature PR replaces its own
 * line there, and this component keeps serving the rest.
 */
export default function NotBuiltYet({ screen }: ScreenProps) {
  const meta = SCREEN_META[screen];
  return (
    <div data-testid={TEST_IDS.notBuilt} style={{ maxWidth: 560 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>{meta.title}</h2>
      <p style={{ margin: "0 0 12px", color: "var(--ba-muted)" }}>{meta.description}</p>
      <p style={{ margin: 0 }}>Not built yet — this screen arrives in a later PR.</p>
    </div>
  );
}
