/**
 * Server component. It was "use client" only for the card-load form's state; with
 * that gone the whole view is presentation over props, so rendering it on the
 * server keeps it out of the client bundle entirely.
 */
import {
  IconCalendarEvent,
  IconCheck,
  IconDeviceGamepad2,
  IconMail,
  IconQrcode,
} from "@tabler/icons-react";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import { formatVoucherExpiry, groupVoucherItems } from "~/features/game-cards/vouchers/display";
import type { VoucherStatus } from "~/features/game-cards/service/native-voucher";

/**
 * Guest voucher redemption — put the value on a card they already have.
 *
 * Per-item state is rendered, not a single verdict: a multi-item voucher is
 * partly redeemable, so a spent Game Zone line must not make the page read
 * "used" while other value is still live.
 *
 * There is no dispenser on a phone. A guest with no card is told to scan the
 * code at a kiosk instead of being dead-ended — that path DOES issue a card.
 */

/** Refusal → guest copy. Every reason is phrased: nobody is standing there.
 *
 *  NOTHING here sends a guest to Guest Services. Redemption happens at a KIOSK
 *  (owner 2026-08-03: "NOT redeemable at guest services you must see kiosk") —
 *  the desk cannot dispense a card or apply these codes, so pointing someone
 *  there sends them to be turned around. */
/** The two wallets, named explicitly so the route never has to guess from a
 *  user agent — see app/v/[code]/wallet/route.ts. */
const WALLETS = [
  { platform: "apple", label: "Add to Apple Wallet" },
  { platform: "google", label: "Add to Google Wallet" },
] as const;

const REASON_COPY: Record<string, string> = {
  bad_format: "That code doesn’t look right — check it and try again.",
  unknown: "We couldn’t find that voucher.",
  voided: "That voucher was cancelled. Please contact us and we’ll sort it out.",
  expired: "That voucher has expired.",
  used: "Everything on this voucher has been used.",
  not_redeemable: "There’s nothing on this voucher to load onto a card.",
  card_not_found: "We couldn’t find that card number. Check the number on the back of your card.",
  card_lookup_failed: "We couldn’t reach the card system just now — please try again shortly.",
  rate_limited: "Too many tries. Give it a few minutes and try again.",
  storage: "Something went wrong on our end — nothing was used. Please try again.",
};

