import { HAB_LAST_CHARGE_DATE, habFormatDate, habFormatUsd, type JoinPlan } from "./schedule";

/**
 * Have-A-Ball signup emails.
 *
 * Two distinct sends on each signup:
 *   - bowler confirmation (customer-facing)
 *   - staff notification (ops-facing) — spells out the subscription that was
 *     created, with the weekly amount, dates, and Square IDs.
 * Both render the real money breakdown from the authoritative JoinPlan.
 */

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = "HeadPinz Fort Myers";

const TEAM_BCC = [
  "barb@headpinz.com",
  "paula@headpinz.com",
  "jacob@headpinz.com",
  "eric@headpinz.com",
];

function escape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
}

export interface HabEmailParams {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dob?: string;
  teamName?: string;
  subscriptionId: string;
  plan: JoinPlan;
}

export function renderHabEmail(p: HabEmailParams): string {
  const { plan } = p;
  const teamLine = p.teamName
    ? `<p style="margin:0 0 8px 0"><strong>Team / Bowling with:</strong> ${escape(p.teamName)}</p>`
    : "";

  const billingBlock = `<p style="margin:0 0 8px 0;line-height:1.5">Your card will be charged <strong>${habFormatUsd(
    plan.weeklyTotalCents,
  )} every week for ${plan.remainingCharges} week${
    plan.remainingCharges === 1 ? "" : "s"
  }</strong>, starting <strong>${habFormatDate(plan.subStartDate)}</strong>. No charge today.</p>`;

  // Mid-season joiners owe a one-time retro payment for the weeks already
  // played. This is disclosed here but collected separately by HeadPinz staff —
  // the signup did NOT charge it.
  const retroBlock =
    plan.missedWeeks > 0
      ? `<div style="background:#fff7f7;border:1px solid #f3c0bf;padding:14px 18px;margin:12px 0;border-radius:6px">
           <p style="margin:0;font-size:14px;line-height:1.5;color:#1a1a1a"><strong>One-time retro payment:</strong> because the season is already underway, you're also responsible for a one-time retro payment of <strong>${habFormatUsd(
             plan.retroAmountCents,
           )}</strong> for the ${plan.missedWeeks} week${
             plan.missedWeeks === 1 ? "" : "s"
           } already played. A HeadPinz team member will arrange this with you separately — it was <strong>not</strong> charged today.</p>
         </div>`
      : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08)">
        <tr><td style="background:#fd5b56;padding:28px 32px;color:#fff">
          <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:0.85">HeadPinz Fort Myers</p>
          <h1 style="margin:0;font-size:28px;letter-spacing:-0.5px">You're in the Have-A-Ball League!</h1>
        </td></tr>

        <tr><td style="padding:28px 32px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">Hey ${escape(p.firstName)} — you're officially signed up for the Have-A-Ball League. See you on the lanes!</p>

          <div style="background:#fff7f7;border-left:4px solid #fd5b56;padding:16px 20px;margin:20px 0;border-radius:4px">
            <p style="margin:0 0 6px 0;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px">League Night</p>
            <p style="margin:0;font-size:22px;font-weight:bold;color:#1a1a1a">Tuesdays · 6:30 PM</p>
            <p style="margin:8px 0 0 0;font-size:13px;color:#555">HeadPinz Fort Myers, 14513 Global Parkway</p>
          </div>

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">Your Signup</h3>
          <p style="margin:0 0 8px 0"><strong>Name:</strong> ${escape(p.firstName)} ${escape(p.lastName)}</p>
          <p style="margin:0 0 8px 0"><strong>Phone:</strong> ${escape(p.phone)}</p>
          <p style="margin:0 0 8px 0"><strong>Email:</strong> ${escape(p.email)}</p>
          ${teamLine}

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">Billing</h3>
          ${billingBlock}
          ${retroBlock}
          <p style="margin:0 0 4px 0;font-size:14px;color:#555">· $14.50 lineage (lanes + shoes) + $5.50 toward your ball, per week</p>
          <p style="margin:0 0 4px 0;font-size:14px;color:#555">· Prices include 6.5% Lee County sales tax</p>
          <p style="margin:12px 0 0 0;font-size:14px;color:#555">Total: ${habFormatUsd(
            plan.totalDueCents,
          )} over ${plan.remainingCharges} week${plan.remainingCharges === 1 ? "" : "s"}.</p>

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">What's Next</h3>
          <p style="margin:0 0 8px 0;line-height:1.5">We'll send a ball-selection email — pick between the Brunswick T-Zone or Columbia White Dot, four colors each.</p>
          <p style="margin:0 0 8px 0;line-height:1.5">Questions? Reply to this email or call <a href="tel:+12393022155" style="color:#fd5b56">(239) 302-2155</a>.</p>

          <p style="margin:32px 0 0 0;font-size:12px;color:#aaa;border-top:1px solid #eee;padding-top:16px">
            Subscription ID: ${escape(p.subscriptionId)}<br>
            HeadPinz Fort Myers · 14513 Global Parkway, Fort Myers FL 33913
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Staff/ops notification — spells out exactly what was set up for this signup:
 * the recurring subscription, with the weekly amount, dates, and Square IDs so
 * the team can reconcile against Square.
 */
