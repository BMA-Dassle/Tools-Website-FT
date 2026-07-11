/**
 * Manager alerting for reservation edits — post-complete edits change money
 * AFTER the session settled, and QAMF/BMI are deliberately NOT updated, so a
 * human must reconcile the center systems. This card is that reconciliation
 * order. Best-effort: an alert failure never fails the edit (it's also in
 * the modal warning + admin_action_events).
 *
 * Card plumbing mirrors refund-alerts (sendAdaptiveCardToChannel; v1.4
 * schema; no emoji — staff-facing). Chat defaults to the refund-alerts
 * channel (same audience: money corrections) unless EDIT_ALERTS_CHAT_ID is
 * set.
 */

import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import { refundAlertsChatId } from "~/features/refund-alerts/config";

const chatId = (): string => process.env.EDIT_ALERTS_CHAT_ID || refundAlertsChatId();

const dollars = (cents: number): string => `$${(Math.abs(cents) / 100).toFixed(2)}`;

export interface PostCompleteEditAlert {
  reservationId: number;
  guestName: string;
  centerCode: string;
  diffCents: number;
  settlement: string;
  editId: string;
  oldOrderIds: string[];
  newOrderIds: string[];
}

const buildCard = (a: PostCompleteEditAlert): Record<string, unknown> => ({
  type: "AdaptiveCard",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  version: "1.4",
  body: [
    {
      type: "Container",
      style: "attention",
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: "POST-COMPLETE RESERVATION EDIT — MANUAL SYNC NEEDED",
          weight: "Bolder",
          size: "Small",
        },
      ],
    },
    {
      type: "TextBlock",
      wrap: true,
      text:
        `Reservation #${a.reservationId} (${a.guestName}, ${a.centerCode}) was edited AFTER its ` +
        `day-of order completed. The Square order was refunded and rebuilt ` +
        `(${a.diffCents >= 0 ? "charged" : "refunded"} ${dollars(a.diffCents)}, ${a.settlement}).`,
    },
    {
      type: "TextBlock",
      wrap: true,
      weight: "Bolder",
      text: "QAMF (Conqueror) and BMI were NOT updated — adjust them manually if needed.",
    },
    {
      type: "FactSet",
      facts: [
        { title: "Edit", value: a.editId },
        { title: "Old order(s)", value: a.oldOrderIds.join(", ") || "—" },
        { title: "New order(s)", value: a.newOrderIds.join(", ") || "—" },
      ],
    },
  ],
});

export const sendPostCompleteEditAlert = async (a: PostCompleteEditAlert): Promise<boolean> => {
  const id = chatId();
  if (!id) {
    console.warn("[reservation-edit/notify] no EDIT_ALERTS_CHAT_ID/REFUND_ALERTS_CHAT_ID — skip");
    return false;
  }
  try {
    await sendAdaptiveCardToChannel(id, buildCard(a), {
      summaryText: `Post-complete edit on reservation #${a.reservationId} — sync Conqueror/BMI manually`,
    });
    return true;
  } catch (err) {
    console.error(
      "[reservation-edit/notify] Teams alert failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};