export function VoucherRedeemView({
  status,
  qrDataUri = null,
  justBought = false,
  siblingCodes = [],
}: {
  status: VoucherStatus;
  /** Server-rendered QR of this voucher's /v URL. Null only if generation failed. */
  qrDataUri?: string | null;
  /** Arrived straight from checkout (`?bought=1`) — lead with the receipt tone. */
  justBought?: boolean;
  /** Other codes from the SAME purchase. Server-gated on a purchase row so an
   *  admin comp batch can never leak strangers' codes here. */
  siblingCodes?: string[];
}) {
  const notHere = status.items.filter((i) => !i.redeemable && !i.spent);

  /**
   * Unspent attraction legs, grouped by what they book.
   *
   * These are NOT redeemable on this page — a laser-tag entitlement is spent by
   * covering a line in a booking cart, not by crediting a card — but "at Guest
   * Services" was the only thing we ever said about them, which sent guests to a
   * desk for something they can do themselves. The cart-coverage rail exists, so
   * link straight into the booking wizard with the code pre-applied.
   *
   * An `attraction-choice` leg (laser tag OR gel blaster) offers each option; the
   * coverage planner covers whichever one actually ends up in the cart.
   */
  const bookable = (() => {
    const bySlug = new Map<string, number>();
    for (const i of notHere) {
      const slugs =
        i.item.kind === "attraction"
          ? [i.item.slug]
          : i.item.kind === "attraction-choice"
            ? i.item.slugs
            : [];
      for (const slug of slugs) bySlug.set(slug, (bySlug.get(slug) ?? 0) + 1);
    }
    return [...bySlug.entries()].map(([slug, count]) => ({ slug, count }));
  })();

  const prettySlug = (slug: string) =>
    slug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  const voided = !!status.voidedAt;
  // Server-resolved (see VoucherStatus.expired) — never read the clock here.
  const expired = status.expired;
  const expiryText = formatVoucherExpiry(status.expiresAt);
  /** Identical legs collapsed to counted rows (kiosk receipt behaviour). */
  const itemGroups = groupVoucherItems(status.items);
  /** Nothing left to do with it — used to dim the QR rather than imply it scans. */
  const allDone = status.items.every((i) => i.spent);

  return (
    // Renders INSIDE the brand chrome (fixed nav + dark site bg). Mirror the
    // /reload idiom: a fixed dark backdrop so contrast is ours, top padding to
    // clear the fixed nav, white-on-dark card. (Light-on-dark was the bug —
    // invisible under the real chrome.)
    <>
      <div className="fixed inset-0 -z-10 bg-[#00041b]" aria-hidden="true" />
      {/* Phone-first column, but NOT a 448px strip stranded on a desktop: from lg
          the scannable half and the "what's on it / what to do" half sit side by
          side, which is also the more useful shape — you hold the QR up while
          reading the list. */}
      <main className="mx-auto min-h-screen max-w-md px-5 pt-32 pb-16 text-white sm:pt-36 lg:max-w-5xl lg:pt-40">
        {justBought ? (
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#46d68c] text-[#00041b]">
              <IconCheck size={24} stroke={3} />
            </span>
            <div>
              <p
                className="text-xs font-bold tracking-[0.2em] uppercase"
                style={{ color: "#46d68c" }}
              >
                Payment complete
              </p>
              <h1 className="font-display mt-1 text-3xl text-white sm:text-4xl">
                You&apos;re all set
              </h1>
              <p className="mt-1 text-sm text-white/60">
                We&apos;ve emailed this to you as well — you don&apos;t need to keep this page.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs font-bold tracking-[0.2em] text-white/45 uppercase">Your voucher</p>
        )}

        <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-12">
          <div>
            {/* ONE card for the whole voucher — QR, code and contents together
                rather than three stacked panels. Reads as the thing you were sold. */}
            <div
              className={`mt-6 rounded-2xl border border-white/12 bg-white/[0.04] p-5 ${
                voided || expired || allDone ? "opacity-45" : ""
              }`}
            >
              {/* THE QR IS THE PRIMARY REDEMPTION MECHANISM, so it leads.
            It was missing entirely, which left a guest to type 11 characters on a
            kiosk keyboard — and for anyone without a card it is the ONLY way to
            get one, since a phone can't dispense. Dimmed when the voucher can no
            longer be used, so a dead code never looks scannable. */}
              {qrDataUri && (
                <div className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                  <img
                    src={qrDataUri}
                    alt={`QR code for voucher ${formatVoucherCode(status.code)}`}
                    className="mx-auto h-48 w-48 rounded-xl bg-white p-2"
                  />
                  <p className="mt-3 text-sm font-semibold text-white">
                    Scan this at any HeadPinz kiosk
                  </p>
                  <p className="mt-1 text-sm text-white/55">
                    The kiosk prints your game cards with the credit already on them. Look for the
                    &ldquo;Coupon or voucher?&rdquo; button on the welcome screen.
                  </p>
                </div>
              )}

              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-4 font-mono text-2xl tracking-[0.12em] text-white">
                {formatVoucherCode(status.code)}
              </div>
              <p className="mt-2 text-xs text-white/45">
                Can&apos;t scan? Type this code at the kiosk instead.
              </p>

              {/* Same job as the QR and code above — carry it with you — so it
              sits with them. A plain <a> to OUR route, never straight to
              PassKit: the route re-checks Neon at tap time (voided / expired /
              spent) and creates the pass on first ask, because PassKit bills
              single-use passes AT ISSUANCE and most guests never add one. Hidden
              once the voucher can no longer be used, matching the dimmed QR. */}
              {!voided && !expired && !allDone && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {WALLETS.map((w) => (
                    <a
                      key={w.platform}
                      href={`/v/${status.code}/wallet?platform=${w.platform}`}
                      className="flex items-center justify-center rounded-full border border-white/20 bg-white/[0.08] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.14]"
                    >
                      {w.label}
                    </a>
                  ))}
                </div>
              )}
              {/* Expiry, stated plainly — a prepaid voucher's shelf life is a term of
            the sale, and it was never shown here. */}
              {expiryText && (
                <p className={`mt-4 text-sm ${expired ? "text-red-300" : "text-white/60"}`}>
                  {expired ? `Expired ${expiryText}` : `Valid through ${expiryText}`}
                </p>
              )}

              {/* What's on it — IDENTICAL LEGS COLLAPSED to one counted row, the same
            way the kiosk receipt does it. A 3-pack combined voucher carries twelve
            legs and listing them individually was a wall of repetition. */}
              <ul className="mt-6 space-y-2">
                {itemGroups.map((g) => (
                  <li
                    key={`${g.label}-${g.spent > 0 ? "used" : "live"}-${g.indexes[0]}`}
                    className="flex items-center justify-between gap-3 text-lg"
                  >
                    <span className={g.spent > 0 ? "text-white/35 line-through" : "text-white"}>
                      {g.total > 1 ? `${g.total} × ` : ""}
                      {g.label}
                    </span>
                    <span className="shrink-0 text-sm text-white/50">
                      {g.spent > 0
                        ? "used"
                        : g.route === "gamezone"
                          ? "ready"
                          : g.route === "attraction"
                            ? // Bookable below — saying "at Guest Services" sent guests
                              // to a desk for something they can do themselves.
                              "book below"
                            : // A race leg: applied to the booking at checkout. Still not
                              // Guest Services — the desk cannot redeem any of these.
                              "apply when booking"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Other codes from the SAME purchase. Server-gated on a purchase row —
            a shared batch_id alone would leak an admin comp batch. */}
            {siblingCodes.length > 0 && (
              <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-bold tracking-widest text-white/45 uppercase">
                  Your other {siblingCodes.length === 1 ? "code" : "codes"}
                </p>
                <p className="mt-1 text-xs text-white/50">
                  Each works on its own, so you can pass one to someone else.
                </p>
                <ul className="mt-2 space-y-1">
                  {siblingCodes.map((c) => (
                    <li key={c}>
                      <a
                        href={`/v/${c}`}
                        className="font-mono text-sm text-white/75 underline-offset-2 hover:text-white hover:underline"
                      >
                        {formatVoucherCode(c)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Book the timed half — a single prominent pill directly under the
                voucher card (owner 2026-08-03), not a panel competing with it.
                Shown regardless of the CARD states below, which own a different
                action. */}
            {bookable.length > 0 && !voided && !expired && (
              <div className="mt-5 space-y-2">
                {bookable.map(({ slug, count }) => (
                  <a
                    key={slug}
                    href={`/book/${slug}/v2?voucher=${encodeURIComponent(status.code)}`}
                    className="block rounded-full bg-[#fd5b56] px-6 py-4 text-center text-sm font-bold tracking-widest text-white uppercase transition hover:brightness-110"
                  >
                    Book {prettySlug(slug)}
                    {count > 1 ? ` (${count})` : ""}
                  </a>
                ))}
                <p className="text-center text-xs text-white/45">
                  Your code comes with you — applied at checkout, nothing more to pay.
                </p>
              </div>
            )}
          </div>

          <div className="lg:mt-0">
            {/* HOW TO USE IT — derived from the voucher's OWN items, so it is
                correct for a deal pack, a VIP combo grant or a bare comp card
                alike. This replaced a separate /deals/thanks page that duplicated
                the whole screen (owner: "why do we need both these?"), which is
                why every voucher now gets these instructions and not just
                purchased ones. */}
            {!voided && !expired && !allDone && (
              <div className="space-y-4 rounded-2xl border border-white/12 bg-white/[0.03] p-5">
                <h2 className="text-xs font-bold tracking-widest text-white/45 uppercase">
                  How to use it
                </h2>

                {itemGroups.some((g) => g.route === "gamezone" && g.spent === 0) && (
                  <div className="flex gap-3">
                    <IconDeviceGamepad2 size={20} className="mt-0.5 shrink-0 text-[#8652ff]" />
                    <p className="text-sm text-white/70">
                      <span className="font-semibold text-white">Game cards — at a kiosk.</span>{" "}
                      Scan the QR at any HeadPinz kiosk and it prints your cards with the credit
                      already on them; look for &ldquo;Coupon or voucher?&rdquo; on the welcome
                      screen.
                    </p>
                  </div>
                )}

                {bookable.length > 0 && (
                  <div className="flex gap-3">
                    <IconCalendarEvent size={20} className="mt-0.5 shrink-0 text-[#8652ff]" />
                    <p className="text-sm text-white/70">
                      <span className="font-semibold text-white">
                        {bookable.map((b) => prettySlug(b.slug)).join(" and ")} — book a time,
                        online or at a kiosk.
                      </span>{" "}
                      These run as timed sessions, so pick a slot rather than turning up. Use the
                      button on the left, or scan your QR at a kiosk when you arrive — your code is
                      applied at checkout and there is nothing more to pay.
                    </p>
                  </div>
                )}

                <div className="flex gap-3">
                  <IconQrcode size={20} className="mt-0.5 shrink-0 text-[#8652ff]" />
                  <p className="text-sm text-white/70">
                    <span className="font-semibold text-white">Use it in pieces.</span> Every item
                    is redeemed separately, so you can take a game card today and come back for the
                    rest. Whatever you haven&apos;t used stays on this code.
                  </p>
                </div>

                <div className="flex gap-3">
                  <IconMail size={20} className="mt-0.5 shrink-0 text-[#8652ff]" />
                  <p className="text-sm text-white/70">
                    <span className="font-semibold text-white">It&apos;s in your inbox too.</span>{" "}
                    No need to keep this page — the same QR and code were emailed to you
                    {expiryText ? `, valid through ${expiryText}` : ""}.
                  </p>
                </div>

                <p className="border-t border-white/10 pt-3 text-xs text-white/40">
                  Redeem at a kiosk, not the front desk — Guest Services can&apos;t print cards or
                  apply voucher codes.
                </p>
              </div>
            )}
            {/* Status notices only. The "load it onto a card you already have"
                form is GONE (owner 2026-08-03: "get rid of this for now I don't
                like it"), which makes redemption kiosk-only — consistent with
                "NOT redeemable at guest services you must see kiosk". The
                `to-card` action on /api/game-cards/voucher-redeem is deliberately
                left in place: this removes an entry point, not a capability, so
                putting it back is a UI change rather than a rebuild. */}
            {voided ? (
              <p className="mt-6 text-lg text-white/70">{REASON_COPY.voided}</p>
            ) : expired ? (
              <p className="mt-6 text-lg text-white/70">{REASON_COPY.expired}</p>
            ) : allDone ? (
              <p className="mt-6 text-lg text-white/70">{REASON_COPY.used}</p>
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}
