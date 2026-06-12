/**
 * HP Arena e-ticket email builders — HeadPinz-branded siblings of the
 * racing email HTML in the pre-race cron. Deep-navy header, coral CTA
 * (HeadPinz palette), HP FM address, "session" wording.
 */

import type { GroupTicketMember, ParticipantTicketRef } from "@/lib/race-tickets";
import { HP_FM_ADDRESS } from "./constants";

const ET_TZ = "America/New_York";

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: ET_TZ,
    });
  } catch {
    return "";
  }
}

function sessionLabel(m: GroupTicketMember | ParticipantTicketRef): string {
  return `${m.track} Session ${m.heatNumber} · ${formatTimeET(m.scheduledStart)}`;
}

function shell(heading: string, inner: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#010A20;padding:22px 28px;color:#fff;text-align:center">
          <p style="margin:0 0 4px 0;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;opacity:0.9">HeadPinz · HP Arena</p>
          <h1 style="margin:0;font-size:26px;letter-spacing:-0.5px">${heading}</h1>
        </td></tr>
        <tr><td style="padding:26px 28px">
          ${inner}
          <p style="margin:24px 0 0 0;font-size:12px;color:#888;text-align:center">${HP_FM_ADDRESS}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function cta(shortUrl: string, label: string): string {
  return `<p style="text-align:center;margin:24px 0">
    <a href="${shortUrl}" style="display:inline-block;background:#fd5b56;color:#ffffff;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase">${label}</a>
  </p>`;
}

export function buildArenaEmailHtml(
  firstName: string,
  activityDisplay: string,
  scheduledStart: string,
  shortUrl: string,
): string {
  const time = formatTimeET(scheduledStart);
  return shell(
    "Your HP Arena E-Ticket",
    `<p style="margin:0 0 12px 0;font-size:16px;line-height:1.5">Hey ${firstName} — your <strong>${activityDisplay} session</strong> is coming up at <strong>${time}</strong>.</p>
     <p style="margin:0 0 20px 0;font-size:15px;line-height:1.5">Arrive 15 minutes early to check in and gear up. Save this email or screenshot your e-ticket — show the e-ticket screen at the HP Arena desk, no paper ticket needed.</p>
     ${cta(shortUrl, "View My E-Ticket")}`,
  );
}

/**
 * Grouped email — guardian fallback (1+ kids routed to a parent inbox)
 * or a plain shared family inbox (2+ players, one email).
 */
export function buildArenaGroupEmailHtml(
  members: GroupTicketMember[],
  shortUrl: string,
  recipient: "racer" | "guardian",
): string {
  const sorted = [...members].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
  const heading = recipient === "guardian" ? "Your players' e-tickets" : "Your HP Arena e-tickets";
  const intro =
    recipient === "guardian"
      ? "Heads up — your players are up soon."
      : "Heads up — your sessions are coming up.";
  const rows = sorted
    .map(
      (m) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${m.firstName}</strong>
      <span style="color:#555"> — ${sessionLabel(m)}</span>
    </td></tr>`,
    )
    .join("");
  return shell(
    heading,
    `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">${intro}</p>
     <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;font-size:15px">${rows}</table>
     <p style="margin:0 0 20px 0;font-size:14px;line-height:1.5;color:#555">Arrive 15 minutes early to check in and gear up. Show the e-ticket screen at the HP Arena desk — no paper ticket needed.</p>
     ${cta(shortUrl, "View E-Tickets")}`,
  );
}

/**
 * Move-aware email — at least one fresh recipient was moved to a
 * different session. Movers show "was X → now Y".
 */
export function buildArenaMoveEmailHtml(
  entries: { member: GroupTicketMember; movedFrom?: ParticipantTicketRef | null }[],
  shortUrl: string,
  recipient: "racer" | "guardian",
): string {
  const sorted = [...entries].sort(
    (a, b) =>
      new Date(a.member.scheduledStart).getTime() - new Date(b.member.scheduledStart).getTime(),
  );
  const heading = recipient === "guardian" ? "A session time changed" : "Your session time changed";
  const rows = sorted
    .map(({ member: m, movedFrom }) => {
      if (movedFrom) {
        return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${m.firstName}</strong> — moved<br/>
      <span style="color:#999;text-decoration:line-through">${sessionLabel(movedFrom)}</span><br/>
      <span style="color:#1a1a1a;font-weight:bold">→ ${sessionLabel(m)}</span>
    </td></tr>`;
      }
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
      <strong style="color:#1a1a1a">${m.firstName}</strong>
      <span style="color:#555"> — ${sessionLabel(m)}</span>
    </td></tr>`;
    })
    .join("");
  return shell(
    heading,
    `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">Your HP Arena session assignment changed — here are the latest details.</p>
     <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;font-size:15px">${rows}</table>
     <p style="margin:0 0 20px 0;font-size:14px;line-height:1.5;color:#555">Show the e-ticket screen at the HP Arena desk — no paper ticket needed.</p>
     ${cta(shortUrl, "View Updated E-Ticket")}`,
  );
}
