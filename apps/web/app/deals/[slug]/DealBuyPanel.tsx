"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconClockHour4, IconGift, IconMapPin, IconTicket } from "@tabler/icons-react";
import PaymentForm from "@/components/square/PaymentForm";
import Card from "~/components/ui/Card";
import ErrorBox from "~/components/ui/ErrorBox";
import Input from "~/components/ui/Input";
import Spinner from "~/components/ui/Spinner";
import QtyStepper from "~/components/ui/QtyStepper";
import DealCountdown from "~/components/features/deals/DealCountdown";
import { normalizeLocationSlug } from "@/lib/attractions-data";
import { DEAL_LOCATION_INFO, isDealLocation, type DealLocationKey } from "~/features/deals";
import { formatGiftDate, giftDateWindow } from "~/features/deals/gift";
import type { DealOffer } from "~/features/deals/service/offer";

/**
 * The buy panel — the only interactive part of a deal page.
 *
 * TOTALS COME FROM THE SERVER, ALWAYS. Square computes the tax, so the panel
 * asks `/api/deals/quote` whenever location or quantity changes and renders what
 * comes back. It never multiplies a rate locally: $45 at 6.5% is $2.925, and a
 * second rounding implementation here is how the displayed total starts
 * disagreeing with the captured amount. The quoted total is echoed back on
 * purchase so the server can refuse if it moved.
 *
 * Terms are deal-specific rather than the shared ClickwrapCheckbox: that
 * component is about reservation cancellation windows, and a prepaid voucher has
 * no reservation to cancel. Showing a guest the wrong policy to reuse a
 * component would be worse than writing four honest lines.
 */

/** Bump when the terms text below changes — stored with the purchase. */
export const DEAL_TERMS_VERSION = "deal-terms-2026-08";

/**
 * The panel sits ON the hero photograph, so it needs its own opaque surface.
 * `Card`'s default is `bg-white/[0.03]` — 3% white, which over a bright photo is
 * effectively nothing: the form fields read as floating labels over someone's
 * face. `/reload` hit this exact problem and solved it the same way.
 *
 * The `!` prefixes are REQUIRED. Card composes this string after its own classes,
 * but Tailwind resolves by stylesheet order, not class order, so a plain
 * `bg-[…]` loses to `bg-white/[0.03]`. Importance is what actually wins.
 *
 * Kept near-opaque rather than fully solid (0.96 + blur) so a hint of the photo's
 * colour still bleeds through the edges and it reads as part of the page.
 */
const PANEL_SURFACE =
  "space-y-5 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-md " +
  "!bg-[rgba(6,10,26,0.96)] !border-white/15";

interface Quote {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  qty: number;
  unitPriceCents: number;
}

interface PurchaseResult {
  purchaseId: number;
  dealName: string;
  qty: number;
  totalCents: number;
  codes: string[];
  expiresAt: string | null;
  mintPending: boolean;
  emailPending: boolean;
  scheduleUrl: string | null;
  isGift: boolean;
  recipientName: string | null;
  /** ISO instant the recipient hears about it; null = they already have. */
  giftSendAt: string | null;
}

/**
 * Above this fraction remaining, the packs-left line is hidden.
 *
 * "197 of 200 left" is an anti-signal — it says nobody is buying. The counter
 * only earns its place once it is genuinely getting low, which is also the only
 * point at which it is telling the buyer something they did not already know.
 */
const REMAINING_VISIBLE_BELOW = 0.6;

