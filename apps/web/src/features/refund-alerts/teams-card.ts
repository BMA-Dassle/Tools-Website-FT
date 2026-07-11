/**
 * Adaptive Card builder for refund policy alerts — pure, no I/O.
 *
 * Deliberately loud: this card exists to correct behavior. It names what
 * happened, who did it (when Square attributes a team member), and states the
 * rule. v1.4 schema — sendAdaptiveCardToChannel is card-only. No emoji
 * (staff-facing).
 */
import type { ExternalRefund } from "./detect";

const CENTER_LABEL: Record<string, string> = {
  "fort-myers": "Fort Myers",
  naples: "Naples",
  fasttrax: "FastTrax Fort Myers",
};

const KIND_LABEL: Record<string, string> = {
  race: "Racing",
  open: "Open Bowling",
  kbf: "Kids Bowl Free",
  attraction: "Attraction",
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function fmtEt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function reservationDesc(e: ExternalRefund): string {
  const r = e.reservation;
  const parts = [KIND_LABEL[r.productKind] ?? r.productKind];
  if (r.centerCode) parts.push(CENTER_LABEL[r.centerCode] ?? r.centerCode);
  parts.push(r.qamfReservationId ? `#${r.qamfReservationId}` : `res ${r.id}`);
  return parts.join(" · ");
}

export function refundAlertSummaryText(entries: ExternalRefund[]): string {
  if (entries.length === 1) {
    const e = entries[0];
    return `Incorrect refund: ${dollars(e.refund.amountCents)} for ${e.reservation.guestName ?? "a guest"} was done in Square`;
  }
  return `${entries.length} incorrect refunds were done in Square, not the Reservation Portal`;
}

export function buildRefundAlertCard(
  entries: ExternalRefund[],
  opts?: { boardUrl?: string | null; teamMemberNames?: ReadonlyMap<string, string> },
): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "Container",
      style: "attention",
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: "REFUND POLICY VIOLATION",
          weight: "Bolder",
          size: "Small",
          spacing: "None",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: "Incorrect refund — issued directly in Square",
          weight: "Bolder",
          size: "Large",
          spacing: "Small",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: "Refunds must ALWAYS be processed through the Reservation Portal, never in the Square Dashboard or POS.",
          weight: "Bolder",
          size: "Small",
          spacing: "None",
          wrap: true,
        },
      ],
    },
  ];

  for (const e of entries) {
    const by = e.refund.teamMemberId
      ? (opts?.teamMemberNames?.get(e.refund.teamMemberId) ?? "Square team member")
      : "unknown (not attributed by Square)";
    body.push(
      {
        type: "TextBlock",
        text: e.reservation.guestName ?? "Unknown guest",
        weight: "Bolder",
        spacing: "Medium",
        separator: true,
        wrap: true,
      },
      {
        type: "FactSet",
        spacing: "Small",
        facts: [
          { title: "Reservation", value: reservationDesc(e) },
          {
            title: "Refunded",
            value: `${dollars(e.refund.amountCents)} of ${dollars(e.reservation.totalCents)} — ${fmtEt(e.refund.createdAt)} ET`,
          },
          { title: "Refunded by", value: by },
          ...(e.refund.reason ? [{ title: "Reason typed", value: e.refund.reason }] : []),
        ],
      },
    );
  }

  body.push({
    type: "TextBlock",
    text:
      "Why this matters: a Square-side refund is invisible to our system. The reservation stays live on the board showing as PAID, the race heats / lanes stay booked, and the guest can still show up holding a confirmation. " +
      "Fix it now: open the reservation on the board and run Cancel & Refund from the Manage screen so the booking is actually cancelled (the money side is already refunded — the portal records it and releases the slots).",
    size: "Small",
    spacing: "Medium",
    separator: true,
    wrap: true,
  });

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: opts?.boardUrl
      ? [{ type: "Action.OpenUrl", title: "Open reservations board", url: opts.boardUrl }]
      : [],
  };
}
