/**
 * SMS + email copy for the sales-lead flow.
 *
 * All copy lives here so the preview route (`/api/sales-lead/preview`) and
 * the submit endpoint render the same text/HTML. Tweak template strings here
 * to iterate without touching route handlers.
 */

export interface SalesLeadCopyContext {
  firstName: string;
  /** H#### project number from Pandora. */
  projectNumber: string;
  /** Planner display name — "Stephanie", "Lori", "Kelsea", or "Guest Services". */
  plannerName: string;
  /** Planner direct phone in E.164 (e.g. "+12392148353"). */
  plannerPhone: string;
  /** Planner email. */
  plannerEmail: string;
  /** ISO date string ("2026-05-04") or "soon" when not provided. */
  preferredDate: string;
  /** HeadPinz Fort Myers, HeadPinz Naples, FastTrax Fort Myers. */
  centerName: string;
  /** Whether the planner is a single individual (Stephanie/Lori/Kelsea) or the guest-services bucket. */
  isIndividualPlanner: boolean;
}

/** Pretty-format a phone for display: "+12392148353" → "(239) 214-8353". */
export function formatPhoneDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const ten = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  if (ten.length !== 10) return e164;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** Pretty-format ISO date ("2026-05-04") → "Monday, May 4, 2026". */
function formatDate(iso: string): string {
  if (!iso || iso === "soon") return "your preferred date";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

// ── SMS ─────────────────────────────────────────────────────────────────────

export function buildSalesLeadSms(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  if (ctx.isIndividualPlanner) {
    return (
      `Hi ${ctx.firstName}! This is ${ctx.plannerName} at ${ctx.centerName} — thanks for your event ` +
      `inquiry (#${ctx.projectNumber}). I'll be your event planner and can help with package ` +
      `options, pricing, and availability. Reach me direct at ${phone} or reply here. ` +
      `I'll follow up shortly!`
    );
  }
  return (
    `Hi ${ctx.firstName}! Thanks for your event inquiry (#${ctx.projectNumber}) at ${ctx.centerName}. ` +
    `Our Guest Services team will reach out shortly with package options and availability. ` +
    `Questions? Call us at ${phone}.`
  );
}

// ── Email ───────────────────────────────────────────────────────────────────

export function buildSalesLeadEmailSubject(ctx: SalesLeadCopyContext): string {
  return `${ctx.centerName} event inquiry #${ctx.projectNumber} — next steps`;
}

export function buildSalesLeadEmailText(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  const dateLine = formatDate(ctx.preferredDate);
  if (ctx.isIndividualPlanner) {
    return [
      `Hi ${ctx.firstName},`,
      ``,
      `Thanks for reaching out about an event at ${ctx.centerName}! My name is ${ctx.plannerName} and I'll be your dedicated event planner for inquiry #${ctx.projectNumber}.`,
      ``,
      `I'll be in touch shortly with package options and availability for ${dateLine}. In the meantime, feel free to reach me directly:`,
      ``,
      `  ${ctx.plannerName}`,
      `  Direct: ${phone}`,
      `  Email: ${ctx.plannerEmail}`,
      ``,
      `Talk soon!`,
      `${ctx.plannerName}`,
      `${ctx.centerName}`,
    ].join("\n");
  }
  return [
    `Hi ${ctx.firstName},`,
    ``,
    `Thanks for your event inquiry (#${ctx.projectNumber}) at ${ctx.centerName}!`,
    ``,
    `Our Guest Services team will follow up shortly with package options and availability for ${dateLine}. Reach us anytime:`,
    ``,
    `  Guest Services`,
    `  Phone: ${phone}`,
    `  Email: ${ctx.plannerEmail}`,
    ``,
    `Talk soon!`,
    `${ctx.centerName}`,
  ].join("\n");
}

// ── Brand palette — mirrors the actual live site's CSS usage ─────────────────
//
// HeadPinz (from app/hp/*): deep navy #0a1628 background, coral #fd5b56
// primary accent, navy #123075 secondary, gold #FFD700 highlights. Signature
// gradient stripe: from-[#fd5b56] via-white/60 to-[#123075].
//
// FastTrax (from app/group-events, etc.): deeper navy #000418 background,
// cyan #00E2E5 primary accent.
//
// Logos are hosted on Vercel Blob — the same URLs the live site uses.

// Verified working URLs (checked via curl — webp not widely supported in email
// clients so we use PNG variants). The HP logo here is the same asset referenced
// in `app/book/race/components/AddOnsPage.tsx:6`; the FT logo is the one used in
// the existing SMS-Timing booking-confirmation template at
// `fasttrax-web/emails/booking-confirmation-waiver.html:75`.
const HEADPINZ_LOGO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";
const FASTTRAX_LOGO_URL =
  "https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png";

export function buildSalesLeadEmailHtml(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  const dateLine = formatDate(ctx.preferredDate);
  const hpBrand = ctx.centerName.toLowerCase().includes("headpinz");

  // Real brand tokens — exact hex values the live site uses on hp/* pages.
  const bgDeep    = hpBrand ? "#0a1628" : "#000418";
  const bgCard    = hpBrand ? "#0f1d36" : "#071027";
  const primary   = hpBrand ? "#fd5b56" : "#00E2E5"; // coral for HP, cyan for FT
  const secondary = hpBrand ? "#123075" : "#123075"; // navy blue secondary
  const logoUrl   = hpBrand ? HEADPINZ_LOGO_URL : FASTTRAX_LOGO_URL;
  const logoWidth = hpBrand ? 160 : 180;
  const brandName = hpBrand ? "HeadPinz" : "FastTrax";

  // Signature gradient stripe — exact copy of `bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]`
  // pattern used across the hp/* pages (menu, kids-bowl-free, etc.). Cyan for FT.
  const stripeGradient = hpBrand
    ? `linear-gradient(90deg, ${primary} 0%, rgba(255,255,255,0.6) 50%, ${secondary} 100%)`
    : `linear-gradient(90deg, ${primary} 0%, rgba(255,255,255,0.4) 50%, ${secondary} 100%)`;

  const plannerIntro = ctx.isIndividualPlanner
    ? `
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.65; color: #ffffffe0;">
          My name is <strong style="color: ${primary};">${ctx.plannerName}</strong> and I'll be your dedicated event planner for inquiry <strong style="color:#ffffff;">#${ctx.projectNumber}</strong>.
        </p>
        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.65; color: #ffffffe0;">
          I'll reach out shortly with package options and availability for <strong style="color:#ffffff;">${dateLine}</strong>. In the meantime, you can reach me directly any time:
        </p>
      `
    : `
        <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.65; color: #ffffffe0;">
          Our <strong style="color: ${primary};">Guest Services</strong> team received your inquiry <strong style="color:#ffffff;">#${ctx.projectNumber}</strong>.
        </p>
        <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.65; color: #ffffffe0;">
          We'll follow up shortly with package options and availability for <strong style="color:#ffffff;">${dateLine}</strong>. Need to reach us first?
        </p>
      `;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Event Inquiry #${ctx.projectNumber}</title>
</head>
<body style="margin:0; padding:0; background-color:${bgDeep}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color:#ffffff; -webkit-font-smoothing: antialiased;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
    Thanks for your event inquiry${ctx.isIndividualPlanner ? `, ${ctx.plannerName} here!` : "!"} We'll follow up with package options for ${dateLine}.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${bgDeep};">
    <tr>
      <td align="center" style="padding: 32px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px; width:100%; background-color:${bgCard}; border-radius:16px; overflow:hidden; border: 1px solid rgba(255,255,255,0.06); box-shadow: 0 12px 40px rgba(0,0,0,0.4);">

          <!-- Logo header — dark with real brand logo -->
          <tr>
            <td style="padding: 28px 32px 20px 32px; text-align: center; background: ${bgCard};">
              <img src="${logoUrl}" alt="${brandName}" width="${logoWidth}" style="display:inline-block; max-width: ${logoWidth}px; height: auto; border: 0;" />
            </td>
          </tr>

          <!-- Signature gradient stripe — coral → white → navy (matches site headers) -->
          <tr>
            <td style="background: ${stripeGradient}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Hero -->
          <tr>
            <td style="padding: 36px 32px 8px 32px;">
              <div style="font-size: 11px; letter-spacing: 3px; color: ${primary}; text-transform: uppercase; font-weight: 700; margin-bottom: 12px;">
                Event Inquiry &middot; #${ctx.projectNumber}
              </div>
              <div style="font-size: 32px; line-height: 1.1; font-weight: 900; color: #ffffff; letter-spacing: -0.8px; font-style: italic; text-transform: uppercase;">
                Thanks, ${ctx.firstName}!
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 20px 32px 8px 32px;">
              ${plannerIntro}
            </td>
          </tr>

          <!-- Contact card — coral-tinted border, deeper inner bg, matches site cards -->
          <tr>
            <td style="padding: 8px 32px 20px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${bgDeep}; border: 1px solid ${primary}40; border-radius: 12px; overflow: hidden;">
                <tr>
                  <td style="background: ${stripeGradient}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding: 22px 24px;">
                    <div style="font-size: 10px; letter-spacing: 3px; color: ${primary}; text-transform: uppercase; font-weight: 700; margin-bottom: 10px;">
                      ${ctx.isIndividualPlanner ? "Your Event Planner" : "Guest Services"}
                    </div>
                    <div style="font-size: 22px; font-weight: 800; color: #ffffff; margin-bottom: 18px; letter-spacing: -0.3px;">
                      ${ctx.plannerName}
                    </div>
                    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
                      <tr>
                        <td style="padding: 6px 0;">
                          <a href="tel:${ctx.plannerPhone}" style="color: #ffffff; text-decoration: none; font-size: 15px;">
                            <span style="color: ${primary}; font-weight: 800; letter-spacing: 1px;">CALL</span>
                            <span style="color: #ffffff50; padding: 0 8px;">|</span>
                            <strong style="color:#ffffff;">${phone}</strong>
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0;">
                          <a href="mailto:${ctx.plannerEmail}" style="color: #ffffff; text-decoration: none; font-size: 15px;">
                            <span style="color: ${primary}; font-weight: 800; letter-spacing: 1px;">EMAIL</span>
                            <span style="color: #ffffff50; padding: 0 8px;">|</span>
                            <strong style="color:#ffffff;">${ctx.plannerEmail}</strong>
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Signoff -->
          <tr>
            <td style="padding: 12px 32px 28px 32px;">
              <p style="margin: 0 0 6px 0; font-size: 16px; color: #ffffffe0;">Talk soon,</p>
              <p style="margin: 0; font-size: 16px; color: #ffffff;">
                <strong style="color:#ffffff;">${ctx.plannerName}</strong>
                <span style="color: #ffffff60; font-weight: 400;"> &middot; ${ctx.centerName}</span>
              </p>
            </td>
          </tr>

          <!-- Bottom brand stripe -->
          <tr>
            <td style="background: ${stripeGradient}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px 24px 32px; background: ${bgCard};">
              <p style="margin: 0; font-size: 10px; color: #ffffff50; text-align: center; letter-spacing: 2px; text-transform: uppercase;">
                Inquiry #${ctx.projectNumber} &middot; ${ctx.centerName}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
