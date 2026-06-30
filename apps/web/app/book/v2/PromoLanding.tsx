"use client";

import { useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import { IconUserCircle } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import {
  isOfferingInPromoScope,
  type ActivityOffering,
  type Brand,
  type CenterCode,
} from "~/features/booking";
import { clearBookingSession, peekBookingSession } from "~/features/booking/hooks";
import { abandonBooking } from "~/features/booking/service/checkout";
import type { AppliedPromo } from "~/features/discount-codes";
import type { ComboSpecial } from "~/features/combos";

/** Customer-facing "valid on" label for a promo's booking-date window (null = any day). */
function promoValidLabel(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  // Noon-anchored so the YYYY-MM-DD never rolls a day when formatted.
  const fmt = (ymd: string) =>
    new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  if (start && end) return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
  return fmt((start ?? end)!);
}

/**
 * v2 booking landing — promo-aware activity picker.
 *
 * Visual pattern lifted from v1 HeadPinz book hub (`app/hp/book/page.tsx`)
 * so v1 + v2 stay visually consistent for the customer:
 *   - Eyebrow tag in brand-accent color
 *   - Italic uppercase heading (font-display)
 *   - Subtitle in white/60
 *   - 3-col grid of rich attraction cards with hero image, location +
 *     duration badges, attraction-colored CTA + color bar at bottom
 *
 * Brand-aware accent:
 *   - FastTrax entry → CYAN (#00E2E5)
 *   - HeadPinz entry → CORAL (#fd5b56) + gold accents for promo highlight
 *
 * Promo behavior (rev 2.5):
 *   - All offerings are shown regardless of code applied.
 *   - When a code is applied + valid for an offering, that card gets a
 *     coral / cyan "✨ Code applies" badge + accent border so the
 *     customer can tell at a glance what their code covers.
 *   - Customer can still click a non-eligible tile; the code just won't
 *     activate for it. Per user rule.
 */

const FT_ACCENT = "#00E2E5"; // FastTrax cyan
const HP_ACCENT = "#fd5b56"; // HeadPinz coral
const HP_GOLD = "#FFD700";

export interface PromoLandingProps {
  entryBrand: Brand;
  /** Physical complex this landing serves (from `?location=`). Naples scopes the
   *  grid to Naples-only; null/Fort Myers shows everything. Carried into tile
   *  links so the picked activity seeds the right center. */
  center: CenterCode | null;
  seedCode: string;
  seededPromo: AppliedPromo | null;
  seedRejected: boolean;
  /** Always the full catalog (per rev 2.5). Kept on props for parity with the server pre-resolve. */
  initialOfferings: ActivityOffering[];
  /** Identical to `initialOfferings` today; retained so a future feature can pass a different set. */
  allOfferings: ActivityOffering[];
  /** Enabled combo specials for this landing's center — lead the grid as
   *  "Best Value" cards linking to /book/combo/[id]/v2. Empty when the flag
   *  is off or the center doesn't serve them (e.g. Naples). */
  combos?: ComboSpecial[];
}

export function PromoLanding({
  entryBrand,
  center,
  seedCode,
  seededPromo,
  seedRejected,
  initialOfferings,
  combos = [],
}: PromoLandingProps) {
  const router = useRouter();
  const brandClass = entryBrand === "fasttrax" ? "brand-fasttrax" : "brand-headpinz";
  const accent = entryBrand === "fasttrax" ? FT_ACCENT : HP_ACCENT;

  const [input, setInput] = useState(seedCode);
  const [applied, setApplied] = useState<AppliedPromo | null>(seededPromo);

  // Detect existing cart items from the persisted session. useSyncExternalStore
  // keeps this SSR-safe — the server snapshot is 0, the client reads the real
  // count after hydration (no setState-in-effect, no hydration mismatch).
  // peekBookingSession unwraps the versioned storage envelope, so this stays
  // correct as the persistence shape evolves (reading the raw shape here is what
  // broke the checkout bar when the envelope landed). No live subscription is
  // needed: the count only changes across full-page navigations on this landing.
  const cartItemCount = useSyncExternalStore(
    () => () => {},
    () => peekBookingSession()?.items.length ?? 0,
    () => 0,
  );
  const hasCart = cartItemCount > 0;
  // Route the cart bar to the activity ALREADY in the cart — not a hardcoded
  // /book/race/v2, which seeded a spurious race item (the new/existing racer
  // picker) for a bowling-only cart. KBF has its own route; attractions carry
  // their slug on the item. SSR snapshot "race" is unused (the bar only renders
  // client-side once hasCart is true).
  const cartSlug = useSyncExternalStore(
    () => () => {},
    () => {
      const first = peekBookingSession()?.items[0];
      if (!first) return "race";
      if (first.kind === "bowling") return "bowling";
      if (first.kind === "kbf") return "kbf";
      if (first.kind === "attraction")
        return (first as { slug?: string | null }).slug ?? "gel-blaster";
      return "race";
    },
    () => "race",
  );
  const [rejected, setRejected] = useState(seedRejected);
  const [submitting, setSubmitting] = useState(false);
  const [clearingCart, setClearingCart] = useState(false);

  /** Release every vendor hold (BMI bill + QAMF lanes) and start fresh —
   *  identical teardown to the cart pages' "New booking". */
  async function clearCart() {
    if (clearingCart) return;
    if (!window.confirm("Clear your cart and start over? Your held spots will be released.")) {
      return;
    }
    setClearingCart(true);
    try {
      const s = peekBookingSession();
      if (s) await abandonBooking(s);
    } finally {
      clearBookingSession();
      window.location.href = "/book/v2";
    }
  }

  async function submitCode(e?: React.FormEvent) {
    e?.preventDefault();
    const code = input.trim().toUpperCase();
    if (!code) {
      setApplied(null);
      setRejected(false);
      router.replace("/book/v2");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/booking/v2/promo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.valid && data.promo) {
        setApplied(data.promo as AppliedPromo);
        setRejected(false);
        router.replace(`/book/v2?code=${encodeURIComponent(code)}`);
      } else {
        setApplied(null);
        setRejected(true);
      }
    } catch (err) {
      console.error("[promo-landing] validate failed:", err);
      setApplied(null);
      setRejected(true);
    } finally {
      setSubmitting(false);
    }
  }

  function clearCode() {
    setInput("");
    setApplied(null);
    setRejected(false);
    router.replace("/book/v2");
  }

  function tileHref(slug: string): string {
    // Carry both the applied promo and the center into the activity flow so the
    // picked activity seeds the right complex (Naples → Naples clientKey).
    const params = new URLSearchParams();
    if (applied) params.set("code", applied.code);
    if (center) params.set("location", center);
    const qs = params.toString();
    return `/book/${slug}/v2${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className={`${brandClass} min-h-screen`}>
      {/* Hero */}
      <section className="px-4 pb-8 sm:pb-10">
        <div className="mx-auto max-w-5xl text-center">
          <div className="mb-2 flex justify-end">
            <Link
              href="/account"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:text-white"
              style={{ borderColor: `${accent}40` }}
            >
              <IconUserCircle size={17} style={{ color: accent }} />
              My Account
            </Link>
          </div>
          <div
            className="mb-3 font-bold uppercase"
            style={{ color: accent, fontSize: "12px", letterSpacing: "3px" }}
          >
            {hasCart ? "Your Visit" : "Book Online"}
          </div>
          <h1
            className="font-display font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(28px, 6vw, 56px)",
              lineHeight: 1.05,
              letterSpacing: "-0.6px",
              marginBottom: "16px",
            }}
          >
            {hasCart ? "Add to your visit" : "Pick your experience"}
          </h1>
          <p
            className="font-body mx-auto text-white/60"
            style={{ fontSize: "clamp(14px, 1.8vw, 18px)", lineHeight: 1.6, maxWidth: "52ch" }}
          >
            {hasCart
              ? `${cartItemCount} activit${cartItemCount === 1 ? "y" : "ies"} booked. Add more or head to checkout.`
              : "Choose your activity to get started. Have a promo code? Drop it in first and we'll mark which experiences it's good for."}
          </p>
        </div>
      </section>

      {hasCart ? (
        /* Cart checkout bar — replaces promo input when items are booked.
           "Clear cart" (owner ask): mid-flow exits stranded customers with a
           cart they couldn't empty from here — this releases every vendor
           hold and starts fresh, same as the cart pages' New booking. */
        <section className="px-4 pb-6 sm:pb-8">
          <div className="mx-auto max-w-2xl rounded-2xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 px-6 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">
                  {cartItemCount} activit{cartItemCount === 1 ? "y" : "ies"} in your cart
                </p>
                <p className="text-xs text-white/40">Add more below or checkout when ready</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Link
                  href={`/book/${cartSlug}/v2?cart=1`}
                  className="whitespace-nowrap rounded-xl border border-white/15 px-5 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
                >
                  View Cart
                </Link>
                <Link
                  href={`/book/${cartSlug}/v2?checkout=1`}
                  className="whitespace-nowrap rounded-xl bg-[#00E2E5] px-5 py-2.5 text-sm font-bold text-[#000418] shadow-lg shadow-[#00E2E5]/25 transition-colors hover:bg-white"
                >
                  Checkout →
                </Link>
              </div>
            </div>
            <button
              type="button"
              disabled={clearingCart}
              onClick={() => void clearCart()}
              className="mt-2 text-xs text-red-400/60 underline-offset-2 transition-colors hover:text-red-400 hover:underline disabled:opacity-50"
            >
              {clearingCart ? "Clearing…" : "✕ Clear cart & start over"}
            </button>
          </div>
        </section>
      ) : (
        /* Promo input — shown when no cart */
        <section className="px-4 pb-6 sm:pb-8">
          <div className="mx-auto max-w-md">
            <form onSubmit={submitCode} className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1">
                <span
                  className="block font-bold uppercase text-white/40"
                  style={{ fontSize: "11px", letterSpacing: "2.5px" }}
                >
                  Promo code
                </span>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value.toUpperCase())}
                  placeholder="MAY20WEEKDAY"
                  autoComplete="off"
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/4 px-4 py-3 text-sm uppercase tracking-wider text-white placeholder-white/30 focus:bg-white/8 focus:outline-none"
                  style={{ borderColor: applied ? `${accent}55` : undefined }}
                />
              </label>
              <button
                type="submit"
                disabled={submitting || input.trim() === (applied?.code ?? "")}
                className="rounded-full px-6 py-3 font-body text-sm font-bold uppercase tracking-wider transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                style={{ backgroundColor: accent, color: "#0a1628" }}
              >
                {submitting ? "…" : applied ? "Update" : "Apply"}
              </button>
            </form>

            {applied && (
              <div
                className="mt-3 flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                style={{ borderColor: `${accent}40`, backgroundColor: `${accent}12` }}
              >
                <div className="text-sm" style={{ color: accent }}>
                  <span className="font-bold">{applied.code}</span> applied —{" "}
                  {applied.mechanic === "percent" && applied.amountPct != null
                    ? `${applied.amountPct}% off`
                    : applied.mechanic === "fixed" && applied.amountCents != null
                      ? `$${(applied.amountCents / 100).toFixed(2)} off`
                      : ""}
                  {promoValidLabel(applied.bookingDateStart, applied.bookingDateEnd) && (
                    <span className="font-semibold">
                      {" "}
                      · valid {promoValidLabel(applied.bookingDateStart, applied.bookingDateEnd)}
                    </span>
                  )}{" "}
                  <span className="text-white/50">— eligible experiences marked below.</span>
                </div>
                <button
                  type="button"
                  onClick={clearCode}
                  className="text-xs text-white/50 transition-colors hover:text-white"
                >
                  Clear
                </button>
              </div>
            )}
            {rejected && !applied && (
              <p className="mt-3 text-center text-sm text-amber-400/80">
                We couldn&apos;t apply that code. It may be expired, fully used, or not yet active.
                Pick an activity below to continue without it.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Attraction grid — combo specials lead (best value) */}
      <section className="px-4 pb-12 sm:pb-20">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
            {combos.map((combo) => (
              <ComboCard key={combo.id} combo={combo} gold={HP_GOLD} />
            ))}
            {initialOfferings.map((o) => (
              <AttractionCard
                key={o.slug}
                offering={o}
                href={tileHref(o.slug)}
                applied={applied}
                accent={accent}
                gold={HP_GOLD}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Gold checkmark bullet for the combo "What's included" lists. */
function ComboCheck({ gold }: { gold: string }) {
  return (
    <span
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
      style={{ backgroundColor: `${gold}25`, color: gold }}
    >
      ✓
    </span>
  );
}

/** Combo-special landing card — same visual language as AttractionCard, with a
 *  gold "Best Value"/"Ultimate VIP" badge, the per-person day-tier pricing, and
 *  both venue logos (a combo spans FastTrax racing + HeadPinz bowling).
 *  Premium combos render DOUBLE: two grid columns on sm+ and a much taller
 *  image band on mobile, so the tile dominates the grid. */
function ComboCard({ combo, gold }: { combo: ComboSpecial; gold: string }) {
  const fmtPrice = (cents: number) =>
    Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
  const premium = !!combo.premium;

  return (
    <Link
      href={`/book/combo/${combo.id}/v2`}
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all duration-300 hover:bg-white/6 ${
        premium ? "sm:col-span-2" : ""
      }`}
      style={{
        borderColor: `${gold}55`,
        boxShadow: premium ? `0 0 32px ${gold}2e` : `0 0 24px ${gold}1a`,
      }}
    >
      {/* Hero image — premium gets a double-height band */}
      <div
        className={`relative overflow-hidden ${premium ? "aspect-square sm:aspect-[21/9]" : "aspect-16/10"}`}
      >
        <Image
          src={combo.heroImage}
          alt={combo.name}
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-105"
          sizes={
            premium
              ? "(max-width: 640px) 100vw, 66vw"
              : "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          }
        />
        <div className="absolute inset-0 bg-linear-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />
        <div className="absolute right-3 top-3">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-sm"
            style={{ backgroundColor: gold, color: "#0a1628" }}
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 2l2.39 4.84L18 8l-4 3.9.94 5.5L10 14.77 5.06 17.4 6 11.9 2 8l5.61-1.16L10 2z" />
            </svg>
            {premium ? "Ultimate VIP" : "Best Value"}
          </span>
        </div>
        {premium && combo.durationLabel && (
          <div className="absolute left-3 top-3">
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <circle cx="12" cy="12" r="10" />
                <path strokeLinecap="round" d="M12 6v6l4 2" />
              </svg>
              {combo.durationLabel}
            </span>
          </div>
        )}
        {premium && (
          <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
            <h3 className="font-display text-2xl font-black uppercase tracking-wider text-white sm:text-3xl">
              {combo.name}
            </h3>
          </div>
        )}
      </div>

      {/* Content (premium carries the name on the image overlay instead) */}
      <div className="flex flex-1 flex-col p-4 sm:p-5">
        {!premium && (
          <h3 className="font-display mb-1.5 text-lg font-black uppercase tracking-wider text-white sm:text-xl">
            {combo.name}
          </h3>
        )}

        {/* What's included — one labeled, grouped checklist (the activities
            you do + the VIP perks) so the package reads as a single offering,
            not two competing lists scattered around the card */}
        <div className={`mb-4 grid grid-cols-1 gap-x-6 gap-y-3 ${premium ? "sm:grid-cols-2" : ""}`}>
          <div>
            <p
              className="mb-1.5 text-[11px] font-bold uppercase tracking-[2px]"
              style={{ color: gold }}
            >
              Your experience
            </p>
            <ul className="space-y-1">
              {combo.includes.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm leading-snug text-white/80"
                >
                  <ComboCheck gold={gold} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          {(combo.perks?.length ?? 0) > 0 && (
            <div>
              <p
                className="mb-1.5 text-[11px] font-bold uppercase tracking-[2px]"
                style={{ color: gold }}
              >
                VIP perks included
              </p>
              <ul className="space-y-1">
                {combo.perks!.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-sm leading-snug text-white/80"
                  >
                    <ComboCheck gold={gold} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <p className="font-body mb-3 flex-1 text-sm leading-relaxed">
          <span className="font-bold text-white">
            {fmtPrice(combo.price.weekday)}/person Mon–Thu
          </span>
          <span className="text-white/50"> · {fmtPrice(combo.price.weekend)}/person Fri–Sun</span>
        </p>

        {/* Venue badges — a combo spans both buildings */}
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-white/50">
            Located within
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png"
            alt="FastTrax Entertainment"
            className="h-5 w-auto"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp"
            alt="HeadPinz Entertainment"
            className="h-5 w-auto"
          />
        </div>

        <div
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold transition-colors"
          style={{
            backgroundColor: combo.accentColor,
            color: combo.premium ? "#0a1628" : "#ffffff",
          }}
        >
          {combo.premium ? "Book the VIP Experience" : "Book This Combo"}
          <svg
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </div>
      </div>

      {/* Bottom color bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: combo.accentColor }} />
    </Link>
  );
}

function AttractionCard({
  offering,
  href,
  applied,
  accent,
  gold,
}: {
  offering: ActivityOffering;
  href: string;
  applied: AppliedPromo | null;
  accent: string;
  gold: string;
}) {
  const inScope = applied ? isOfferingInPromoScope(offering, applied) : false;
  const cardColor = offering.accentColor ?? accent;

  return (
    <Link
      href={href}
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all duration-300 hover:bg-white/6"
      style={{
        borderColor: inScope ? `${gold}55` : "rgba(255,255,255,0.10)",
        boxShadow: inScope ? `0 0 24px ${gold}1a` : undefined,
      }}
    >
      {/* Hero image */}
      <div className="relative aspect-16/10 overflow-hidden">
        {offering.heroImage && (
          <Image
            src={offering.heroImage}
            alt={offering.displayName}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />

        {/* Duration OR promo eligibility badge — eligibility wins when applied */}
        <div className="absolute right-3 top-3">
          {inScope ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-sm"
              style={{ backgroundColor: `${gold}`, color: "#0a1628" }}
            >
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 2l2.39 4.84L18 8l-4 3.9.94 5.5L10 14.77 5.06 17.4 6 11.9 2 8l5.61-1.16L10 2z" />
              </svg>
              Code applies
            </span>
          ) : (
            offering.durationLabel && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-xs font-medium text-white/70 backdrop-blur-sm">
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="10" />
                  <path strokeLinecap="round" d="M12 6v6l4 2" />
                </svg>
                {offering.durationLabel}
              </span>
            )
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <h3 className="font-display mb-1.5 text-lg font-black uppercase tracking-wider text-white sm:text-xl">
          {offering.displayName}
        </h3>
        <p className="font-body mb-3 flex-1 text-sm leading-relaxed text-white/50">
          {offering.blurb}
        </p>

        {/* Venue badge — which building this activity lives in */}
        {(() => {
          const isFastTrax =
            offering.kind === "race" || offering.slug === "duck-pin" || offering.slug === "shuffly";
          return (
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-white/50">
                Located within
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={
                  isFastTrax
                    ? "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png"
                    : "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp"
                }
                alt={isFastTrax ? "FastTrax Entertainment" : "HeadPinz Entertainment"}
                className="h-5 w-auto"
              />
            </div>
          );
        })()}

        <div
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold transition-colors"
          style={{ backgroundColor: cardColor, color: "#ffffff" }}
        >
          Book Now
          <svg
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </div>
      </div>

      {/* Bottom color bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: cardColor }} />
    </Link>
  );
}
