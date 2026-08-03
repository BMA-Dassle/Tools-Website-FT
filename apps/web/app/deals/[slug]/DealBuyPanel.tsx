"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconCheck, IconGift, IconMapPin, IconTicket } from "@tabler/icons-react";
import PaymentForm from "@/components/square/PaymentForm";
import Card from "~/components/ui/Card";
import ErrorBox from "~/components/ui/ErrorBox";
import Input from "~/components/ui/Input";
import Spinner from "~/components/ui/Spinner";
import QtyStepper from "~/components/ui/QtyStepper";
import { normalizeLocationSlug } from "@/lib/attractions-data";
import { DEAL_LOCATION_INFO, isDealLocation, type DealLocationKey } from "~/features/deals";

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
}

export interface DealBuyPanelProps {
  slug: string;
  dealName: string;
  priceCents: number;
  /** Locations this deal is sold at. */
  locations: readonly DealLocationKey[];
  /** Resolved server-side from `?location=` so an ad can target one venue. */
  initialLocation: DealLocationKey | null;
  maxPerBuyer: number;
  expiresMonths: number;
  accentColor: string;
  /** Label for the "pick your time" CTA on the confirmation. */
  scheduleLabel: string;
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
function initialLocationFromUrl(
  allowed: readonly DealLocationKey[],
): DealLocationKey | null {
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
  priceCents,
  locations,
  initialLocation,
  maxPerBuyer,
  expiresMonths,
  accentColor,
  scheduleLabel,
}: DealBuyPanelProps) {
  /**
   * The server already resolved `?location=`; the URL fallback only covers a
   * client-side navigation that lands here with a param the server never saw.
   */
  const [location, setLocation] = useState<DealLocationKey | null>(
    () => initialLocation ?? initialLocationFromUrl(locations),
  );
  const [qty, setQty] = useState(1);
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

  const quote =
    quoted && quoted.location === location && quoted.qty === qty ? quoted.quote : null;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const [payError, setPayError] = useState<string | null>(null);
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
  }, [slug, location, qty]);

  const contactComplete = useMemo(
    () => name.trim().length > 1 && /.+@.+\..+/.test(email) && phone.replace(/\D/g, "").length >= 10,
    [name, email, phone],
  );
  const readyToPay = !!location && !!quote && contactComplete && agreed && !quoting;

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
      setPayError(null);
      const nonce = cardNonce ?? savedCardId;
      if (!nonce) {
        setPayError("We couldn't read that card. Please try again.");
        throw new Error("no nonce");
      }
      const res = await fetch("/api/deals/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          location,
          qty,
          // Echoed so the server can refuse if the total moved while we sat here.
          shownTotalCents: quote.totalCents,
          buyer: { name: name.trim(), email: email.trim(), phone: phone.trim(), smsOptIn },
          cardNonce: nonce,
          clickwrapVersion: DEAL_TERMS_VERSION,
          utm: readUtm(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPayError(data.error || "That payment didn't go through.");
        // Rethrow so PaymentForm re-enables its button for another attempt.
        throw new Error(data.error || "purchase failed");
      }
      setResult(data as PurchaseResult);
    },
    [slug, location, qty, quote, name, email, phone, smsOptIn],
  );

  /* ── success ────────────────────────────────────────────────────────── */
  if (result) {
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
            <h2 className="font-display text-2xl text-white">You&apos;re all set</h2>
            <p className="text-sm text-white/60">
              {money(result.totalCents)} charged · {result.qty}{" "}
              {result.qty === 1 ? "pack" : "packs"}
            </p>
          </div>
        </div>

        {result.mintPending ? (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            Your payment went through. We&apos;re still cutting your voucher codes — they&apos;ll be
            in your inbox within a few minutes. Nothing else is needed from you.
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm text-white/70">
                {result.codes.length === 1
                  ? "Here's your voucher:"
                  : `Here are your ${result.codes.length} vouchers — each one works on its own, so you can pass one to a friend:`}
              </p>
              {result.codes.map((code) => (
                <Link
                  key={code}
                  href={`/v/${code}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/15 bg-white/[0.04] px-4 py-3 transition-colors hover:border-white/35"
                >
                  <span className="font-mono text-base tracking-wider text-white">{code}</span>
                  <span className="text-xs whitespace-nowrap text-white/50">View &amp; redeem →</span>
                </Link>
              ))}
            </div>
            {result.emailPending && (
              <p className="text-xs text-amber-200/80">
                We had trouble emailing these — save this page or screenshot the codes. We&apos;ll
                keep retrying the email.
              </p>
            )}
          </>
        )}

        {result.scheduleUrl && (
          <a
            href={result.scheduleUrl}
            className="block rounded-full px-6 py-3 text-center text-sm font-bold tracking-widest uppercase transition hover:brightness-110"
            style={{ background: accentColor, color: "#00041b" }}
          >
            {scheduleLabel}
          </a>
        )}
        <p className="text-xs text-white/45">
          No rush — your game cards and sessions stay on the voucher
          {result.expiresAt
            ? ` until ${new Date(result.expiresAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}`
            : ""}
          . Booking later is fine; nothing expires the moment you leave this page.
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
          {money(priceCents)} per pack plus tax · limit {maxPerBuyer} per person
        </p>
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
        <label className="flex cursor-pointer items-start gap-2.5 text-xs text-white/55">
          <input
            type="checkbox"
            checked={smsOptIn}
            onChange={(e) => setSmsOptIn(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--deal-accent)]"
          />
          <span>Text me my voucher code too. Message rates may apply.</span>
        </label>
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
          I understand this is a prepaid voucher: it&apos;s good for {expiresMonths} months from
          today at the HeadPinz I picked, each item on it can be used once, and it isn&apos;t
          refundable once redeemed. Laser tag and gel blaster run as timed sessions subject to
          availability.
        </span>
      </label>

      {payError && <ErrorBox>{payError}</ErrorBox>}

      {readyToPay && quote && location ? (
        <PaymentForm
          amount={quote.totalCents / 100}
          itemName={`${dealName} ×${qty}`}
          billId={billId}
          contact={{ ...splitName(name), email: email.trim(), phone: phone.trim() }}
          locationId={location === "naples" ? "naples" : "headpinz"}
          onTokenize={handleTokenize}
          onSuccess={() => {}}
          onError={(msg) => setPayError(msg)}
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