export interface DealBuyPanelProps {
  slug: string;
  dealName: string;
  /**
   * The server's resolve at render time. Seeds the price and the launch state so
   * the panel is correct in the first HTML; every quote response replaces it.
   */
  initialOffer: DealOffer;
  /** Kill switch for the countdown and the packs-left line — display only. */
  urgencyUi: boolean;
  /** Locations this deal is sold at. */
  locations: readonly DealLocationKey[];
  /** Resolved server-side from `?location=` so an ad can target one venue. */
  initialLocation: DealLocationKey | null;
  /**
   * Resolved server-side from `?qty=`, already clamped to the cap. The recovery
   * email puts a buyer back in front of the basket they abandoned, so it must
   * actually restore the quantity rather than silently reset to one.
   */
  initialQty: number;
  maxPerBuyer: number;
  expiresMonths: number;
  accentColor: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/**
 * Which venue an ad pointed at, from `?location=`. Accepts the friendly
 * spellings marketing already uses ("fort-myers", "fm", "np") via the shared
 * `normalizeLocationSlug`, and ignores anything this deal isn't sold at.
 * Returns null during SSR so the server and first client render agree.
 */
function initialLocationFromUrl(allowed: readonly DealLocationKey[]): DealLocationKey | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("location");
  const normalized = normalizeLocationSlug(raw);
  if (!normalized || !isDealLocation(normalized)) return null;
  return allowed.includes(normalized) ? normalized : null;
}

/** utm_* + gclid off the current URL, for ad attribution on the purchase row. */
function readUtm(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const sp = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "gclid",
  ]) {
    const v = sp.get(key);
    if (v) out[key] = v.slice(0, 200);
  }
  return out;
}

