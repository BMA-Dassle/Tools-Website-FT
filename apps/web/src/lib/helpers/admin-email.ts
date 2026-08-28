/**
 * Chrome for STAFF email — the one place an admin alert's look and its deep
 * link into the admin site are defined.
 *
 * WHY THIS EXISTS. Staff alerts were each hand-rolling a `<div style="font-family:
 * system-ui">` and, worse, hand-writing their "go look at the board" line. The
 * deal-sale alert shipped with a literal `/admin/&lt;token&gt;/deals` in it — a
 * placeholder rendered as text, so the one action the email exists to prompt was
 * a dead end you had to go find the real URL for (owner 2026-08-03: "should
 * contain real URL with admin token and be mobile friendly … like the other
 * admin pages share css etc").
 *
 * TWO RULES IT ENFORCES:
 *
 *   THE LINK IS REAL OR IT IS ABSENT. `adminBoardUrl` builds a working URL, and
 *   a null CTA is omitted rather than rendered as a placeholder — an
 *   un-clickable link that looks clickable is worse than no link. As of the SSO
 *   lockdown (2026-08-28) the link carries NO credential: it points at the
 *   staff shell (`admin.fasttraxent.com/deals`), where the reader's own
 *   Microsoft sign-in is the credential. Before that it embedded
 *   ADMIN_CAMERA_TOKEN, which meant every alert ever sent was a copy of a
 *   permanent bearer secret sitting in an inbox — forwardable, screenshottable,
 *   and impossible to rotate without re-sending the archive.
 *
 *   IT READS ON A PHONE. Staff read these on a phone, so: one column that never
 *   needs a horizontal scroll, 16px body text (below that iOS Safari zooms),
 *   label-above-value rows rather than a two-column table that squeezes to
 *   nothing, a 44px-tall tap target, and `word-break` on the values that can be
 *   long (voucher codes, emails).
 *
 * The palette is the admin portal's (components/features/admin-skin/theme.ts —
 * navy #14223b, card #19273e, blue #3b82f6), so the mail and the board it opens
 * are recognisably the same surface. Poppins is the portal's face and won't load
 * in mail, so the stack degrades to the system sans.
 *
 * Pure except for `adminBoardUrl`, which reads env — keep it that way, it makes
 * the whole layout testable without a mail send.
 */

import { PORTAL_BLUE, PORTAL_BLUE_SOFT, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { adminToolUrl } from "./admin-url";

/**
 * Absolute, credential-free URL for an admin board — `adminBoardUrl("deals")` →
 * `https://admin.fasttraxent.com/deals` (the SSO staff shell).
 *
 * Kept as a named alias of `adminToolUrl` rather than deleted: it is the verb
 * this module's callers already speak, and the docs above hang off it. The
 * `| null` in the return type stays so callers keep their "omit the button"
 * branch — but it is now unreachable, because a link with no secret in it has
 * nothing left to be missing.
 */
export function adminBoardUrl(board: string): string | null {
  return adminToolUrl(board);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One label/value line. `mono` for codes and ids; `href` makes the value a link. */
export interface AdminEmailRow {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}

export interface AdminEmailArgs {
  /** Headline, e.g. "Deal pack sold". */
  title: string;
  /** The one number that matters, shown large beside the title (optional). */
  headlineValue?: string | null;
  /** One quiet line under the title. */
  subtitle?: string | null;
  rows: AdminEmailRow[];
  /** The action. Omitted entirely when `url` is null — see the header comment. */
  cta?: { label: string; url: string | null } | null;
  /** Small print under the card. */
  footnote?: string | null;
}

const SANS =
  "'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Cascadia Mono',Consolas,ui-monospace,SFMono-Regular,Menlo,monospace";

function rowHtml(row: AdminEmailRow): string {
  const value = escapeHtml(row.value);
  const inner = row.href
    ? `<a href="${escapeHtml(row.href)}" style="color:${PORTAL_BLUE_SOFT};text-decoration:none">${value}</a>`
    : value;
  return `
    <tr>
      <td style="padding:0 0 14px 0">
        <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:${PORTAL_DARK.muted};padding-bottom:3px">${escapeHtml(
          row.label,
        )}</div>
        <div style="font-size:16px;line-height:1.45;color:${PORTAL_DARK.fg};word-break:break-word;${
          row.mono ? `font-family:${MONO};font-size:15px` : ""
        }">${inner}</div>
      </td>
    </tr>`;
}

/**
 * Render a staff alert. Returns both parts — a text alternative is not optional
 * on transactional mail, and building it here keeps the two from drifting.
 *
 * Table-based on purpose: Outlook's Word renderer ignores most of flex/grid, and
 * `width="100%"` + `max-width:600px` is still the only layout that survives every
 * client from Gmail to a watch.
 */
export function renderAdminEmail(args: AdminEmailArgs): { html: string; text: string } {
  const ctaUrl = args.cta?.url ?? null;

  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0e1729"
       style="background:#0e1729;margin:0;padding:0;width:100%">
  <tr>
    <td align="center" style="padding:20px 12px">
      <!-- width="100%" + max-width, NOT width="600": a fixed HTML width attribute
           wins over the CSS in enough clients to push a 600px card off a 390px
           screen, which is the sideways-drag this layout exists to avoid. -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:600px;background:${PORTAL_DARK.card};border:1px solid ${PORTAL_DARK.border};border-radius:14px">
        <tr>
          <td style="padding:22px 22px 6px 22px;font-family:${SANS}">
            <div style="font-size:20px;font-weight:700;color:${PORTAL_DARK.fg};line-height:1.3">${escapeHtml(
              args.title,
            )}</div>
            ${
              args.headlineValue
                ? `<div style="font-size:30px;font-weight:700;color:${PORTAL_BLUE_SOFT};line-height:1.2;padding-top:6px">${escapeHtml(
                    args.headlineValue,
                  )}</div>`
                : ""
            }
            ${
              args.subtitle
                ? `<div style="font-size:14px;color:${PORTAL_DARK.muted};padding-top:6px;line-height:1.45">${escapeHtml(
                    args.subtitle,
                  )}</div>`
                : ""
            }
          </td>
        </tr>
        <tr>
          <td style="padding:18px 22px 4px 22px;font-family:${SANS}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${args.rows.map(rowHtml).join("")}
            </table>
          </td>
        </tr>
        ${
          ctaUrl
            ? `<tr>
                 <td style="padding:6px 22px 24px 22px;font-family:${SANS}">
                   <a href="${escapeHtml(ctaUrl)}"
                      style="display:block;background:${PORTAL_BLUE};color:#ffffff;text-decoration:none;
                             font-size:16px;font-weight:600;text-align:center;padding:14px 20px;
                             border-radius:10px;min-height:20px">${escapeHtml(args.cta!.label)}</a>
                 </td>
               </tr>`
            : ""
        }
      </table>
      ${
        args.footnote
          ? `<div style="max-width:600px;font-family:${SANS};font-size:12px;line-height:1.5;color:${PORTAL_DARK.muted};padding:12px 6px 0 6px;text-align:center">${escapeHtml(
              args.footnote,
            )}</div>`
          : ""
      }
    </td>
  </tr>
</table>`;

  const text = [
    args.headlineValue ? `${args.title} — ${args.headlineValue}` : args.title,
    ...(args.subtitle ? [args.subtitle] : []),
    "",
    ...args.rows.map((r) => `${r.label}: ${r.value}`),
    ...(ctaUrl ? ["", `${args.cta!.label}: ${ctaUrl}`] : []),
    ...(args.footnote ? ["", args.footnote] : []),
  ].join("\n");

  return { html, text };
}
