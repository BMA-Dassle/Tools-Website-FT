"use client";

import { IconEdit } from "@tabler/icons-react";
import { useCrmSheet } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { DealRail } from "./DealRail";
import { EditLeadSheet } from "./EditLeadSheet";
import { LeadTimeline } from "./LeadTimeline";
import type { DealTabProps } from "./tabs";

/**
 * The Overview tab (`dealBody`, crm-shared.js:319): notes + timeline on the
 * left, the rail on the right (`.deal-grid`; one column inside the drawer and
 * on the phone, by crm.css).
 */
export default function OverviewTab({ detail, refresh }: DealTabProps) {
  const { openSheet, closeSheet } = useCrmSheet();
  const { lead, activities } = detail;

  const edit = (thenMint: boolean) =>
    openSheet({
      title: thenMint ? "Complete to create in BMI" : `Edit ${lead.guest.first || "lead"}`,
      icon: <IconEdit {...ICON} />,
      wide: true,
      body: (
        <EditLeadSheet
          lead={lead}
          thenMint={thenMint}
          onCancel={closeSheet}
          onDone={() => {
            closeSheet();
            refresh();
          }}
        />
      ),
    });

  return (
    <div className="deal-grid">
      <div className="stack" style={{ gap: 16 }}>
        {lead.notes ? (
          <div className="card">
            <div className="pad">
              <div className="eyebrow" style={{ marginBottom: 4 }}>
                Notes
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{lead.notes}</div>
            </div>
          </div>
        ) : null}
        <LeadTimeline leadPublicId={lead.publicId} initialActivities={activities} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <DealRail detail={detail} onEdit={edit} />
      </div>
    </div>
  );
}
