/**
 * World Cup VIP Bowling booking staff alert — SERVER-ONLY (imports the
 * SendGrid lib; keep out of features/world-cup/index.ts so client bundles
 * never pull it). Mirrors the Ultimate VIP pattern (combos/combo-notify.ts).
 *
 * Owner 7/6: "email like Ultimate VIP experience" — alert HeadPinz staff
 * whenever a World Cup lane window books. Fired by BOTH reserve rails after
 * the booking fully succeeds (deposit captured, QAMF confirmed, Neon row
 * written). Best-effort: never throws — a mail hiccup must not fail a paid
 * booking. HeadPinz-only offer → HeadPinz recipients (no fasttraxent.com).
 */
import { sendEmail } from "@/lib/sendgrid";
import {
  fixtureStaffLabel,
  fixtureTimeLabel,
  worldCupWindowLabelShort,
  type WorldCupFixture,
} from "./fixtures";

// Per-center recipients (owner 7/6): each center's own crew gets its own
// bookings — never jeff/jamil@fasttraxent (racing side). Lists live in the
// CENTRAL src/lib/constants/staff-recipients.ts so any special can reuse them.
import {
  CENTER_DISPLAY_NAMES,
  normalizeCenterKey,
  staffRecipientsForCenter,
} from "~/lib/constants/staff-recipients";

export async function notifyWorldCupBooked(args: {
  fixture: WorldCupFixture;
  /** CenterCode, Square center code, or QAMF id — mapped to a display name. */
  center: string | number;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  players: number;
  totalCents: number;
  qamfReservationId: string | null;
  squareDayofOrderId: string | null;
}): Promise<void> {
  try {
    // Unknown center falls back to Fort Myers (name + recipients) — better a
    // misrouted alert than a silent one.
    const centerKey = normalizeCenterKey(args.center) ?? "fort-myers";
    const centerName = CENTER_DISPLAY_NAMES[centerKey];
    const recipients = staffRecipientsForCenter(args.center);
    const lanes = Math.max(1, Math.ceil(args.players / 6));
    const match = fixtureStaffLabel(args.fixture);
    const total = `$${(args.totalCents / 100).toFixed(2)}`;
    const window = `${fixtureTimeLabel(args.fixture)} kickoff · ${worldCupWindowLabelShort()} VIP lane window`;

    const subject = `⚽ World Cup VIP booked — ${args.guestName} · ${match} · ${centerName}`;
    const html = [
      `<h2 style="margin:0 0 4px">World Cup VIP Bowling booked</h2>`,
      `<p style="margin:0 0 12px;color:#555">${match} (${args.fixture.round})</p>`,
      `<p style="margin:0 0 12px"><strong>${centerName}</strong> · ${window}<br/>` +
        `${args.players} ${args.players === 1 ? "bowler" : "bowlers"} · ${lanes} lane${lanes === 1 ? "" : "s"} · ${total} paid online</p>`,
      `<p style="margin:0 0 12px"><strong>${args.guestName}</strong><br/>${args.guestEmail ?? ""}<br/>${args.guestPhone ?? ""}</p>`,
      `<p style="margin:0;color:#555;font-size:13px">QAMF ${args.qamfReservationId ?? "—"} · Square order ${args.squareDayofOrderId ?? "—"}</p>`,
    ].join("\n");

    const result = await sendEmail({
      to: recipients[0],
      cc: recipients.slice(1),
      subject,
      html,
      text:
        `World Cup VIP booked — ${args.guestName}\n` +
        `${match} (${args.fixture.round})\n` +
        `${centerName} · ${window}\n` +
        `${args.players} bowlers · ${lanes} lane(s) · ${total} paid online\n` +
        `${args.guestEmail ?? ""} ${args.guestPhone ?? ""}\n` +
        `QAMF ${args.qamfReservationId ?? "—"} · Square order ${args.squareDayofOrderId ?? "—"}`,
    });
    if (!result.ok) {
      console.error("[world-cup-notify] SendGrid rejected the staff alert:", result.error);
    }
  } catch (err) {
    console.error("[world-cup-notify] staff alert failed (non-fatal):", err);
  }
}
