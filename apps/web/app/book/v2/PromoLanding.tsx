"use client";

import { Fragment, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
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
import { isNativeVoucherCode } from "~/features/game-cards/vouchers/codes";
import { BMI_VOUCHER_RE, voucherTarget } from "~/features/booking/service/voucher-redeem";
import type { ComboSpecial } from "~/features/combos";
import type { WorldCupTeamRef } from "~/features/world-cup";
import type { NflTileData } from "~/features/nfl/landing.server";

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
  /** World Cup VIP Bowling tile (limited-time, HeadPinz). Null when the
   *  tournament window is over, the brand isn't HeadPinz, or every in-scope
   *  center's kill switch is off. Computed server-side in page.tsx. */
  worldCup?: WorldCupTileData | null;
  nfl?: NflTileData | null;
  /**
   * Product id → the one-line reason it's unavailable, for every offering/combo
   * whose VENDOR is down (maintenance mode). Presence in the map means paused, so
   * those cards render locked and unclickable with the reason on the CTA.
   *
   * A MAP rather than a list of ids because the reason is per-VENDOR: with two
   * vendors down at once, each card must show its own vendor's reason instead of
   * whichever outage leads the banner. Resolved server-side in page.tsx (the
   * registry reads server-only env).
   *
   * Middleware would bounce a click to /service-notice anyway; showing the lock
   * here is what keeps the landing honest.
   */
  pausedNotes?: Record<string, string>;
  /** Outage banner copy, or null when everything is up. */
  outageNotice?: { heading: string; body: string } | null;
}

