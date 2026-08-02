/**
 * T-60 "Your VIP Experience is almost here" email + SMS builders.
 *
 * Fired by /api/cron/vip-almost-here ~1 hour before an Ultimate VIP combo's
 * first itinerary step. Pure over its args (no registry/DB reads) so copy is
 * unit-testable; the cron resolves the combo group, start time, and contact.
 *
 * Check-in instructions are FastTrax-side by design — the combo always starts
 * at FastTrax (owner 2026-08-01): side door, first floor, turn left, Group
 * Event counter. If a future combo starts elsewhere these builders need a
 * per-combo instructions variant before that combo ships.
 *
 * NOT exported from the combos barrel (index.ts) — same rule as
 * vip-welcome.ts / combo-notify.ts: notification concerns stay out of client
 * bundles.
 */

/**
 * GSM-7 discipline (see vip-welcome.ts): any non-ASCII character pushes the
 * message into UCS-2 and multiplies the billed segments.
 */
const NON_GSM7_RE = /[^\x00-\x7F]/;

/** Guest-facing check-in instructions — single source for both channels. */
const CHECKIN_INSTRUCTIONS_TEXT =
  "To check in, enter through the side door of FastTrax on the first floor, " +
  "turn left when entering, and we'll check you in at our Group Event counter.";

export interface VipAlmostHereEmailArgs {
  /** Combo display name, e.g. "Ultimate VIP Experience". */
  comboName: string;
  /** Guest first name; caller falls back to "there". */
  guestFirstName: string;
  /** Pre-formatted ET start time label, e.g. "6:00 PM". */
  startTimeLabel: string;
}

export function buildVipAlmostHereEmail(args: VipAlmostHereEmailArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const { comboName, guestFirstName, startTimeLabel } = args;
  const subject = `Your VIP Experience is almost here — see you at ${startTimeLabel}`;
  const text =
    `Hey ${guestFirstName}! Your ${comboName} kicks off at ${startTimeLabel}. ` +
    CHECKIN_INSTRUCTIONS_TEXT;
  // Same table-email conventions as bowling-lane-ready-notify.ts buildEmailHtml
  // (light-scheme lock, 600px card) with the vip-welcome gold accent so the
  // message reads as part of the VIP thread the guest already received.
  const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <style type="text/css">
    :root { color-scheme: light; supported-color-schemes: light; }
    body { margin: 0; padding: 0; background-color: #F2F3F5; -webkit-text-size-adjust: 100%; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#F2F3F5;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F2F3F5;">
<tr>
<td align="center" style="padding: 20px 10px;">

<table width="600" cellpadding="0" cellspacing="0" style="background-color:#FFFFFF; border-radius:8px; overflow:hidden; border: 1px solid #E0E0E0;">

<!-- HEADER LOGOS -->
<tr>
<td style="padding: 24px 40px; background-color: #000418;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="left" width="50%">
  <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png" width="130" alt="FastTrax" style="height:auto;" />
</td>
<td align="right" width="50%">
  <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/hp_logo%201.png" width="130" alt="HeadPinz" style="height:auto;" />
</td>
</tr>
</table>
</td>
</tr>

<!-- HEADLINE -->
<tr>
<td align="center" style="padding: 28px 40px 8px 40px; font-family: Arial, sans-serif;">
<p style="margin: 0 0 6px 0; font-size: 12px; font-weight: bold; color: #B8860B; letter-spacing: 2px; text-transform: uppercase;">${comboName}</p>
<h1 style="margin: 0; font-size: 24px; color: #1A1A1A; letter-spacing: 1px; text-transform: uppercase;">
  Your VIP Experience Is Almost Here!
</h1>
</td>
</tr>

<!-- BODY -->
<tr>
<td style="padding: 12px 40px 8px 40px; font-family: Arial, sans-serif;">
<p style="margin: 0 0 16px; font-size: 15px; color: #333333; line-height: 1.6; text-align: center;">
  Hey ${guestFirstName}! Your <strong>${comboName}</strong> kicks off at <strong>${startTimeLabel}</strong>.
</p>
</td>
</tr>

<!-- CHECK-IN CARD -->
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0" style="background-color: #FFFBEB; border: 2px solid #B8860B; border-radius: 6px;">
<tr><td align="center" style="font-size: 13px; font-weight: bold; color: #B8860B; letter-spacing: 1px; text-transform: uppercase;">How to check in</td></tr>
<tr><td style="font-size: 15px; color: #333333; line-height: 1.7; text-align: center;">
  Enter through the <strong>side door of FastTrax on the first floor</strong>, turn left when entering, and we'll check you in at our <strong>Group Event counter</strong>.
</td></tr>
</table>
</td>
</tr>

<!-- FOOTER -->
<tr>
<td style="padding: 16px 40px; border-top: 1px solid #E0E0E0;">
<p style="margin:0;color:#999999;font-size:11px;text-align:center;font-family:Arial,sans-serif;">FastTrax Entertainment &mdash; HeadPinz &amp; FastTrax, Fort Myers</p>
</td>
</tr>

</table>

</td>
</tr>
</table>
</body></html>`;
  return { subject, html, text };
}

/**
 * T-60 SMS. Static on purpose — the start time lives in the email and the
 * welcome SMS the guest already has; keeping this body fixed guarantees it
 * never drifts past one GSM-7 segment. Throws at module-test time (not
 * runtime) if edited copy breaks the single-segment rule — see the unit test.
 */
export function buildVipAlmostHereSms(): string {
  const body =
    `FastTrax: Your VIP Experience is almost here! To check in, enter through ` +
    `the side door on the 1st floor, turn left, and see us at the Group Event counter.`;
  if (body.length > 160 || NON_GSM7_RE.test(body)) {
    // Unreachable unless the copy above is edited carelessly; the unit test
    // pins this. Fall back to a shorter body rather than billing 2 segments.
    return "FastTrax: Your VIP Experience is almost here! Check in at the Group Event counter, 1st floor.";
  }
  return body;
}
