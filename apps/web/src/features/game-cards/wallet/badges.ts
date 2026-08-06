/**
 * The Apple/Google "Add to Wallet" badges — ONE definition, four surfaces.
 *
 * Started life inside `app/v/[code]/VoucherRedeemView.tsx` with a hand-written
 * HTML copy in `voucher-mail.ts`. Two more surfaces now need them (the VIP
 * welcome email and the booking confirmation page), and four hand-maintained
 * copies of "158×50 / 181×50" is how the two badges quietly drift out of the
 * matched set the vendors ship them as.
 *
 * Pure data plus one string builder — no JSX, no React, no `next/*` import — so
 * a client component, a server component and a raw-HTML email builder can all
 * import the same array. The RENDERING is deliberately NOT shared: each surface
 * needs its own container (see WHITE PANEL below), and a component taking a
 * className escape hatch would share nothing that actually drifts.
 *
 * ── USE THE VENDORS' OWN ARTWORK, UNMODIFIED ────────────────────────────────
 * Apple and Google publish these files precisely so nobody re-sets the wordmark
 * in their own type, and Google's guidelines say it outright: "Do not create
 * your own Add to Google Wallet buttons or alter the font, color, button radius,
 * or padding within the button in any way." What used to be on `/v/` — a text
 * label in a Tailwind pill — was exactly that prohibited thing.
 *
 * Renderers must therefore carry `eslint-disable @next/next/no-img-element`:
 * `next/image` would re-encode the asset, and byte-for-byte is the whole point.
 *
 * ── THE WIDTHS DIFFER ON PURPOSE ────────────────────────────────────────────
 * `width` is each badge's natural width at the shared 50px height (Apple's SVG
 * is 110.739×35.016, Google's is 199×55), measured from the files rather than
 * guessed. NEVER stretch one to match its neighbour. 50px clears Google's stated
 * 48dp minimum; a 12px gap between them clears Google's 8dp and Apple's .1X
 * clear space.
 *
 * Google ships two shapes and we take the TWO-LINE badge, not the wider one-line
 * button, because Apple only ships two-line: 158×50 beside 181×50 reads as a
 * matched set, where the one-line button's 283×50 read as a mismatch.
 *
 * ── SVG ON PAGES, PNG IN EMAIL ──────────────────────────────────────────────
 * Gmail and Outlook do not render SVG in mail, so email surfaces take the `png`
 * field: @2x rasters of the official SVGs (a format conversion, not a redraw —
 * Apple ships only SVG and EPS), served at half their pixel size via explicit
 * width/height so they stay sharp on retina.
 *
 * ── WHITE PANEL ON A DARK CARD ──────────────────────────────────────────────
 * Apple's standard badge is the black fill with a #A6A6A6 hairline, drawn for
 * light backgrounds, and the only variant Google ships is #1F1F1F. Both sit
 * muddily on our dark surfaces. Every dark-background caller wraps them in a
 * light panel — the clear-space rules govern space AROUND a badge, so a
 * container is fair game where restyling the badge is not.
 *
 * ── ENGLISH ONLY, FOR NOW ───────────────────────────────────────────────────
 * None of the surfaces that render these has a locale (`/v/`, the confirmation
 * page and both emails are English). Apple ships 45 locales (US_UK, ESMX, …) and
 * Google ships esUS, so the Spanish files drop in beside these — as a second
 * `es` field here, not a second array — the day one of them learns about locale.
 */

import type { WalletPlatform } from "./platform";

export interface WalletBadge {
  platform: WalletPlatform;
  /** Full label. Also the `alt`, which is what most mail clients show first. */
  label: string;
  /** Page surfaces. Root-relative. */
  svg: string;
  /** Email surfaces. Root-relative — callers prefix an absolute origin. */
  png: string;
  /** Natural width at `BADGE_HEIGHT`. Measured from the file; never rounded. */
  width: number;
}

/** Shared render height for both badges. */
export const BADGE_HEIGHT = 50;

export const WALLET_BADGES: readonly WalletBadge[] = [
  {
    platform: "apple",
    label: "Add to Apple Wallet",
    svg: "/brand/wallet/apple-wallet-en.svg",
    png: "/brand/wallet/apple-wallet-en@2x.png",
    width: 158,
  },
  {
    platform: "google",
    label: "Add to Google Wallet",
    svg: "/brand/wallet/google-wallet-en.svg",
    png: "/brand/wallet/google-wallet-en@2x.png",
    width: 181,
  },
];

/**
 * Where a badge tap goes: OUR route, never a PassKit link.
 *
 * `/v/{code}/wallet` re-checks Neon at tap time (voided / expired / fully spent)
 * and creates the pass on first ask, because PassKit bills single-use passes AT
 * ISSUANCE and most guests never add one. A distribution link signed at mint
 * time could do neither.
 *
 * The platform is always STATED rather than left to the route's UA sniffing —
 * the guest already told us which button they pressed, and a badge that says
 * "Apple" must never hand back a `.gpay`.
 */
export function walletBadgeHref(redeemUrl: string, platform: WalletPlatform): string {
  return `${redeemUrl.replace(/\/$/, "")}/wallet?platform=${platform}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Both badges as email HTML — absolute-URL @2x PNGs, one `<a>` each.
 *
 * `origin` is required and absolute because a mail client has no origin to
 * resolve a root-relative `src` against; a relative path renders as a broken
 * image in every client.
 *
 * `panel` wraps the pair in a white plate for callers whose card is dark (see
 * WHITE PANEL above). Light-carded callers pass `false` and keep their own
 * background.
 */
export function walletBadgesEmailHtml(args: {
  /** The `/v/{code}` URL. `/wallet?platform=…` is appended per badge. */
  redeemUrl: string;
  /** Absolute site origin, e.g. `https://headpinz.com`. */
  origin: string;
  align?: "left" | "center";
  panel?: boolean;
}): string {
  const origin = args.origin.replace(/\/$/, "");
  const align = args.align ?? "left";
  const links = WALLET_BADGES.map(
    (b) =>
      `<a href="${esc(walletBadgeHref(args.redeemUrl, b.platform))}" ` +
      `style="text-decoration:none;display:inline-block;margin:0 6px 6px 6px;">` +
      `<img src="${esc(origin + b.png)}" width="${b.width}" height="${BADGE_HEIGHT}" ` +
      `alt="${esc(b.label)}" ` +
      `style="display:block;border:0;width:${b.width}px;height:${BADGE_HEIGHT}px;"></a>`,
  ).join("");

  if (args.panel === false) {
    return `<div style="text-align:${align};font-size:0;line-height:0;">${links}</div>`;
  }
  // Table, not a div: Outlook ignores padding + border-radius on a div, which
  // would collapse the plate onto the badges' own edges.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:separate;${align === "center" ? "margin:0 auto;" : ""}">` +
    `<tr><td style="background:#ffffff;border-radius:12px;padding:10px 6px;font-size:0;line-height:0;">` +
    `${links}</td></tr></table>`
  );
}
