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
import { fixtureStaffLabel, fixtureTimeLabel, type WorldCupFixture } from "./fixtures";

const WORLD_CUP_BOOKED_RECIPIENTS = [
  "eric@headpinz.com",
  "curtis@headpinz.com",
  "alex@headpinz.com",
  "jacob@headpinz.com",
  "abigail@headpinz.com",
  "bruce@headpinz.com",
];

const CENTER_NAMES: Record<string, string> = {
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
  "fort-myers": "HeadPinz Fort Myers",
  naples: "HeadPinz Naples",
  "9172": "HeadPinz Fort Myers",
  "3148": "HeadPinz Naples",
};

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
    const centerName = CENTER_NAMES[String(args.center)] ?? String(args.center);
    const lanes = Math.max(1, Math.ceil(args.players / 6));
    const match = fixtureStaffLabel(args.fixture);
    const total = `$${(args.totalCents / 100).toFixed(2)}`;
    const window = `${fixtureTimeLabel(args.fixture)} kickoff · 2.5-hr VIP lane window`;

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
      to: WORLD_CUP_BOOKED_RECIPIENTS[0],
      cc: WORLD_CUP_BOOKED_RECIPIENTS.slice(1),
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