export function PromoLanding({
  entryBrand,
  center,
  seedCode,
  seededPromo,
  seedRejected,
  initialOfferings,
  combos = [],
  worldCup = null,
  nfl = null,
  pausedNotes = {},
  outageNotice = null,
}: PromoLandingProps) {
  const router = useRouter();
  // Presence in the map means paused; the value is that vendor's one-line reason.
  const pausedNote = (id: string): string | undefined => pausedNotes[id];
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
  const [voucher, setVoucher] = useState<AppliedVoucher | null>(null);
  /** Guest copy for a voucher that is live but not usable on THIS surface. */
  const [voucherNote, setVoucherNote] = useState<string | null>(null);
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
      // Keep the landing's center context (owner bug 7/6: clearing the cart on
      // a Naples landing bounced the visitor back to the center-less default).
      window.location.href = center ? `/book/v2?location=${center}` : "/book/v2";
    }
  }

  /**
   * One field, three kinds of code. Classification happens LOCALLY and
   * most-specific-first, the same precedence rule the kiosk scan surface lives
   * by (kiosk/entry-scan/classify-entry.ts): both voucher shapes are exact, and
   * the promo validator is the greedy catch-all, so testing it first would
   * swallow every voucher as an invalid discount code.
   *
   *   HPW…  → our own voucher     → native-peek, covers specific attractions
   *   24-ch → a BMI voucher       → peek, one comp line
   *   else  → discount code       → the promo validator
   */
  async function submitCode(e?: React.FormEvent) {
    e?.preventDefault();
    const code = input.trim().toUpperCase();
    if (!code) {
      clearCode();
      return;
    }
    setSubmitting(true);
    setRejected(false);
    try {
      if (isNativeVoucherCode(code)) {
        await resolveNativeVoucher(code);
      } else if (BMI_VOUCHER_RE.test(code.replace(/\s+/g, ""))) {
        await resolveBmiVoucher(code);
      } else {
        await resolvePromo(code);
      }
    } catch (err) {
      console.error("[promo-landing] validate failed:", err);
      setApplied(null);
      setVoucher(null);
      setRejected(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function resolvePromo(code: string) {
    const res = await fetch("/api/booking/v2/promo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.valid && data.promo) {
      setApplied(data.promo as AppliedPromo);
      setVoucher(null);
      router.replace(`/book/v2?code=${encodeURIComponent(code)}`);
    } else {
      setApplied(null);
      setVoucher(null);
      setRejected(true);
    }
  }

  /**
   * Our own voucher. `native-peek` returns ONE LEG PER COVERED ENTRY, and each
   * leg's coverage name maps to the attraction slugs it can pay for — the same
   * `voucherTarget` the reserve path uses, so what we highlight here is exactly
   * what checkout will actually cover.
   */
  async function resolveNativeVoucher(code: string) {
    const res = await fetch("/api/booking/v2/voucher", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "native-peek", code }),
    });
    const data = await res.json();
    if (!data.ok) {
      setApplied(null);
      setVoucher(null);
      // A game-card-only voucher is live and worth money, just not bookable —
      // saying "invalid" would tell the guest their money is gone.
      setRejected(true);
      // GAME ZONE CREDIT IS NEVER CONSUMED ON WEB (owner rule 2026-08-03).
      // There is no dispenser on a phone and no way to verify a card is in the
      // guest's hand, so booking must not touch a game-card leg — it says where
      // the credit IS redeemable and leaves the voucher untouched. `native-peek`
      // is a read; nothing is claimed by reaching this branch.
      setVoucherNote(
        data.reason === "gamezone_only"
          ? "That's game-card credit — bring it to any HeadPinz kiosk and it'll print your cards. It can't be used to book a time."
          : null,
      );
      return;
    }
    // `native-peek` already returns ONLY `redeemVia === "cart"` legs, so game
    // Zone legs never reach here. Belt-and-braces filter anyway: if that route
    // ever widens, web must not start covering card credit silently.
    const legs: { itemIndex: number; name: string; label: string }[] = (data.legs ?? []).filter(
      (l: { name?: string }) => voucherTarget(l.name).kind !== "gamecard",
    );
    if (legs.length === 0) {
      setApplied(null);
      setVoucher(null);
      setRejected(true);
      setVoucherNote(
        "That's game-card credit — bring it to any HeadPinz kiosk and it'll print your cards. It can't be used to book a time.",
      );
      return;
    }
    const slugs = [
      ...new Set(
        legs.flatMap((l) => {
          const t = voucherTarget(l.name);
          return t.kind === "attraction" ? t.slugs : t.kind === "race" ? ["race"] : [];
        }),
      ),
    ];
    setApplied(null);
    setVoucherNote(null);
    setVoucher({
      code,
      slugs,
      // Legs are individual on purpose; the guest cares how MANY they have.
      summary: summariseLegs(legs.map((l) => l.label)),
    });
    router.replace(`/book/v2?voucher=${encodeURIComponent(code)}`);
  }

  /** A BMI-issued voucher: one comp line, so one coverage target. */
  async function resolveBmiVoucher(code: string) {
    const res = await fetch("/api/booking/v2/voucher", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "peek", code, ...(center ? { center } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) {
      setApplied(null);
      setVoucher(null);
      setRejected(true);
      return;
    }
    const names: string[] = (data.names?.length ? data.names : [data.name].filter(Boolean)).filter(
      (n: string) => voucherTarget(n).kind !== "gamecard",
    );
    if (names.length === 0) {
      setApplied(null);
      setVoucher(null);
      setRejected(true);
      setVoucherNote(
        "That's game-card credit — bring it to any HeadPinz kiosk and it'll print your cards. It can't be used to book a time.",
      );
      return;
    }
    const slugs = [
      ...new Set(
        names.flatMap((n) => {
          const t = voucherTarget(n);
          return t.kind === "attraction" ? t.slugs : t.kind === "race" ? ["race"] : [];
        }),
      ),
    ];
    setApplied(null);
    setVoucherNote(null);
    setVoucher({ code, slugs, summary: summariseLegs(names) });
    router.replace(`/book/v2?voucher=${encodeURIComponent(code)}`);
  }

  function clearCode() {
    setInput("");
    setApplied(null);
    setVoucher(null);
    setVoucherNote(null);
    setRejected(false);
    router.replace("/book/v2");
  }

  function tileHref(slug: string): string {
    // Carry both the applied promo and the center into the activity flow so the
    // picked activity seeds the right complex (Naples → Naples clientKey).
    const params = new URLSearchParams();
    if (applied) params.set("code", applied.code);
    // Vouchers ride their own param — CheckoutStep seeds the codes from
    // `?voucher=` and applies them at checkout. A voucher is never a `code`.
    if (voucher) params.set("voucher", voucher.code);
    if (center) params.set("location", center);
    const qs = params.toString();
    return `/book/${slug}/v2${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className={`${brandClass} min-h-screen`}>
      {/* Hero */}
      <section className="px-4 pb-8 sm:pb-10">
        <div className="mx-auto max-w-5xl text-center">
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
              : "Choose your activity to get started. Have a voucher or promo code? Drop it in first and we'll mark which experiences it's good for."}
          </p>
        </div>
      </section>

      {/* Vendor outage banner — above everything, because it changes what the
          grid below means. Amber (not red): the site works, one vendor doesn't. */}
      {outageNotice && (
        <section className="px-4 pb-6 sm:pb-8">
          <div
            className="mx-auto max-w-2xl rounded-2xl border px-5 py-4"
            style={{ borderColor: "#f59e0b40", backgroundColor: "#f59e0b0f" }}
          >
            <p
              className="mb-1 font-bold uppercase"
              style={{ color: "#f59e0b", fontSize: "11px", letterSpacing: "2.5px" }}
            >
              {outageNotice.heading}
            </p>
            <p className="font-body text-sm leading-relaxed text-white/70">{outageNotice.body}</p>
          </div>
        </section>
      )}

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
                  Voucher or promo code
                </span>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value.toUpperCase())}
                  placeholder="HPW-XXXX-XXXX or MAY20WEEKDAY"
                  autoComplete="off"
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/4 px-4 py-3 text-sm uppercase tracking-wider text-white placeholder-white/30 focus:bg-white/8 focus:outline-none"
                  style={{ borderColor: applied || voucher ? `${accent}55` : undefined }}
                />
              </label>
              <button
                type="submit"
                disabled={submitting || input.trim() === (applied?.code ?? voucher?.code ?? "")}
                className="rounded-full px-6 py-3 font-body text-sm font-bold uppercase tracking-wider transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                style={{ backgroundColor: accent, color: "#0a1628" }}
              >
                {submitting ? "…" : applied || voucher ? "Update" : "Apply"}
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
            {voucher && (
              <div
                className="mt-3 flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                style={{ borderColor: `${accent}40`, backgroundColor: `${accent}12` }}
              >
                <div className="text-sm" style={{ color: accent }}>
                  <span className="font-bold">{voucher.code}</span> applied —{" "}
                  <span className="font-semibold">{voucher.summary}</span>{" "}
                  <span className="text-white/50">
                    {voucher.slugs.length > 0
                      ? "— covered experiences marked below. Nothing more to pay for them."
                      : "— pick your experience below."}
                  </span>
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
            {rejected && !applied && !voucher && (
              <p className="mt-3 text-center text-sm text-amber-400/80">
                {voucherNote ??
                  "We couldn't apply that code. It may be expired, fully used, or not yet active. Pick an activity below to continue without it."}
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
              <ComboCard
                key={combo.id}
                combo={combo}
                gold={HP_GOLD}
                // The VIP pack's availability id is the wire key "race-bowl"
                // regardless of which registry entry is live (v1 / the 7/31 v2).
                pausedNote={pausedNote(combo.id.startsWith("race-bowl") ? "race-bowl" : combo.id)}
              />
            ))}
            {/* World Cup VIP Bowling — compact time-boxed tile after the combo
                specials (owner 7/6: "small box second row", Ultimate VIP keeps
                the lead). Self-hides after the final. */}
            {worldCup && <WorldCupCard worldCup={worldCup} gold={HP_GOLD} />}
            {nfl && <NflCard nfl={nfl} />}
            {initialOfferings.map((o) => (
              // The Race Sims teaser rides DIRECTLY behind the racing tile, so
              // it is the third grid child on the live landing (the premium VIP
              // combo is sm:col-span-2, so VIP + racing fill row one and the
              // teaser opens row two on both the 3-col and 2-col grids). Keyed
              // off racing's PRESENCE rather than a fixed index: the sims are
              // physically at FastTrax FM, so wherever racing is not offered
              // neither are they, and the two tiles can never drift apart.
              <Fragment key={o.slug}>
                <AttractionCard
                  offering={o}
                  href={tileHref(o.slug)}
                  applied={applied}
                  voucherSlugs={voucher?.slugs ?? null}
                  accent={accent}
                  gold={HP_GOLD}
                  pausedNote={pausedNote(o.slug)}
                />
                {o.kind === "race" && <RaceSimsSoonCard />}
              </Fragment>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A voucher applied on the landing. Unlike a promo it carries no discount
 * mechanic — it pays for whole entries at checkout — so the only things worth
 * holding are the code, what it covers, and which tiles to mark.
 */
interface AppliedVoucher {
  code: string;
  /** Attraction slugs (plus "race") this voucher can pay for. */
  slugs: string[];
  /** "2 × Laser Tag" — collapsed, not one row per leg. */
  summary: string;
}

/** Collapse repeated leg labels into counted parts: "2 × Laser Tag + Race". */
function summariseLegs(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  return (
    [...counts].map(([label, n]) => (n > 1 ? `${n} × ${label}` : label)).join(" + ") ||
    "your voucher"
  );
}

/** Data the /book/v2 server page passes for the World Cup tile. */
export interface WorldCupTileData {
  href: string;
  /** Full fallback line, e.g. "USA vs Belgium — Mon, Jul 6 8 PM". */
  nextMatch: string | null;
  /** Day + time only — used when the flag row renders the teams itself. */
  nextWhen: string | null;
  nextHome?: WorldCupTeamRef | null;
  nextAway?: WorldCupTeamRef | null;
}

/** Country flag chip for the "Next up" line (ESPN CDN, live-enriched). Plain
 *  img on purpose: external host, tiny, lazy, and next/image would need a
 *  remotePatterns config for a two-week feature. */
function FlagImg({ src, alt }: { src: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external ESPN flag PNG, lazy + tiny
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="h-3.5 w-auto rounded-[2px] ring-1 ring-white/20"
    />
  );
}

/** World Cup VIP Bowling landing card — COMPACT single-width tile (owner 7/6:
 *  "small box second row"; Ultimate VIP keeps the lead spot). Fronted by the
 *  real photo of the VIP lanes with the match live on the NeoVerse wall.
 *  Limited-time: the parent only passes `worldCup` while the tournament window
 *  is active and a center's kill switch is on, so it self-retires after the
 *  July 19 final. */
function WorldCupCard({ worldCup, gold }: { worldCup: WorldCupTileData; gold: string }) {
  return (
    <Link
      href={worldCup.href}
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all duration-300 hover:bg-white/6"
      style={{ borderColor: `${gold}55`, boxShadow: `0 0 18px ${gold}24` }}
    >
      <div className="relative aspect-[4/3] overflow-hidden">
        <Image
          src="/promo/world-cup/neoverse-vip.jpg"
          alt="World Cup match on the NeoVerse LED wall over the VIP bowling lanes"
          fill
          className="object-cover transition-transform duration-500 group-hover:scale-105"
          sizes="(max-width: 640px) 100vw, 33vw"
        />
        <div className="absolute inset-0 bg-linear-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />
        <div className="absolute right-3 top-3">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider backdrop-blur-sm"
            style={{ backgroundColor: gold, color: "#0a1628" }}
          >
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 2l2.39 4.84L18 8l-4 3.9.94 5.5L10 14.77 5.06 17.4 6 11.9 2 8l5.61-1.16L10 2z" />
            </svg>
            Limited Time
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 p-4">
          <h3 className="font-display text-xl font-black uppercase tracking-wider text-white">
            World Cup VIP Bowling
          </h3>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="mb-2 text-sm text-white/75">
          2½-hr VIP lane from kickoff · NeoVerse LED walls · chips &amp; salsa included · shoes
          extra
        </p>

        {worldCup.nextHome && worldCup.nextAway ? (
          <p className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-semibold text-white/60">
            <span>Next up:</span>
            {worldCup.nextHome.logo && (
              <FlagImg src={worldCup.nextHome.logo} alt={`${worldCup.nextHome.name} flag`} />
            )}
            <span className="text-white/90">{worldCup.nextHome.name}</span>
            <span>vs</span>
            {worldCup.nextAway.logo && (
              <FlagImg src={worldCup.nextAway.logo} alt={`${worldCup.nextAway.name} flag`} />
            )}
            <span className="text-white/90">{worldCup.nextAway.name}</span>
            {worldCup.nextWhen && <span>— {worldCup.nextWhen}</span>}
          </p>
        ) : (
          worldCup.nextMatch && (
            <p className="mb-3 text-xs font-semibold text-white/60">
              Next up: <span className="text-white/90">{worldCup.nextMatch}</span>
            </p>
          )
        )}

        <div className="mt-auto flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-white">
            $112.50–$137.50
            <span className="text-xs font-normal text-white/50">/lane + tax</span>
          </p>
          <span
            className="whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider transition-transform group-hover:scale-[1.03]"
            style={{ backgroundColor: gold, color: "#0a1628" }}
          >
            Pick Your Match →
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Card outer element: a Link normally, an inert div while the activity's vendor
 * is down (maintenance mode). One shell for both card types so the locked
 * treatment can't drift between them — and so a locked card is genuinely not a
 * link, rather than a link styled to look dead (which still navigates on Enter
 * for a keyboard user and still gets crawled).
 */
function CardShell({
  href,
  paused,
  className,
  style,
  children,
}: {
  href: string;
  paused: boolean;
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  if (paused) {
    return (
      <div
        aria-disabled="true"
        className={`${className} opacity-55 saturate-50`}
        style={{ ...style, boxShadow: undefined }}
      >
        {children}
      </div>
    );
  }
  return (
    <Link href={href} className={className} style={style}>
      {children}
    </Link>
  );
}

/**
 * Replaces a locked card's CTA, and explains itself STANDALONE.
 *
 * "Temporarily unavailable" on its own reads like the product was discontinued —
 * a guest scrolling the grid may never read the banner at the top of the page
 * (owner 2026-08-03, looking at the live VIP card: "could say a bit more like
 * system issue, check back later today"). So the label carries the vendor's own
 * one-line reason underneath it, and says when to come back.
 *
 * `note` comes from the outage registry, resolved per PRODUCT, so a card can
 * never show another vendor's reason when two are down at once.
 */
function UnavailableCta({ note }: { note?: string }) {
  return (
    <div className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-center">
      <div className="text-sm font-bold text-white/70">Temporarily unavailable</div>
      {note && <div className="font-body mt-1 text-xs leading-snug text-white/45">{note}</div>}
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
function ComboCard({
  combo,
  gold,
  pausedNote,
}: {
  combo: ComboSpecial;
  gold: string;
  /** Set when a vendor the combo needs is down — the value is that vendor's
   *  one-line reason, shown on the locked CTA. The Ultimate VIP spans BMI racing
   *  AND a QAMF lane, so either one dark locks it. */
  pausedNote?: string;
}) {
  const paused = pausedNote !== undefined;
  const fmtPrice = (cents: number) =>
    Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
  const premium = !!combo.premium;

  return (
    <CardShell
      href={`/book/combo/${combo.id}/v2`}
      paused={paused}
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all duration-300 ${
        paused ? "" : "hover:bg-white/6"
      } ${premium ? "sm:col-span-2" : ""}`}
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
            {premium ? "VIP Experience" : "Best Value"}
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

        {/* What's included — ONE checklist (itinerary + perks together; owner
            2026-07-31: the two side-by-side lists read as the same thing).
            Premium flows the merged list across two columns for width. */}
        <div className="mb-4">
          <p
            className="mb-1.5 text-[11px] font-bold uppercase tracking-[2px]"
            style={{ color: gold }}
          >
            What&apos;s included
          </p>
          <ul className={`grid grid-cols-1 gap-x-6 gap-y-1 ${premium ? "sm:grid-cols-2" : ""}`}>
            {[...combo.includes, ...(combo.perks ?? [])].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm leading-snug text-white/80">
                <ComboCheck gold={gold} />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Voucher inclusions — their own boxed section so the shared terms
            appear ONCE instead of a suffix on every line */}
        {combo.voucherIncludes && (
          <div
            className="mb-4 rounded-xl px-4 py-3"
            style={{ border: `1px solid ${gold}66`, backgroundColor: `${gold}0f` }}
          >
            <p
              className="mb-1.5 text-[11px] font-bold uppercase tracking-[2px]"
              style={{ color: gold }}
            >
              {combo.voucherIncludes.title ?? "Plus vouchers to your favorite attractions"}
            </p>
            <ul className={`grid grid-cols-1 gap-x-6 gap-y-1 ${premium ? "sm:grid-cols-2" : ""}`}>
              {combo.voucherIncludes.items.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm leading-snug text-white/80"
                >
                  <ComboCheck gold={gold} />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-white/50">
              {combo.voucherIncludes.note}
            </p>
          </div>
        )}

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

        {paused ? (
          <UnavailableCta note={pausedNote} />
        ) : (
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
        )}
      </div>

      {/* Bottom color bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: combo.accentColor }} />
    </CardShell>
  );
}

/**
 * Race Sims — a NOT-YET-BOOKABLE teaser tile.
 *
 * Deliberately NOT an entry in `activities-catalog.ts`: that catalog is the
 * source of truth for things a guest can actually buy, and every consumer of it
 * (promo scope, voucher slugs, `tileHref`) assumes a real `/book/<slug>/v2`
 * flow behind each row. A slug with no flow would hand those a dead link. So
 * the teaser follows the WorldCupCard precedent instead — a bespoke card the
 * grid places itself — and carries no href at all.
 *
 * The locked treatment is `CardShell`'s existing `paused` idiom (a plain
 * `aria-disabled` div, `opacity-55 saturate-50`), which is already how this
 * grid renders an untappable card, so a Coming Soon tile and a maintenance-
 * locked tile read as the same kind of thing to a guest. Accent `#ff6b6b` and
 * the red-track hero match the kiosk's own sim tile, so the product looks like
 * one product across web and kiosk.
 *
 * When sims go bookable this component is DELETED, not edited — the tile
 * becomes a normal catalog offering with a real flow behind it.
 */
function RaceSimsSoonCard() {
  const accent = "#ff6b6b";
  return (
    <div
      aria-disabled="true"
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left opacity-55 saturate-50"
      style={{ borderColor: "rgba(255,255,255,0.10)" }}
    >
      {/* Hero — the kiosk sim tile's red-track shot (same pinned blob asset) */}
      <div className="relative aspect-16/10 overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/red-track-kiosk.webp"
          alt="Race Sims"
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
        <div className="absolute inset-0 bg-linear-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />
        <div className="absolute right-3 top-3">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-sm"
            style={{ backgroundColor: accent, color: "#2b0404" }}
          >
            Coming Soon
          </span>
        </div>
      </div>

      {/* Content — same geometry as AttractionCard so the row stays even */}
      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <h3 className="font-display mb-1.5 text-lg font-black uppercase tracking-wider text-white sm:text-xl">
          Race Sims
        </h3>
        <p className="font-body mb-3 flex-1 text-sm leading-relaxed text-white/50">
          Full-motion racing simulators are on their way to FastTrax Fort Myers.
        </p>

        {/* Venue badge — sims live in the FastTrax building, same as racing */}
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
        </div>

        <div className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-center">
          <div className="text-sm font-bold text-white/70">Not yet bookable</div>
          <div className="font-body mt-1 text-xs leading-snug text-white/45">
            Check back soon — we&apos;ll open booking here first.
          </div>
        </div>
      </div>

      <div className="h-0.5 w-full" style={{ backgroundColor: accent }} />
    </div>
  );
}

/**
 * NFL Ticket on NeoVerse — one card with TWO states off one switch.
 *
 * `nfl.comingSoon` comes from `nflTileData`, which reads the same
 * `bowling_experiences.is_active` rows the booking flow reads. So the tile
 * cannot advertise a package the flow will refuse, and cannot sit locked while
 * the flow quietly takes money.
 *
 * That is the one way this differs from its neighbour `RaceSimsSoonCard`, and
 * the difference is not stylistic: sims have no booking flow at all, so a
 * hardcoded teaser has nothing to contradict and is simply deleted on launch.
 * NFL has a full flow behind `/book/nfl`, so a hardcoded tile would drift the
 * moment anyone flipped the rows.
 *
 * The locked treatment is the same `aria-disabled` + `opacity-55 saturate-50`
 * idiom the sims teaser and a maintenance-locked card use, so all three read as
 * the same kind of thing to a guest. Violet is this package's own accent on the
 * Experience step and in its picker (owner 2026-07-26).
 *
 * Bespoke rather than an `activities-catalog.ts` row, following WorldCupCard:
 * that catalog's consumers (promo scope, voucher slugs, `tileHref`) all assume
 * a `/book/<slug>/v2` flow behind every entry, and this package's entry is
 * `/book/nfl`.
 */
function NflCard({ nfl }: { nfl: NflTileData }) {
  const accent = "#A78BFA";
  const soon = nfl.comingSoon;

  const body = (
    <>
      <div className="relative aspect-16/10 overflow-hidden">
        <Image
          src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-bowling.webp"
          alt="NFL Ticket on NeoVerse"
          fill
          className="object-cover"
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        />
        <div className="absolute inset-0 bg-linear-to-t from-[#0a1628] via-[#0a1628]/40 to-transparent" />
        <div className="absolute right-3 top-3">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-sm"
            style={{ backgroundColor: accent, color: "#1b1033" }}
          >
            {soon ? "Coming Soon" : "NFL Ticket"}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <h3 className="font-display mb-1.5 text-lg font-black uppercase tracking-wider text-white sm:text-xl">
          NFL Ticket on NeoVerse
        </h3>
        <p className="font-body mb-3 flex-1 text-sm leading-relaxed text-white/50">
          Pick your game, not a time. Your VIP lane opens 15 minutes before kickoff and is yours
          for 3 hours — shoes, a one-topping pizza, 10 wings and a soda pitcher included.
        </p>

        {nfl.nextGame && (
          <div className="mb-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-white/40">
              Next up
            </span>
            <p className="font-body mt-0.5 text-xs leading-snug" style={{ color: accent }}>
              {nfl.nextGame}
            </p>
          </div>
        )}

        {soon ? (
          <div className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-center">
            <div className="text-sm font-bold text-white/70">Not yet bookable</div>
            <div className="font-body mt-1 text-xs leading-snug text-white/45">
              Check back soon — we&apos;ll open booking here first.
            </div>
          </div>
        ) : (
          <div
            className="w-full rounded-xl px-4 py-3 text-center text-sm font-bold"
            style={{ backgroundColor: accent, color: "#1b1033" }}
          >
            Pick your game
          </div>
        )}
      </div>

      <div className="h-0.5 w-full" style={{ backgroundColor: accent }} />
    </>
  );

  if (soon || !nfl.href) {
    return (
      <div
        aria-disabled="true"
        className="group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left opacity-55 saturate-50"
        style={{ borderColor: "rgba(255,255,255,0.10)" }}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={nfl.href}
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all hover:border-white/25"
      style={{ borderColor: "rgba(255,255,255,0.10)" }}
    >
      {body}
    </Link>
  );
}

function AttractionCard({
  offering,
  href,
  applied,
  voucherSlugs = null,
  accent,
  gold,
  pausedNote,
}: {
  offering: ActivityOffering;
  href: string;
  applied: AppliedPromo | null;
  /** Slugs a voucher covers, or null. Marked the SAME way a promo is — from the
   *  guest's side "this code works here" is one idea, not two. */
  voucherSlugs?: string[] | null;
  accent: string;
  gold: string;
  /** Set when this activity's vendor is down — the value is the reason shown on
   *  the locked CTA (maintenance mode). */
  pausedNote?: string;
}) {
  const paused = pausedNote !== undefined;
  const inScope = applied
    ? isOfferingInPromoScope(offering, applied)
    : voucherSlugs
      ? voucherSlugs.includes(offering.kind === "race" ? "race" : offering.slug)
      : false;
  const cardColor = offering.accentColor ?? accent;

  return (
    <CardShell
      href={href}
      paused={paused}
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-white/3 text-left transition-all duration-300 ${
        paused ? "" : "hover:bg-white/6"
      }`}
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

        {paused ? (
          <UnavailableCta note={pausedNote} />
        ) : (
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
        )}
      </div>

      {/* Bottom color bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: cardColor }} />
    </CardShell>
  );
}
