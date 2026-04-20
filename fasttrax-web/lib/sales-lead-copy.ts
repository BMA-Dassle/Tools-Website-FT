/**
 * SMS + email copy for the sales-lead flow.
 *
 * All copy lives here so the preview route (`/api/sales-lead/preview`) and
 * the submit endpoint render the same text/HTML. Tweak template strings
 * here to iterate without touching route handlers.
 *
 * Brand strategy:
 *   - Centers that include "HeadPinz" in the name → HP palette (coral +
 *     navy) + "bowling, laser tag, arcade, Nemo's wings" hype.
 *   - Centers that include "FastTrax" → FT palette (cyan + navy) +
 *     "fastest karting in Southwest Florida" hype + Event Guide PDF link.
 *
 * Event-guide PDF exists only for FastTrax at the moment (HP doesn't
 * have one yet), so the `fasttrax` branch is the only one that surfaces
 * an Event Guide CTA in SMS or email.
 */

// ── Brand assets (verified working URLs) ────────────────────────────────────

const HEADPINZ_LOGO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logos/headpinz-logo-9aUwk9v1Z8LcHZP5chi50PnSbDWpSg.png";
const FASTTRAX_LOGO_URL =
  "https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png";

/**
 * Hero banner images. Same assets the site uses on its group-events pages.
 * webp is supported in Gmail / Apple Mail / Outlook.com but NOT in classic
 * Outlook for Windows (Word rendering engine) — those users see the alt
 * text instead. Acceptable tradeoff vs. maintaining JPG duplicates.
 */
const HEADPINZ_HERO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/cta-wide.webp";
const FASTTRAX_HERO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/subpages/group-events-hero.webp";

const FASTTRAX_EVENT_GUIDE_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/documents/FastTrax-Event-Guide.pdf";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SalesLeadCopyContext {
  firstName: string;
  /** H#### project number from Pandora. */
  projectNumber: string;
  plannerName: string;
  /** E.164 — "+12392148353". */
  plannerPhone: string;
  plannerEmail: string;
  /** ISO date "YYYY-MM-DD". */
  preferredDate: string;
  /** e.g. "HeadPinz Naples", "FastTrax Fort Myers" (drives brand palette). */
  centerName: string;
  /** Individual planner (Stephanie/Lori/Kelsea) vs Guest Services fallback. */
  isIndividualPlanner: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function formatPhoneDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const ten = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  if (ten.length !== 10) return e164;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