export function renderHabStaffEmail(p: HabEmailParams): string {
  const { plan } = p;
  const midSeason = plan.status === "midseason";

  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;white-space:nowrap">${label}</td>` +
    `<td style="padding:6px 12px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:14px;font-weight:600">${value}</td></tr>`;

  const subscriptionRows =
    plan.remainingCharges > 0
      ? row(
          "Subscription",
          `${habFormatUsd(plan.weeklyTotalCents)}/week × ${plan.remainingCharges} (${habFormatUsd(
            plan.totalDueCents,
          )})`,
        ) +
        row("First weekly charge", habFormatDate(plan.subStartDate)) +
        row("Final charge", habFormatDate(HAB_LAST_CHARGE_DATE))
      : row("Subscription", "None — final week");

  // Retro owed for weeks already played — NOT charged by the form. Flagged here
  // in red so staff know to collect it manually.
  const retroRow =
    plan.missedWeeks > 0
      ? row(
          "Retro to collect (NOT charged)",
          `<span style="color:#c00">${habFormatUsd(plan.retroAmountCents)} · ${
            plan.missedWeeks
          } week${plan.missedWeeks === 1 ? "" : "s"} already played — collect separately</span>`,
        )
      : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08)">
        <tr><td style="background:#0a1628;padding:20px 28px;color:#fff">
          <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#fd5b56">Have-A-Ball · Staff Notification</p>
          <h1 style="margin:0;font-size:22px">New signup: ${escape(p.firstName)} ${escape(p.lastName)}</h1>
          <p style="margin:6px 0 0 0;font-size:13px;color:#9fb0c8">${
            midSeason
              ? `Mid-season — subscription for the ${plan.remainingCharges} remaining week${
                  plan.remainingCharges === 1 ? "" : "s"
                } created · ${habFormatUsd(plan.retroAmountCents)} retro to collect`
              : "Pre-season — full 12-week subscription created"
          }</p>
        </td></tr>

        <tr><td style="padding:24px 28px">
          <h3 style="margin:0 0 10px 0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#888">Bowler</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:20px">
            ${row("Name", `${escape(p.firstName)} ${escape(p.lastName)}`)}
            ${row("Phone", escape(p.phone || "—"))}
            ${row("Email", escape(p.email))}
            ${p.dob ? row("Date of birth", escape(p.dob)) : ""}
            ${p.teamName ? row("Team / bowling with", escape(p.teamName)) : ""}
          </table>

          <h3 style="margin:0 0 10px 0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#888">What Was Set Up</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden">
            ${subscriptionRows}
            ${retroRow}
            ${row("Subscription total (auto-charged)", habFormatUsd(plan.totalDueCents))}
            ${row("Subscription ID", `<span style="font-family:monospace;font-size:12px">${escape(p.subscriptionId)}</span>`)}
          </table>

          <p style="margin:20px 0 0 0;font-size:12px;color:#aaa">
            Reconcile in Square: the subscription bills weekly through ${habFormatDate(
              HAB_LAST_CHARGE_DATE,
            )}.${
              plan.missedWeeks > 0
                ? ` The ${habFormatUsd(plan.retroAmountCents)} retro for ${plan.missedWeeks} week${
                    plan.missedWeeks === 1 ? "" : "s"
                  } already played was NOT charged — collect it separately.`
                : ""
            }
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send both Have-A-Ball signup emails: the bowler confirmation and a separate
 * ops notification to the HeadPinz team (back-pay + subscription summary).
 * Failures are logged, not thrown — the signup already succeeded.
 */
export async function sendHabConfirmationEmail(p: HabEmailParams): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY || "";
  if (!apiKey) {
    console.error("[hab/email] Missing SENDGRID_API_KEY — skipping signup emails");
    return;
  }

  const send = async (to: { email: string }[], subject: string, html: string, label: string) => {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });
      if (!res.ok) {
        console.error(
          `[hab/email] ${label} send error:`,
          res.status,
          (await res.text()).slice(0, 300),
        );
      }
    } catch (err) {
      console.error(`[hab/email] ${label} send threw:`, err);
    }
  };

  const staffSubject =
    p.plan.missedWeeks > 0
      ? `Have-A-Ball signup: ${p.firstName} ${p.lastName} — subscription (${p.plan.remainingCharges} wk) + ${habFormatUsd(p.plan.retroAmountCents)} retro to collect`
      : `Have-A-Ball signup: ${p.firstName} ${p.lastName} — subscription (${p.plan.remainingCharges} wk)`;

  await Promise.all([
    send(
      [{ email: p.email }],
      `You're in the Have-A-Ball League, ${p.firstName}!`,
      renderHabEmail(p),
      "bowler",
    ),
    send(
      TEAM_BCC.map((email) => ({ email })),
      staffSubject,
      renderHabStaffEmail(p),
      "staff",
    ),
  ]);
}
