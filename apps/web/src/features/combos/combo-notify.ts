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
import type { VoucherItem } from "~/features/game-cards/data/vouchers-db";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import { summariseVoucherItems } from "~/features/game-cards/vouchers/display";

import { listComboGroupsForDate } from "./combo-existing.server";
import { chipHourOfIso, classifyGroupMatch } from "./combo-group-match";
import { wallClockLabel, wallClockMs } from "./combo-itinerary";
import { getComboSpecial } from "./combo-specials";

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
  /** This booking's Square deposit order — excludes it from the group-match lookup. */
  depositOrderId?: string | null;
  /** The booking's redeem-later voucher (V2 grant), when one minted. */
  voucher?: { code: string; items: VoucherItem[]; expiresAt: string | null } | null;
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
            // Category in the key: a mirrored junior heat is its own row, and
            // even a same-start junior block never merges into the adult row.
            `${h.heatId}|${h.track ?? ""}|${h.category ?? ""}`,
            {
              ms: wallClockMs(h.heatId!),
              label: `${wallClockLabel(h.heatId!)} — ${cap(h.tier ?? "race")} Race${h.track ? ` (${h.track} Track)` : ""}${h.category === "junior" ? " — Juniors" : ""}`,
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

    // Schedule-match vs the date's OTHER VIP groups (owner 2026-07-06: staff
    // walk matching groups from FastTrax to HeadPinz together, so managers
    // need to know at a glance whether this booking joins one). Best-effort —
    // a lookup failure must not affect the alert.
    const hourLabel = (h: number) => {
      const hr = h % 24;
      return `${hr % 12 === 0 ? 12 : hr % 12} ${hr >= 12 ? "PM" : "AM"}`;
    };
    let groupNote: { html: string; text: string; subjectSuffix: string } | null = null;
    try {
      const heatsWithId = (raceItem?.heats ?? []).filter((h) => !!h.heatId);
      const starters = heatsWithId.filter((h) => h.tier === "starter");
      const anchor = [...(starters.length ? starters : heatsWithId)].sort((a, b) =>
        a.heatId!.localeCompare(b.heatId!),
      )[0];
      if (raceItem?.date && session.comboSpecialId && anchor?.heatId) {
        const groups = await listComboGroupsForDate({
          dateYmd: raceItem.date,
          comboSpecialId: session.comboSpecialId,
          excludeDepositOrderId: args.depositOrderId ?? null,
        });
        if (groups.length > 0) {
          const verdict = classifyGroupMatch(
            {
              anchorStartIso: anchor.heatId,
              track: anchor.track ?? null,
              hour: chipHourOfIso(anchor.heatId),
            },
            groups,
          );
          const hoursLabel = [...new Set(groups.map((g) => hourLabel(g.startHour)))].join(" and ");
          if (verdict?.kind === "exact") {
            const text = `Joins the existing ${hourLabel(verdict.group.startHour)} VIP group — SAME Starter heat. Walk both groups over together.`;
            groupNote = {
              html: `<p style="margin:0 0 12px;padding:10px 12px;background:#e8f6ee;border-left:4px solid #1f9d55;color:#14532d;font-weight:600">${text}</p>`,
              text,
              subjectSuffix: "",
            };
          } else if (verdict?.kind === "same-hour") {
            // The only true mismatch worth alarming on: same booked hour but a
            // different heat, so two groups that LOOK simultaneous end up on
            // different races with bowling starts up to ~45 min apart.
            const text = `DOES NOT MATCH the ${hourLabel(verdict.group.startHour)} VIP group — same hour but a DIFFERENT race, so bowling times can differ by up to ~45 min. The groups will walk over to HeadPinz separately. Plan staffing accordingly.`;
            groupNote = {
              html: `<p style="margin:0 0 12px;padding:10px 12px;background:#fff4e5;border-left:4px solid #f5a623;color:#7a4f01;font-weight:600">⚠️ ${text}</p>`,
              text,
              subjectSuffix: " · ⚠️ SAME HOUR, DIFFERENT RACE",
            };
          } else {
            // A group at a different hour entirely (e.g. 2 PM vs 4 PM) is
            // separate visits by design — an FYI, never a mismatch warning.
            const text = `Heads-up: this date also has VIP group(s) at ${hoursLabel} — different time slots, each group walks over on its own schedule.`;
            groupNote = {
              html: `<p style="margin:0 0 12px;padding:10px 12px;background:#eef2f7;border-left:4px solid #94a3b8;color:#334155">${text}</p>`,
              text,
              subjectSuffix: "",
            };
          }
        }
      }
    } catch (err) {
      console.error("[combo-notify] group-match lookup failed (non-fatal):", err);
    }

    const guest = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown guest";
    const partySize = session.party.length || 1;
    const total = `$${(args.totalCents / 100).toFixed(2)}`;
    const startLabel = raceItem?.heats?.[0]?.heatId ? wallClockLabel(raceItem.heats[0].heatId) : "";

    const reorderNotice =
      "NON-STANDARD ORDER — both races run FIRST, then the VIP lane. The lane " +
      "wasn't available between the races (e.g. a league had the VIP lanes), so " +
      "the system scheduled bowling last. Plan lane/track scheduling accordingly.";

    const subject = `🏁 ${combo.name} booked — ${guest} · ${dateLabel}${startLabel ? ` ${startLabel}` : ""}${reordered ? " · ⚠️ RACES-FIRST ORDER" : ""}${groupNote?.subjectSuffix ?? ""}`;
    const lines = [
      `<h2 style="margin:0 0 4px">${combo.name} booked</h2>`,
      `<p style="margin:0 0 12px;color:#555">${dateLabel} · ${partySize} ${partySize === 1 ? "person" : "people"} · ${total} paid online</p>`,
      reordered
        ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff4e5;border-left:4px solid #f5a623;color:#7a4f01;font-weight:600">⚠️ ${reorderNotice}</p>`
        : "",
      groupNote?.html ?? "",
      `<p style="margin:0 0 12px"><strong>${guest}</strong><br/>${contact.email ?? ""}<br/>${contact.phone ?? ""}</p>`,
      `<p style="margin:0 0 4px"><strong>Itinerary</strong></p>`,
      `<ol style="margin:0 0 12px;padding-left:20px">${itinerary.map((r) => `<li>${r}</li>`).join("")}</ol>`,
      args.voucher
        ? `<p style="margin:0 0 12px"><strong>Voucher</strong> <span style="font-family:monospace">${formatVoucherCode(args.voucher.code)}</span> — ${summariseVoucherItems(args.voucher.items)}${
            args.voucher.expiresAt
              ? ` · valid through ${new Date(args.voucher.expiresAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}`
              : ""
          } · not transferable</p>`
        : "",
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
        (groupNote ? `\n** ${groupNote.text} **\n\n` : "") +
        itinerary.map((r, i) => `${i + 1}. ${r}`).join("\n") +
        (args.voucher
          ? `\nVoucher ${formatVoucherCode(args.voucher.code)} — ${summariseVoucherItems(args.voucher.items)}`
          : "") +
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