function formatDate(iso: string): string {
  if (!iso || iso === "soon") return "your preferred date";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Detect which brand based on center name. Single source of truth for
 * every per-brand switch below (palette, logo, hero, event-guide link).
 */
function detectBrand(centerName: string): {
  brand: "hp" | "ft";
  primary: string;
  secondary: string;
  logoUrl: string;
  logoWidth: number;
  heroUrl: string;
  wordmark: string;
  tagline: string;
  eventGuideUrl: string | null;
  hypeVerb: string; // verb for fun intro line
  hypeList: string; // "bowling, laser tag, arcade & Nemo's wings"
} {
  const hp = centerName.toLowerCase().includes("headpinz");
  if (hp) {
    return {
      brand: "hp",
      primary: "#fd5b56", // coral
      secondary: "#123075", // navy
      logoUrl: HEADPINZ_LOGO_URL,
      logoWidth: 160,
      heroUrl: HEADPINZ_HERO_URL,
      wordmark: "HeadPinz",
      tagline: "BOWLING · LASER TAG · GEL BLASTERS · ARCADE · NEMO'S",
      eventGuideUrl: null,
      hypeVerb: "plan",
      hypeList: "bowling, laser tag, gel blasters, arcade games, and Nemo's famous wings",
    };
  }
  return {
    brand: "ft",
    primary: "#00E2E5", // cyan
    secondary: "#123075", // navy
    logoUrl: FASTTRAX_LOGO_URL,
    logoWidth: 180,
    heroUrl: FASTTRAX_HERO_URL,
    wordmark: "FastTrax",
    tagline: "FLORIDA'S LARGEST INDOOR KARTING TRACK",
    eventGuideUrl: FASTTRAX_EVENT_GUIDE_URL,
    hypeVerb: "build",
    hypeList: "Florida's largest indoor karting track, arcade games, and event catering",
  };
}

// ── SMS ─────────────────────────────────────────────────────────────────────

export function buildSalesLeadSms(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  const b = detectBrand(ctx.centerName);
  const guideLine = b.eventGuideUrl ? `\n\nPeek at the Event Guide: ${b.eventGuideUrl}` : "";

  if (ctx.isIndividualPlanner) {
    const hype =
      b.brand === "ft"
        ? `excited to help you build something epic on the track`
        : `excited to help you put together a night your crew won't stop talking about`;
    return (
      `Hey ${ctx.firstName}! This is ${ctx.plannerName} at ${ctx.centerName} — ` +
      `thanks for your event inquiry #${ctx.projectNumber}. I'll be your event ` +
      `planner and I'm ${hype}. Reach me direct at ${phone} or reply here — ` +
      `I'll follow up shortly with package options!${guideLine}`
    );
  }
  return (
    `Hey ${ctx.firstName}! Thanks for your event inquiry #${ctx.projectNumber} at ` +
    `${ctx.centerName}. Our Guest Services team will reach out shortly with ` +
    `package options. Questions? Call ${phone}.${guideLine}`
  );
}

// ── Email subject + plain text ──────────────────────────────────────────────

export function buildSalesLeadEmailSubject(ctx: SalesLeadCopyContext): string {
  return `Let's ${detectBrand(ctx.centerName).hypeVerb} your ${ctx.centerName} event! (#${ctx.projectNumber})`;
}

export function buildSalesLeadEmailText(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  const dateLine = formatDate(ctx.preferredDate);
  const b = detectBrand(ctx.centerName);
  const guideLine = b.eventGuideUrl ? `\n\nWhile you wait, grab our Event Guide:\n${b.eventGuideUrl}` : "";

  if (ctx.isIndividualPlanner) {
    return [
      `Hey ${ctx.firstName}!`,
      ``,
      `Thanks for reaching out about an event at ${ctx.centerName} — we're ready to ${b.hypeVerb} you something unforgettable! I'm ${ctx.plannerName}, your dedicated event planner for inquiry #${ctx.projectNumber}.`,
      ``,
      `${ctx.centerName} is Southwest Florida's premier spot for ${b.hypeList}. I'll follow up shortly with package options and availability for ${dateLine}. In the meantime, you can reach me directly any time:`,
      ``,
      `  ${ctx.plannerName}`,
      `  Phone: ${phone}`,
      `  Email: ${ctx.plannerEmail}`,
      guideLine,
      ``,
      `Talk soon!`,
      `${ctx.plannerName}`,
      `${ctx.centerName}`,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  return [
    `Hey ${ctx.firstName}!`,
    ``,
    `Thanks for your event inquiry #${ctx.projectNumber} at ${ctx.centerName} — Southwest Florida's premier spot for ${b.hypeList}.`,
    ``,
    `Our Guest Services team will follow up shortly with package options and availability for ${dateLine}. Reach us anytime:`,
    ``,
    `  Guest Services`,
    `  Phone: ${phone}`,
    `  Email: ${ctx.plannerEmail}`,
    guideLine,
    ``,
    `Talk soon!`,
    `${ctx.centerName}`,
  ].join("\n");
}

// ── Email HTML ──────────────────────────────────────────────────────────────
//
// Light/white background, hero banner image at the top, brand gradient
// stripes, big fun headline, and a CTA section (Event Guide) for FastTrax
// only. Readable in both light-mode and dark-mode clients because we use
// a neutral white card on a soft grey page — no hard-coded dark bg that
// fights a light-theme inbox.

export function buildSalesLeadEmailHtml(ctx: SalesLeadCopyContext): string {
  const phone = formatPhoneDisplay(ctx.plannerPhone);
  const dateLine = formatDate(ctx.preferredDate);
  const b = detectBrand(ctx.centerName);

  // Gradient stripe mirroring the site: brand → white(60%) → navy.
  const stripeGradient =
    b.brand === "hp"
      ? `linear-gradient(90deg, ${b.primary} 0%, rgba(255,255,255,0.7) 50%, ${b.secondary} 100%)`
      : `linear-gradient(90deg, ${b.primary} 0%, rgba(255,255,255,0.5) 50%, ${b.secondary} 100%)`;

  const hype =
    b.brand === "ft"
      ? `We're ready to build something epic on the track`
      : `We're ready to plan a night your crew won't stop talking about`;
  const srOnlyPreview = `${hype} — full of fun and Southwest Florida's premier entertainment. Quick note from ${ctx.plannerName} about your ${ctx.centerName} event inquiry #${ctx.projectNumber}.`;

  const plannerIntro = ctx.isIndividualPlanner
    ? `
        <p style="margin: 0 0 16px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          Thanks for reaching out about an event at <strong>${ctx.centerName}</strong> — <em>we're ready to ${b.hypeVerb} you something unforgettable!</em>
        </p>
        <p style="margin: 0 0 16px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          I'm <strong style="color: ${b.primary};">${ctx.plannerName}</strong>, your dedicated event planner for inquiry <strong>#${ctx.projectNumber}</strong>. ${ctx.centerName} is Southwest Florida's premier spot for <strong>${b.hypeList}</strong>, and I'll make sure your ${dateLine} event is dialed in.
        </p>
        <p style="margin: 0 0 28px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          I'll follow up shortly with package options and availability. In the meantime, you can reach me direct any time:
        </p>
      `
    : `
        <p style="margin: 0 0 16px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          Thanks for your event inquiry <strong>#${ctx.projectNumber}</strong> — we're excited to help you ${b.hypeVerb} it!
        </p>
        <p style="margin: 0 0 16px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          <strong>${ctx.centerName}</strong> is Southwest Florida's premier spot for <strong>${b.hypeList}</strong>. Our Guest Services team will follow up shortly with package options and availability for <strong>${dateLine}</strong>.
        </p>
        <p style="margin: 0 0 28px 0; font-size: 17px; line-height: 1.6; color: #1a1a2e;">
          Need to reach us first?
        </p>
      `;

  const eventGuideBlock = b.eventGuideUrl
    ? `
          <!-- Event Guide CTA (FastTrax only) -->
          <tr>
            <td style="padding: 8px 32px 28px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f7fb; border-radius: 12px; border: 1px solid #e1e7ef;">
                <tr>
                  <td style="padding: 22px 24px; text-align: center;">
                    <div style="font-size: 11px; letter-spacing: 3px; color: ${b.primary}; text-transform: uppercase; font-weight: 800; margin-bottom: 8px;">
                      While you wait
                    </div>
                    <div style="font-size: 18px; font-weight: 800; color: #1a1a2e; margin-bottom: 16px;">
                      Peek at the full Event Guide
                    </div>
                    <div style="font-size: 14px; color: #4a5568; line-height: 1.5; margin-bottom: 18px;">
                      Packages, floor plans, catering menus, and pricing — everything you need to start dreaming up the day.
                    </div>
                    <a href="${b.eventGuideUrl}" style="display:inline-block; background: ${b.primary}; color: #000418; text-decoration: none; padding: 13px 28px; border-radius: 999px; font-weight: 800; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">
                      Download Event Guide
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
      `
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Event Inquiry #${ctx.projectNumber}</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color:#1a1a2e; -webkit-font-smoothing: antialiased;">
  <!-- Preheader (hidden preview text in inbox list) -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; color:#f4f5f7; font-size:1px; line-height:1px;">
    ${srOnlyPreview}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f4f5f7;">
    <tr>
      <td align="center" style="padding: 32px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow: 0 8px 28px rgba(0,4,24,0.12);">

          <!-- Hero banner image with gradient overlay + brand wordmark -->
          <tr>
            <td style="position: relative; padding: 0; font-size: 0; line-height: 0;">
              <img src="${b.heroUrl}" alt="${b.wordmark} event" width="600" style="display:block; width:100%; max-width:600px; height:auto; border:0;" />
            </td>
          </tr>

          <!-- Brand stripe below hero -->
          <tr>
            <td style="background: ${stripeGradient}; height: 4px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Logo + tagline -->
          <tr>
            <td style="padding: 26px 32px 18px 32px; text-align: center;">
              <img src="${b.logoUrl}" alt="${b.wordmark}" width="${b.logoWidth}" style="display:inline-block; max-width: ${b.logoWidth}px; height: auto; border: 0;" />
              <div style="font-size: 10px; letter-spacing: 2.5px; color: #6b7280; text-transform: uppercase; font-weight: 700; margin-top: 10px;">
                ${b.tagline}
              </div>
            </td>
          </tr>

          <!-- Eyebrow + big headline -->
          <tr>
            <td style="padding: 0 32px 4px 32px;">
              <div style="font-size: 11px; letter-spacing: 3px; color: ${b.primary}; text-transform: uppercase; font-weight: 800; margin-bottom: 10px;">
                Event Inquiry &middot; #${ctx.projectNumber}
              </div>
              <div style="font-size: 32px; line-height: 1.05; font-weight: 900; color: #1a1a2e; letter-spacing: -0.8px; font-style: italic; text-transform: uppercase;">
                Let's do this, ${ctx.firstName}!
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 22px 32px 8px 32px;">
              ${plannerIntro}
            </td>
          </tr>

          <!-- Contact card — brand-tinted left stripe -->
          <tr>
            <td style="padding: 0 32px 20px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f9fafc; border: 1px solid #e1e7ef; border-radius: 12px; overflow: hidden;">
                <tr>
                  <td style="background: ${stripeGradient}; height: 4px; font-size: 0; line-height: 0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding: 22px 24px;">
                    <div style="font-size: 10px; letter-spacing: 3px; color: ${b.primary}; text-transform: uppercase; font-weight: 800; margin-bottom: 10px;">
                      ${ctx.isIndividualPlanner ? "Your Event Planner" : "Guest Services"}
                    </div>
                    <div style="font-size: 22px; font-weight: 800; color: #1a1a2e; margin-bottom: 16px; letter-spacing: -0.3px;">
                      ${ctx.plannerName}
                    </div>
                    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
                      <tr>
                        <td style="padding: 6px 0;">
                          <a href="tel:${ctx.plannerPhone}" style="color: #1a1a2e; text-decoration: none; font-size: 15px;">
                            <span style="color: ${b.primary}; font-weight: 800; letter-spacing: 1px;">CALL</span>
                            <span style="color: #cbd5e0; padding: 0 8px;">|</span>
                            <strong>${phone}</strong>
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0;">
                          <a href="mailto:${ctx.plannerEmail}" style="color: #1a1a2e; text-decoration: none; font-size: 15px;">
                            <span style="color: ${b.primary}; font-weight: 800; letter-spacing: 1px;">EMAIL</span>
                            <span style="color: #cbd5e0; padding: 0 8px;">|</span>
                            <strong>${ctx.plannerEmail}</strong>
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${eventGuideBlock}

          <!-- Signoff -->
          <tr>
            <td style="padding: 4px 32px 28px 32px;">
              <p style="margin: 0 0 4px 0; font-size: 16px; color: #1a1a2e;">Can't wait,</p>
              <p style="margin: 0; font-size: 16px; color: #1a1a2e;">
                <strong>${ctx.plannerName}</strong>
                <span style="color: #6b7280; font-weight: 400;"> &middot; ${ctx.centerName}</span>
              </p>
            </td>
          </tr>

          <!-- Bottom brand stripe -->
          <tr>
            <td style="background: ${stripeGradient}; height: 4px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 18px 32px 22px 32px; background: #f9fafc;">
              <p style="margin: 0; font-size: 10px; color: #8895a6; text-align: center; letter-spacing: 2px; text-transform: uppercase;">
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
