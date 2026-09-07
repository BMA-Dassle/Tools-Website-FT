"use client";

/**
 * Overview-tab card: the booking's package food (Pizza Bowl pizza + drink),
 * editable by staff — owner 2026-09-06: "in reservation admin we should be
 * able to edit as well."
 *
 * Wraps the shared PackageFoodEditor in staff mode (admin route, no time
 * limit, never charges a card — extras are collected at the lane). The editor
 * says via onStatus whether this package has food at all; the card stays out of
 * the DOM for the ones that don't. Rendered on a dark panel because the picker
 * is white-on-navy everywhere else and the board's theme is the staff's choice.
 */
import { useState } from "react";
import {
  PackageFoodEditor,
  type FoodEditorStatus,
} from "~/components/features/bowling/PackageFoodEditor";
import { Card } from "./ui";

export function PackageFoodCard({
  neonId,
  token,
  onSaved,
}: {
  neonId: number;
  token: string;
  /** Fires after a successful save so the modal refetches the detail (line items, board row). */
  onSaved?: () => void;
}) {
  const [status, setStatus] = useState<FoodEditorStatus | null>(null);
  const hasFood = !!status?.hasFood;
  return (
    <div hidden={!hasFood}>
      <Card title={status && !status.complete ? "Pizza & drink — NOT PICKED" : "Pizza & drink"}>
        {status?.laneOpen && (
          <div style={{ fontSize: "0.72rem", color: "var(--ba-muted)", marginBottom: 8 }}>
            Lane is open — a change here updates the notes on the kitchen ticket.
          </div>
        )}
        <div style={{ background: "#0a1628", borderRadius: 10, padding: 12 }}>
          <PackageFoodEditor
            neonId={neonId}
            adminToken={token}
            accent="#00E2E5"
            hideHeading
            onStatus={setStatus}
            onSaved={onSaved}
          />
        </div>
      </Card>
    </div>
  );
}
