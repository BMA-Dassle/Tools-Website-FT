/**
 * Combo booking staff alert — SERVER-ONLY (imports the SendGrid lib; keep out
 * of features/combos/index.ts so client bundles never pull it).
 *
 * Owner (2026-06-11): email eric@, curtis@, alex@ and jacob@headpinz.com
 * whenever an Ultimate VIP Experience books. (2026-06-13: added abigail@,
 * bruce@headpinz.com and jeff@, jamil@fasttraxent.com.) Fired by unifiedReserve after
 * the booking fully succeeds (deposit captured, QAMF confirmed, BMI
 * confirmed). Best-effort: never throws — a mail hiccup must not fail a
 * paid booking.
 */
import { sendEmail } from "@/lib/sendgrid";
import type { BookingSession, BowlingItem, RaceItem } from "~/features/booking/state/types";
import type { ContactInfo } from "~/features/booking/types";

import { wallClockLabel, wallClockMs } from "./combo-itinerary";
import { getComboSpecial, type ComboSpecial } from "./combo-specials";

const COMBO_BOOKED_RECIPIENTS = [
  "eric@headpinz.com",
  "curtis@headpinz.com",
  "alex@headpinz.com",
  "jacob@headpinz.com",
  "abigail@headpinz.com",
  "bruce@headpinz.com",
  "jeff@fasttraxent.com",
  "jamil@fasttraxent.com",
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

    // Itinerary rows: distinct race blocks (time · tier · track) + the lane,
    // each carrying its wall-clock ms so we render in ACTUAL chronological
    // order — correct whether bowling runs in the middle (normal) or last
    // (reorder fallback). Also detect the reorder so managers get a scheduling
    // heads-up.
    const raceRows = [
      ...new Map(
        (raceItem?.heats ?? [])
          .filter((h) => h.heatId)
          .map((h) => [
            `${h.heatId}|${h.track ?? ""}`,
            {
              ms: wallClockMs(h.heatId!),
              label: `${wallClockLabel(h.heatId!)} — ${cap(h.tier ?? "race")} Race${h.track ? ` (${h.track} Track)` : ""}`,
            },
          ]),
      ).values(),
    ];
    const bowlMs = bowlingItem?.bookedAt ? wallClockMs(bowlingItem.bookedAt) : null;
    const bowlingRow =
      bowlingItem?.bookedAt && bowlMs != null
        ? {
            ms: bowlMs,
            label: `${wallClockLabel(bowlingItem.bookedAt)} — ${(bowlingItem.durationMinutes ?? 90) / 60} hr ${
              bowlingItem.tier === "vip" ? "VIP " : ""
            }Bowling (${bowlingItem.laneCount} lane${bowlingItem.laneCount === 1 ? "" : "s"})`,
          }
        : null;
    const itinerary = [...raceRows, ...(bowlingRow ? [bowlingRow] : [])]
      .sort((a, b) => a.ms - b.ms)
      .map((r) => r.label);

    // Reorder fallback: the lane runs AFTER both races (it wasn't free between
    // them). Managers need to know — the visit order differs from the standard
    // race → bowl → race, which changes lane/track scheduling.
    const reordered = bowlMs != null && raceRows.length > 0 && raceRows.every((r) => r.ms < bowlMs);

    const guest = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown guest";
    const partySize = session.party.length || 1;
    const total = `$${(args.totalCents / 100).toFixed(2)}`;
    const startLabel = raceItem?.heats?.[0]?.heatId ? wallClockLabel(raceItem.heats[0].heatId) : "";

    const reorderNotice =
      "NON-STANDARD ORDER — both races run FIRST, then the VIP lane. The lane " +
      "wasn't available between the races (e.g. a league had the VIP lanes), so " +
      "the system scheduled bowling last. Plan lane/track scheduling accordingly.";

    const subject = `🏁 ${combo.name} booked — ${guest} · ${dateLabel}${startLabel ? ` ${startLabel}` : ""}${reordered ? " · ⚠️ RACES-FIRST ORDER" : ""}`;
    const lines = [
      `<h2 style="margin:0 0 4px">${combo.name} booked</h2>`,
      `<p style="margin:0 0 12px;color:#555">${dateLabel} · ${partySize} ${partySize === 1 ? "person" : "people"} · ${total} paid online</p>`,
      reordered
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff4e5;border-left:4px solid #f5a623;color:#7a4f01;font-weight:600">⚠️ ${reorderNotice}</p>`
        : "",
      `<p style="margin:0 0 12px"><strong>${guest}</strong><br/>${contact.email ?? ""}<br/>${contact.phone ?? ""}</p>`,
      `<p style="margin:0 0 4px"><strong>Itinerary</strong></p>`,
      `<ol style="margin:0 0 12px;padding-left:20px">${itinerary.map((r) => `<li>${r}</li>`).join("")}</ol>`,
      `<p style="margin:0;color:#555;font-size:13px">BMI bill ${args.bmiBillId ?? "—"}${
        args.bmiReservationNumber ? ` · Res ${args.bmiReservationNumber}` : ""
      } · Square order ${args.squareDayofOrderId}</p>`,
    ].filter(Boolean);

    const result = await sendEmail({
      to: COMBO_BOOKED_RECIPIENTS[0],
      cc: COMBO_BOOKED_RECIPIENTS.slice(1),
      subject,
      html: lines.join("\n"),
      text:
        `${combo.name} booked — ${guest}, ${dateLabel}, ${partySize} ppl, ${total} paid.\n` +
        (reordered ? `\n** ${reorderNotice} **\n\n` : "") +
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

/**
 * Staff alert when guests are ADDED to an existing combo booking (post-booking
 * self-service add-on). Same recipients as a fresh combo booking. Best-effort —
 * never throws (a mail hiccup must not fail a captured add-on).
 */
export async function notifyComboGuestsAdded(args: {
  combo: ComboSpecial;
  contact: { firstName?: string; lastName?: string; email?: string; phone?: string };
  eventDate: string;
  addedGuests: string[];
  lanesAdded: number;
  lane: string | null;
  newBmiBillId: string | null;
  chargedCents: number;
}): Promise<void> {
  try {
    const { combo, contact } = args;
    const guest = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown guest";
    const dateLabel = new Date(`${args.eventDate}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const n = args.addedGuests.length;
    const total = `$${(args.chargedCents / 100).toFixed(2)}`;
    const laneNote =
      args.lanesAdded > 0
        ? `<strong>+${args.lanesAdded} bowling lane${args.lanesAdded === 1 ? "" : "s"}</strong> needed — seat with the original party (lane ${args.lane ?? "—"}).`
        : `Seat the new guest${n === 1 ? "" : "s"} with the original party on lane ${args.lane ?? "—"}.`;

    const subject = `➕ ${combo.name} — ${n} guest${n === 1 ? "" : "s"} added · ${guest} · ${dateLabel}`;
    const html = [
      `<h2 style="margin:0 0 4px">${combo.name} — guests added</h2>`,
      `<p style="margin:0 0 12px;color:#555">${dateLabel} · +${n} ${n === 1 ? "guest" : "guests"} · ${total} paid online</p>`,
      `<p style="margin:0 0 12px"><strong>${guest}</strong><br/>${contact.email ?? ""}<br/>${contact.phone ?? ""}</p>`,
      `<p style="margin:0 0 4px"><strong>Added</strong></p>`,
      `<ul style="margin:0 0 12px;padding-left:20px">${args.addedGuests.map((g) => `<li>${g}</li>`).join("")}</ul>`,
      `<p style="margin:0 0 12px;padding:10px 12px;background:#fff4e5;border-left:4px solid #f5a623;color:#7a4f01">${laneNote}</p>`,
      `<p style="margin:0;color:#555;font-size:13px">Add-on BMI bill ${args.newBmiBillId ?? "—"} · same itinerary as the original booking.</p>`,
    ].join("\n");

    const result = await sendEmail({
      to: COMBO_BOOKED_RECIPIENTS[0],
      cc: COMBO_BOOKED_RECIPIENTS.slice(1),
      subject,
      html,
      text:
        `${combo.name}: ${n} guest(s) added — ${guest}, ${dateLabel}, ${total} paid.\n` +
        `Added: ${args.addedGuests.join(", ")}\n` +
        (args.lanesAdded > 0 ? `+${args.lanesAdded} lane(s). ` : "") +
        `Seat with original party (lane ${args.lane ?? "—"}). Add-on bill ${args.newBmiBillId ?? "—"}.`,
    });
    if (!result.ok) console.error("[combo-notify] add-on alert rejected:", result.error);
  } catch (err) {
    console.error("[combo-notify] add-on alert failed (non-fatal):", err);
  }
}