export default function DealBuyPanel({
  slug,
  dealName,
  initialOffer,
  urgencyUi,
  locations,
  initialLocation,
  initialQty,
  maxPerBuyer,
  expiresMonths,
  accentColor,
}: DealBuyPanelProps) {
  const router = useRouter();
  /**
   * The server already resolved `?location=`; the URL fallback only covers a
   * client-side navigation that lands here with a param the server never saw.
   */
  const [location, setLocation] = useState<DealLocationKey | null>(
    () => initialLocation ?? initialLocationFromUrl(locations),
  );
  const [qty, setQty] = useState(initialQty);
  /** Default TRUE: one code for one buyer. Splitting is only for gifting packs on. */
  const [combine, setCombine] = useState(true);
  /**
   * The quote is stored WITH the inputs that produced it, and only rendered when
   * those still match. Two things fall out of that: no setState in the effect
   * body just to clear it, and — more importantly — a quote can never be shown
   * for the wrong basket. Switching Fort Myers → Naples would otherwise flash
   * Lee County's 6.5% tax against a Collier order until the refetch landed.
   */
  const [quoted, setQuoted] = useState<{
    location: DealLocationKey;
    qty: number;
    quote: Quote;
  } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [notSellable, setNotSellable] = useState(false);
  /**
   * The launch state, refreshed by every quote. Seeded from the server render so
   * the price and the countdown are right in the first paint, then replaced —
   * the quote route resolves it per request, which is the only place it can come
   * from live, since this page is `revalidate = 3600`.
   */
  const [offer, setOffer] = useState<DealOffer>(initialOffer);
  /**
   * Bumped to force a re-quote when nothing the buyer did has changed — the
   * launch deadline passing is the only case, and without this the quote effect
   * (keyed on slug/location/qty) would happily keep showing the old total.
   */
  const [repriceNonce, setRepriceNonce] = useState(0);

  const quote = quoted && quoted.location === location && quoted.qty === qty ? quoted.quote : null;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [agreed, setAgreed] = useState(false);

  /* ── gift ───────────────────────────────────────────────────────────────
     The recipient's PHONE is optional and their EMAIL is not: a gift text
     goes to somebody who never opted in, so it is the buyer's deliberate
     choice, never a required field. */
  const [isGift, setIsGift] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [giftMessage, setGiftMessage] = useState("");
  const [giftDate, setGiftDate] = useState("");

  /**
   * Picker bounds. Computed once per mount rather than per render — it reads
   * the clock, and a value that changes mid-session would let a date silently
   * fall out of range between typing and paying. The server re-validates
   * anyway; this is only here to stop the buyer picking something doomed.
   */
  const giftWindow = useMemo(() => giftDateWindow({ expiresMonths }), [expiresMonths]);

  // NO local pay-error state. PaymentForm renders whatever `onTokenize` throws, in
  // its own box directly above the pay button. Mirroring it here too is what put the
  // same decline on screen twice on 2026-08-03 — one box above the card fields and an
  // identical one below them.
  const [result, setResult] = useState<PurchaseResult | null>(null);

  // A stable synthetic id for the payment form's logging/keying. Deal packs have
  // no BMI bill — nothing is reserved — so there is no real one to pass. A lazy
  // useState initialiser rather than a ref: it is read during render, which a ref
  // is not for, and this way it is generated exactly once.
  const [billId] = useState(() => `deal-${slug}-${Math.random().toString(36).slice(2, 10)}`);

  /* ── quote whenever location or qty changes ─────────────────────────── */
  useEffect(() => {
    if (!location) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setQuoting(true);
      setQuoteError(null);
      try {
        const res = await fetch("/api/deals/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, location, qty }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok) {
          setQuoted({ location, qty, quote: data.quote as Quote });
          if (data.offer) setOffer(data.offer as DealOffer);
          setNotSellable(false);
        } else {
          setQuoted(null);
          if (data.code === "NOT_SELLABLE") {
            setNotSellable(true);
          } else {
            setQuoteError(data.error || "We couldn't work out the total. Please try again.");
          }
        }
      } catch {
        if (!cancelled) setQuoteError("We couldn't reach the server. Please try again.");
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug, location, qty, repriceNonce]);

  /**
   * The deadline passing, handled before the buyer hits it.
   *
   * `assertQuoteMatches` on the server is the guard that stops a stale total
   * ever being charged, but arriving at it means a card submission that fails —
   * a bad experience for someone whose only mistake was typing slowly. So the
   * panel watches its own deadline and re-prices the moment it lands: one timer
   * set to the exact instant, not a poll. `router.refresh()` brings the rest of
   * the page (the hero price, the value table, the Offer JSON-LD) along with it,
   * and React state — everything already typed in here — survives.
   */
  useEffect(() => {
    if (!offer.isOfferLive || !offer.endsAt) return;
    const msLeft = new Date(offer.endsAt).getTime() - Date.now();
    if (Number.isNaN(msLeft)) return;
    // setTimeout saturates above ~24.8 days; anything that far out will be
    // re-armed by a later render long before it matters.
    if (msLeft <= 0 || msLeft > 2_147_483_000) return;
    const id = setTimeout(() => {
      setRepriceNonce((n) => n + 1);
      router.refresh();
    }, msLeft + 1000);
    return () => clearTimeout(id);
  }, [offer.isOfferLive, offer.endsAt, router]);

  /**
   * Only show the counter once it means something. Below the threshold it is
   * scarcity; above it, it is an advertisement that the deal is not selling.
   */
  const showRemaining =
    offer.remaining !== null &&
    offer.allocation !== null &&
    offer.remaining > 0 &&
    offer.remaining / offer.allocation < REMAINING_VISIBLE_BELOW;

  const contactComplete = useMemo(
    () =>
      name.trim().length > 1 && /.+@.+\..+/.test(email) && phone.replace(/\D/g, "").length >= 10,
    [name, email, phone],
  );
  /** A gift can't be paid for until we know where it's going. */
  const giftComplete = useMemo(
    () => !isGift || (recipientName.trim().length > 0 && /.+@.+\..+/.test(recipientEmail)),
    [isGift, recipientName, recipientEmail],
  );
  const readyToPay =
    !!location && !!quote && contactComplete && giftComplete && agreed && !quoting;

  const handleTokenize = useCallback(
    async ({
      cardNonce,
      savedCardId,
    }: {
      cardNonce: string | null;
      savedCardId: string | null;
      giftCardNonce: string | null;
      sourceKind: string;
      saveCardConsent: boolean;
    }) => {
      if (!location || !quote) return;
      const nonce = cardNonce ?? savedCardId;
      // Everything thrown from here is shown to the buyer verbatim by PaymentForm,
      // so throw the guest-facing sentence — never an internal string like "no nonce".
      if (!nonce) throw new Error("We couldn't read that card. Please try again.");
      const res = await fetch("/api/deals/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          location,
          qty,
          combine,
          // Echoed so the server can refuse if the total moved while we sat here.
          shownTotalCents: quote.totalCents,
          buyer: { name: name.trim(), email: email.trim(), phone: phone.trim(), smsOptIn },
          ...(isGift
            ? {
                gift: {
                  recipientName: recipientName.trim(),
                  recipientEmail: recipientEmail.trim(),
                  ...(recipientPhone.trim() ? { recipientPhone: recipientPhone.trim() } : {}),
                  ...(giftMessage.trim() ? { message: giftMessage.trim() } : {}),
                  // "Today" is not a schedule — omitting it means send now, which
                  // is what an empty picker and today's date both mean.
                  ...(giftDate && giftDate !== giftWindow.min ? { sendDate: giftDate } : {}),
                },
              }
            : {}),
          cardNonce: nonce,
          clickwrapVersion: DEAL_TERMS_VERSION,
          utm: readUtm(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.code === "PRICE_CHANGED") {
          // The offer ended between this panel rendering its total and the buyer
          // submitting; the server already refused, so nothing was charged.
          // Re-quote (rather than reload) so the new total is on screen behind
          // the message, and every field they filled in survives.
          setRepriceNonce((n) => n + 1);
          router.refresh();
        }
        // `data.error` is already guest-facing — the purchase service phrases declines
        // through `checkoutDeclineMessage`. Throwing re-enables PaymentForm's button
        // AND is how the message reaches the screen. Deliberately the ONLY channel:
        // also calling setPayError here is the double-message bug that
        // "tell a declined buyer WHY, and only say it once" removed.
        throw new Error(data.error || "That payment didn't go through.");
      }
      const purchased = data as PurchaseResult;

      // Leave the purchase page entirely (owner 2026-08-03) and land on the
      // voucher's OWN page. There is no separate confirmation route: /v/{code}
      // already carries the QR, the code, the contents and the instructions, and a
      // second page duplicating all of that earned nothing (owner: "why do we need
      // both these?"). `?bought=1` only changes the greeting.
      //
      // A short, shareable URL is the side benefit — it is the same link the email
      // and the QR use, so a refresh, a forward, or scanning your own screen all
      // land in the same place. Sibling codes from a split purchase are discovered
      // server-side from the batch, so they do not need to ride the URL.
      //
      // Codes empty = the mint deferred to the reconcile cron. Nothing to show yet,
      // so fall back to the in-panel notice rather than a 404.
      //
      // A GIFT STAYS HERE. /v/{code} is the RECIPIENT's page — it opens "your
      // voucher is ready" and leads with a QR to redeem it, which is the wrong
      // thing to show the person who just bought it for someone else. The buyer's
      // question is "did it send, and when do they get it", so answer that.
      if (!isGift && purchased.codes.length > 0) {
        window.location.href = `/v/${purchased.codes[0]}?bought=1`;
        return;
      }
      setResult(purchased);
    },
    [
      slug,
      location,
      qty,
      combine,
      quote,
      name,
      email,
      phone,
      smsOptIn,
      isGift,
      recipientName,
      recipientEmail,
      recipientPhone,
      giftMessage,
      giftDate,
      giftWindow.min,
      router,
    ],
  );

  /* ── in-panel outcomes ─────────────────────────────────────────────────
     A normal purchase leaves for /v/{code}. Two cases stay here: a GIFT (whose
     buyer must not be shown the recipient's redemption page), and a purchase
     whose mint deferred to the reconcile cron so there is no code to link yet. */
  if (result) {
    const pending = result.codes.length === 0;
    const giftDelayed = result.isGift && result.giftSendAt;
    const who = result.recipientName?.trim() || "them";
    return (
      <Card className={PANEL_SURFACE}>
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-full"
            style={{ background: accentColor, color: "#00041b" }}
          >
            <IconCheck size={22} stroke={3} />
          </span>
          <div>
            <h2 className="font-display text-2xl text-white">
              {result.isGift ? "Gift on its way" : "Payment received"}
            </h2>
            <p className="text-sm text-white/60">
              {money(result.totalCents)} charged · {result.qty}{" "}
              {result.qty === 1 ? "pack" : "packs"}
            </p>
          </div>
        </div>

        {result.isGift && !pending && (
          <div className="rounded-lg border border-white/15 bg-white/[0.04] p-4 text-sm text-white/80">
            {giftDelayed ? (
              <>
                We&apos;ll email {who} on{" "}
                <strong className="text-white">{formatGiftDate(result.giftSendAt!)}</strong>
                {recipientPhone.trim() ? " and text them too" : ""}. Nothing for you to do — we
                send it automatically.
              </>
            ) : (
              <>
                We&apos;ve emailed {who}
                {recipientPhone.trim() ? " and sent them a text" : ""}. Your own receipt, with a
                copy of the code{result.qty === 1 ? "" : "s"}, is in your inbox.
              </>
            )}
          </div>
        )}

        {pending && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            We&apos;re still cutting {result.isGift ? "the" : "your"} voucher
            {result.qty === 1 ? "" : "s"} — {result.isGift ? "it" : "they"}&apos;ll be
            {result.isGift ? " sent" : " in your inbox"} within a few minutes, with the QR code and
            everything {result.isGift ? "they" : "you"} need. Nothing else is needed from you, and
            you don&apos;t have to keep this page open.
          </div>
        )}

        {result.isGift && !pending && (
          <a
            href={`/v/${result.codes[0]}`}
            className="block rounded-lg border border-white/15 px-4 py-2.5 text-center text-sm
              text-white/80 transition-colors hover:border-white/35 hover:text-white"
          >
            View your copy of the voucher
          </a>
        )}

        <p className="text-xs text-white/45">
          If it hasn&apos;t arrived in 10 minutes, give us a call and quote order #
          {result.purchaseId} — we can resend it.
        </p>
      </Card>
    );
  }

  /* ── buy ────────────────────────────────────────────────────────────── */
  return (
    <Card className={PANEL_SURFACE}>
      <div>
        <h2 className="font-display text-2xl text-white">Get this deal</h2>
        <p className="mt-1 text-sm text-white/55">
          {money(offer.unitPriceCents)} per pack plus tax · limit {maxPerBuyer} per person
        </p>
        {/* The offer box. Every line is about the BONUS, never the price —
            the price is the one thing that does not change when this expires,
            and implying otherwise beside a live countdown would be the lie. */}
        {urgencyUi && offer.isOfferLive && offer.bonusLabel && (
          <div
            className="mt-3 space-y-1.5 rounded-lg border p-3"
            style={{ borderColor: `${accentColor}55`, background: `${accentColor}14` }}
          >
            <p className="text-sm font-bold text-white">Includes {offer.bonusLabel}</p>
            {offer.endsAt && (
              <p className="flex items-center gap-2 text-sm text-white/80">
                <IconClockHour4 size={15} style={{ color: accentColor }} aria-hidden="true" />
                <DealCountdown
                  endsAt={offer.endsAt}
                  datePrefix="Ends "
                  clockPrefix="Ends in "
                />
              </p>
            )}
            {showRemaining && (
              <p className="text-sm text-white/80">
                <span className="font-semibold text-white">{offer.remaining}</span> of{" "}
                {offer.allocation} bonus packs left.
              </p>
            )}
            <p className="text-xs text-white/50">
              The pack stays {money(offer.unitPriceCents)} either way — after this, it just
              doesn&apos;t include the bonus.
            </p>
          </div>
        )}
      </div>

      {/* Location */}
      <div className="space-y-2">
        <span className="block text-xs font-bold tracking-widest text-white/45 uppercase">
          Which HeadPinz?
        </span>
        <div className="grid gap-2 sm:grid-cols-2">
          {locations.map((key) => {
            const info = DEAL_LOCATION_INFO[key];
            const active = location === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setLocation(key)}
                aria-pressed={active}
                className={`rounded-xl border px-4 py-3 text-left transition-all ${
                  active
                    ? "border-white/50 bg-white/[0.09]"
                    : "border-white/12 bg-white/[0.03] hover:border-white/30"
                }`}
                style={active ? { borderColor: accentColor } : undefined}
              >
                <span className="flex items-center gap-2 text-sm font-bold text-white">
                  <IconMapPin size={15} />
                  {info.shortLabel}
                </span>
                <span className="mt-1 block text-xs text-white/45">{info.address}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quantity */}
      <QtyStepper
        qty={qty}
        max={maxPerBuyer}
        label="How many packs?"
        decrementLabel="One fewer pack"
        incrementLabel="One more pack"
        accentColor={accentColor}
        onChange={setQty}
      />

      {/* One code or several — only a question when there's more than one pack.
          Combined is the default and the honest recommendation: legs are redeemed
          independently, so ONE code still splits across visits and across people.
          Separate codes buy exactly one thing — handing a whole pack to someone
          else — so that is how the option is described rather than as a vague
          preference. */}
      {qty > 1 && (
        <fieldset className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <legend className="px-1 text-xs font-bold tracking-widest text-white/45 uppercase">
            How should we send them?
          </legend>
          <div className="mt-1 space-y-2.5">
            {/* The LABEL carries only its own short text, one level deep — the
                explanation is a sibling wired up with aria-describedby. Nesting a
                heading span plus a paragraph span inside the label put the text
                past jsx-a11y/label-has-associated-control's depth limit and failed
                the a11y gate; it also over-stated the label, since the help text
                isn't the control's name. */}
            <div>
              <label
                htmlFor="deal-combine-one"
                className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-white"
              >
                <input
                  id="deal-combine-one"
                  type="radio"
                  name="deal-combine"
                  checked={combine}
                  onChange={() => setCombine(true)}
                  aria-describedby="deal-combine-one-hint"
                  className="h-4 w-4 shrink-0"
                />
                One code for all {qty} packs
              </label>
              <p id="deal-combine-one-hint" className="mt-1 pl-[26px] text-xs text-white/55">
                Recommended — one QR to keep. You can still share it: everything on it is used
                separately, so your group can split it across people and visits.
              </p>
            </div>
            <div>
              <label
                htmlFor="deal-combine-split"
                className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold text-white"
              >
                <input
                  id="deal-combine-split"
                  type="radio"
                  name="deal-combine"
                  checked={!combine}
                  onChange={() => setCombine(false)}
                  aria-describedby="deal-combine-split-hint"
                  className="h-4 w-4 shrink-0"
                />
                {qty} separate codes
              </label>
              <p id="deal-combine-split-hint" className="mt-1 pl-[26px] text-xs text-white/55">
                Only needed if you&apos;re giving whole packs to other people — one code each.
              </p>
            </div>
          </div>
        </fieldset>
      )}

      {/* Total */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        {!location ? (
          <p className="text-sm text-white/50">Pick a location to see your total.</p>
        ) : notSellable ? (
          <p className="text-sm text-amber-200">
            This deal goes on sale shortly — check back soon.
          </p>
        ) : quoting && !quote ? (
          <span className="flex items-center gap-2 text-sm text-white/50">
            <Spinner /> Working out your total…
          </span>
        ) : quote ? (
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between text-white/60">
              <dt>
                {qty} × {dealName}
              </dt>
              <dd>{money(quote.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between text-white/60">
              <dt>Sales tax</dt>
              <dd>{money(quote.taxCents)}</dd>
            </div>
            <div className="flex justify-between border-t border-white/10 pt-1.5 text-base font-bold text-white">
              <dt>Total</dt>
              <dd>{money(quote.totalCents)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-white/50">—</p>
        )}
      </div>

      {quoteError && <ErrorBox>{quoteError}</ErrorBox>}

      {/* Contact */}
      <div className="space-y-3">
        <Input
          label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
        <Input
          label="Email (we send your voucher here)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <Input
          label="Mobile number"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
        />
        {!isGift && (
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-white/55">
            <input
              type="checkbox"
              checked={smsOptIn}
              onChange={(e) => setSmsOptIn(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--deal-accent)]"
            />
            <span>Text me my voucher code too. Message rates may apply.</span>
          </label>
        )}
      </div>

      {/* ── Gift ──────────────────────────────────────────────────────────
          Off by default: most buyers are buying for themselves, and a form
          that opens asking who it's for makes the common case answer a
          question it doesn't have. */}
      <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-white/80">
          <input
            type="checkbox"
            checked={isGift}
            onChange={(e) => setIsGift(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--deal-accent)]"
          />
          <span className="flex items-center gap-1.5">
            <IconGift size={16} />
            This is a gift for someone else
          </span>
        </label>

        {isGift && (
          <div className="space-y-3 pt-1">
            <Input
              label="Their name"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              autoComplete="off"
            />
            <Input
              label="Their email (we send the voucher here)"
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              autoComplete="off"
            />
            <Input
              label="Their mobile number (optional — we'll text it too)"
              type="tel"
              value={recipientPhone}
              onChange={(e) => setRecipientPhone(e.target.value)}
              autoComplete="off"
            />
            <div>
              <label
                htmlFor="gift-message"
                className="mb-1.5 block text-xs font-medium text-white/70"
              >
                Add a message (optional)
              </label>
              <textarea
                id="gift-message"
                value={giftMessage}
                maxLength={300}
                rows={2}
                onChange={(e) => setGiftMessage(e.target.value)}
                placeholder="Happy birthday! Go have some fun."
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm
                  text-white placeholder:text-white/30 focus:border-white/35 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="gift-send-date"
                className="mb-1.5 block text-xs font-medium text-white/70"
              >
                When should we send it?
              </label>
              <input
                id="gift-send-date"
                type="date"
                value={giftDate}
                min={giftWindow.min}
                max={giftWindow.max}
                onChange={(e) => setGiftDate(e.target.value)}
                className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm
                  text-white focus:border-white/35 focus:outline-none [color-scheme:dark]"
              />
              <p className="mt-1.5 text-xs text-white/45">
                {giftDate && giftDate !== giftWindow.min
                  ? `We'll email it the morning of ${formatGiftDate(giftDate)}.`
                  : "We'll send it as soon as you pay."}{" "}
                The voucher is good for {expiresMonths}&nbsp;months from today either way.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Terms — specific to a prepaid voucher, not the reservation policy. */}
      <label className="flex cursor-pointer items-start gap-2.5 text-xs text-white/55">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--deal-accent)]"
        />
        <span>
          {/* &nbsp; is deliberate, and load-bearing. A plain space here renders as
              "12months": the text node after {expiresMonths} spans several source
              lines, so JSX line-normalisation eats its leading whitespace. It is
              also the typographically correct character — a quantity should never
              be split from its unit across a line break. */}
          I understand this is a prepaid voucher: it&apos;s good for {expiresMonths}&nbsp;months
          from today at the HeadPinz I picked, each item on it can be used once, and it
          isn&apos;t refundable once redeemed. Laser tag and gel blaster run as timed sessions
          subject to availability.
        </span>
      </label>

      {readyToPay && quote && location ? (
        <PaymentForm
          amount={quote.totalCents / 100}
          itemName={`${dealName} ×${qty}`}
          billId={billId}
          contact={{ ...splitName(name), email: email.trim(), phone: phone.trim() }}
          locationId={location === "naples" ? "naples" : "headpinz"}
          onTokenize={handleTokenize}
          onSuccess={() => {}}
        />
      ) : (
        <p className="text-center text-xs text-white/40">
          {notSellable
            ? "Not on sale just yet."
            : !location
              ? "Pick a location to continue."
              : !contactComplete
                ? "Fill in your details to continue."
                : !agreed
                  ? "Tick the box above to continue."
                  : "One moment…"}
        </p>
      )}

      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-white/35">
        <IconGift size={13} />
        Delivered by email as a scannable code
        <span className="text-white/20">·</span>
        <IconTicket size={13} />
        Redeem at any kiosk
      </p>
    </Card>
  );
}
