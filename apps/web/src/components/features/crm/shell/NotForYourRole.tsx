"use client";

import Link from "next/link";
import { CRM_BASE, TEST_IDS } from "~/features/crm/core/contracts";
import { SCREEN_META } from "~/features/crm/core/nav";
import type { ScreenId } from "~/features/crm/core/types";

/**
 * A rep typed a director-only URL (queue, rules, statuses, goals). Rendered
 * IN-APP with HTTP 200 — never Next's 404, which would make a typo and a
 * permission problem look the same (brief §3.10 crm-signin proof).
 */
export function NotForYourRole({ screen }: { screen: ScreenId }) {
  return (
    <div className="card" data-testid={TEST_IDS.notForRole} style={{ maxWidth: 640 }}>
      <div className="pad stack">
        <div className="eyebrow">Not for your role</div>
        <h2 style={{ fontSize: 16 }}>{SCREEN_META[screen].title}</h2>
        <p className="muted" style={{ margin: 0 }}>
          This screen is for the sales director.
        </p>
        <div>
          <Link href={CRM_BASE} className="btn btn-sm">
            Back to My Day
          </Link>
        </div>
      </div>
    </div>
  );
}
