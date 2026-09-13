"use client";

import Link from "next/link";
import { CRM_BASE, TEST_IDS } from "~/features/crm/core/contracts";

/** An unknown first URL segment — in-app, HTTP 200, a way back. */
export function NotFound({ requested }: { requested: string }) {
  return (
    <div className="card" data-testid={TEST_IDS.screen("not-found")} style={{ maxWidth: 640 }}>
      <div className="pad stack">
        <div className="eyebrow">Not found</div>
        <h2 style={{ fontSize: 16 }}>There is no screen called “{requested}”.</h2>
        <div>
          <Link href={CRM_BASE} className="btn btn-sm">
            Back to My Day
          </Link>
        </div>
      </div>
    </div>
  );
}
