/**
 * Combo booking staff alert — SERVER-ONLY (imports the SendGrid lib; keep out
 * of features/combos/index.ts so client bundles never pull it).
 *
 * Owner (2026-06-11): email eric@, curtis@, alex@ and jacob@headpinz.com
 * whenever an Ultimate VIP Experience books. Fired by unifiedReserve after
 * the booking fully succeeds (deposit captured, QAMF confirmed, BMI
 * confirmed). Best-effort: never throws — a mail hiccup must not fail a
 * paid booking.
 */
import { sendEmail } from "@/lib/sendgrid";
import type { BookingSession, BowlingItem, RaceItem } from "~/features/booking/state/types";
import type { ContactInfo } from "~/features/booking/types";

import { wallClockLabel } from "./combo-itinerary";
import { getComboSpecial } from "./combo-specials";

const COMBO_BOOKED_RECIPIENTS = [
  "eric@headpinz.com",
  "curtis@headpinz.com",
  "alex@headpinz.com",
  "jacob@headpinz.com",
];

export async function notifyComboBooked(args: {
  session: BookingSession;
  contact: Partial<ContactInfo>;
  bmiBillId: string | null;
  bmiReservationNumber: string | null;
  squareDayofOrderId: string;
  totalCents: number;
}): Promise<void> {
  try {
    const { session, contact } = args;
    const combo = session.comboSpecialId ? getComboSpecial(session.comboSpecialId) : null;
    if (!combo) return;

    const raceItem = session.items.find((i): i is RaceItem => i.kind === "race");
    const bowlingItem = session.items.find((i): i is BowlingItem => i.kind === "bowling");

    const dateLabel = raceItem?.date
      ? new Date(`${raceItem.date}T12:00:00`).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "—";

    // Itinerary rows: distinct race blocks (time · tier · track) + the lane.
    const raceRows = [
      ...new Map(
        (raceItem?.heats ?? [])
          .filter((h) => h.heatId)
          .map((h) => [
            `${h.heatId}|${h.track ?? ""}`,
            `${wallClockLabel(h.heatId!)} — ${cap(h.tier ?? "race")} Race${h.track ? ` (${h.track} Track)` : ""}`,
          ]),
      ).values(),
    ];
    const bowlingRow = bowlingItem?.bookedAt
      ? `${wallClockLabel(bowlingItem.bookedAt)} — ${(bowlingItem.durationMinutes ?? 90) / 60} hr ${
          bowlingItem.tier === "vip" ? "VIP " : ""
        }Bowling (${bowlingItem.laneCount} lane${bowlingItem.laneCount === 1 ? "" : "s"})`
      : null;
    const itinerary = [raceRows[0], bowlingRow, ...raceRows.slice(1)].filter(Boolean) as string[];

    const guest = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown guest";
    const partySize = session.party.length || 1;
    const total = `$${(args.totalCents / 100).toFixed(2)}`;
    const startLabel = raceItem?.heats?.[0]?.heatId ? wallClockLabel(raceItem.heats[0].heatId) : "";

    const subject = `🏁 ${combo.name} booked — ${guest} · ${dateLabel}${startLabel ? ` ${startLabel}` : ""}`;
    const lines = [
      `<h2 style="margin:0 0 4px">${combo.name} booked</h2>`,
      `<p style="margin:0 0 12px;color:#555">${dateLabel} · ${partySize} ${partySize === 1 ? "person" : "people"} · ${total} paid online</p>`,
      `<p style="margin:0 0 12px"><strong>${guest}</strong><br/>${contact.email ?? ""}<br/>${contact.phone ?? ""}</p>`,
      `<p style="margin:0 0 4px"><strong>Itinerary</strong></p>`,
      `<ol style="margin:0 0 12px;padding-left:20px">${itinerary.map((r) => `<li>${r}</li>`).join("")}</ol>`,
      `<p style="margin:0;color:#555;font-size:13px">BMI bill ${args.bmiBillId ?? "—"}${
        args.bmiReservationNumber ? ` · Res ${args.bmiReservationNumber}` : ""
      } · Square order ${args.squareDayofOrderId}</p>`,
    ];

    const result = await sendEmail({
      to: COMBO_BOOKED_RECIPIENTS[0],
      cc: COMBO_BOOKED_RECIPIENTS.slice(1),
      subject,
      html: lines.join("\n"),
      text:
        `${combo.name} booked — ${guest}, ${dateLabel}, ${partySize} ppl, ${total} paid.\n` +
        itinerary.map((r, i) => `${i + 1}. ${r}`).join("\n") +
        `\nBMI bill ${args.bmiBillId ?? "—"} · Square order ${args.squareDayofOrderId}`,
    });
    if (!result.ok) {
      console.error("[combo-notify] SendGrid rejected the staff alert:", result.error);
    }
  } catch (err) {
    console.error("[combo-notify] staff alert failed (non-fatal):", err);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
