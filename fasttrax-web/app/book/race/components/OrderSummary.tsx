"use client";

import { useState, useEffect, useRef } from "react";
import type { ClassifiedProduct, BmiProposal, BmiBlock, PackSchedule } from "../data";
import { getAcknowledgements, calculateTax, calculateTotal, bmiGet, bmiPost } from "../data";
import { getBookingClientKey, getBookingLocation } from "@/lib/booking-location";
import { trackBookingReview } from "@/lib/analytics";
import type { PackageDefinition } from "@/lib/packages";
import { packagePerRacerPrice, LICENSE_PRICE, POV_PRICE, getPackageIgnoreFlag } from "@/lib/packages";
import type { ContactInfo } from "./ContactForm";
// PaymentForm + ClickwrapCheckbox removed — checkout handles payment via unified /book/checkout

// ── Types ────────────────────────────────────────────────────────────────────

/** Result from PackHeatPicker after all pack heats are booked */
export interface PackBookingResult {
  billId: string; // this is the orderId
  schedules: PackSchedule[];
  /** Number of racers the pack reserved seats for (matches the
   *  PackHeatPicker `quantity` prop). Single-racer packs are 1; the
   *  shared-heats multi-racer flow (party books one pack covering
   *  all racers) bumps this to N. Used by the POV / AddOns upsells
   *  on the next step so they default to the correct racer count
   *  — pack bookings live in `packResult` (NOT `bookings`) so the
   *  upsells previously read 0 racers for this path. */
  quantity: number;
}

export interface BookingItem {
  product: ClassifiedProduct;
  quantity: number;
  proposal: BmiProposal;
  block: BmiBlock;
  /** Real price from availability proposal (includes day/time pricing) */
  blockPrice?: number;
  /** Racer names assigned to this heat (returning racer flow) */
  racerNames?: string[];
  /** Source package id for bookings that came from a package
   *  (Ultimate Qualifier / Rookie Pack). Lets the review hero
   *  group bookings into one card per package. Undefined for
   *  individual race bookings. Mirrors the shape on `Booking` in
   *  page.tsx. */
  packageId?: string;
}

/** One bill per racer (returning flow) or one bill for the group (new flow) */
interface RacerBill {
  billId: string;
  personId?: string;
  racerName: string;
  category: "adult" | "junior";
}

interface OrderSummaryProps {
  /** All bookings (already booked — races held at heat selection) */
  bookings: BookingItem[];
  date: string;
  contact: ContactInfo | null;
  onBack: () => void;
  /** Primary bill ID (first bill — used for add-ons/POV) */
  billId: string;
  /** All bills — one per racer for returning flow, or one for group */
  bills: RacerBill[];
  /** For pack bookings -- order was already created during heat selection */
  packResult?: PackBookingResult;
  /** The pack product that was selected */
  packProduct?: ClassifiedProduct;
  /** Verified returning racer's BMI person ID (primary) */
  personId?: string;
  /** All verified racers in the party (for registerProjectPerson on single bill) */
  verifiedRacers?: { personId: string; fullName: string }[];
  /** Callback to remove a booking item — goes back to heat selection */
  onRemoveBooking?: (index: number) => void;
  /**
   * Callback to remove the entire pack (all 3 heats + cancel the bill).
   * Parent cancels the active bill, clears packResult, and returns to
   * the product picker so the guest can change their mind without
   * going all the way back via "Start over".
   */
  onRemovePack?: () => void | Promise<void>;
  /** Selected add-on activities */
  addOns?: { id: string; name: string; price: number; quantity: number; perPerson: boolean; proposal?: unknown; block?: unknown; selectedTime?: string }[];
  /** Selected POV cameras. `rookiePack` is true when the new-racer
   *  picked the bundle in PovUpsell — written to the booking record
   *  so the confirmation page can show the appetizer code card. */
  pov?: { id: string; quantity: number; price: number; rookiePack?: boolean } | null;
  /** Callback to remove an add-on by its index in the addOns array */
  onRemoveAddOn?: (index: number) => void;
  /** Callback to remove POV */
  onRemovePov?: () => void;
  /** Cancel the Rookie Pack from the review screen — removes POV
   *  AND navigates back to the PovUpsell step so the user can pick
   *  License-only or re-add the bundle. Distinct from `onRemovePov`
   *  which is the inline X on a non-bundle POV row (no navigation). */
  onCancelRookiePack?: () => void;
  /** Currently-selected centralized package definition (Ultimate
   *  Qualifier etc.). When set with `races.length > 0` the review
   *  shows a package hero card and writes the `package` /
   *  `packageHeats` fields onto the booking record so future
   *  automation (qualifier-detection cron, e-ticket flow) can react. */
  selectedPackage?: PackageDefinition | null;
  /** Atomic teardown — cancel all package bookings and bounce back
   *  to the product picker. Mirrors `onCancelRookiePack` but for
   *  packages that own their races. */
  /** Tear down a single package round. When called with a
   *  `packageId`, only that package's bookings are cancelled — the
   *  other category's package stays put. When called without an
   *  arg, full teardown (legacy behavior for the in-flight first
   *  round). The hero card always passes its own packageId. */
  onRemovePackage?: (packageId?: string) => void | Promise<void>;
  /** Override confirmation page path (default: /book/race/confirmation) */
  confirmationPath?: string;
}

type BookingState =
  | { status: "idle" }
  | { status: "booking" }
  | { status: "booked"; orderId: string; isCreditOrder: boolean; cashOwed: number; creditApplied: number; bmiTotal: number; bmiSubtotal: number; bmiTax: number; bmiLines: { name: string; quantity: number; amount: number; racers?: string[]; time?: string; lineId?: string; productGroup?: string }[] }
  | { status: "error"; message: string };

// ── Helpers ──────────────────────────────────────────────────────────────────


function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string) {
  const dateOnly = dateStr.split("T")[0];
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Component ────────────────────────────────────────────────────────────────

export default function OrderSummary({
  bookings,
  date,
  contact,
  onBack,
  billId,
  bills,
  packResult,
  packProduct,
  personId,
  verifiedRacers = [],
  onRemoveBooking,
  onRemovePack,
  addOns = [],
  pov,
  onRemoveAddOn,
  onRemovePov,
  onCancelRookiePack,
  selectedPackage,
  onRemovePackage,
}: OrderSummaryProps) {
  const [removingPack, setRemovingPack] = useState(false);
  const [state, setState] = useState<BookingState>({ status: "idle" });
  const effectRan = useRef(false);

  // Computed pricing — prefer real block price from availability over catalog price
  const isPack = !!packResult;
  const subtotal = isPack && packProduct
    ? packProduct.price
    : bookings.reduce((sum, b) => sum + (b.blockPrice ?? b.product.price) * b.quantity, 0);
  const tax = calculateTax(subtotal);
  const total = calculateTotal(subtotal);

  // Auto-start booking process when component mounts
  // React strict mode guard: track across mount/unmount/remount cycle
  useEffect(() => {
    if (effectRan.current) return;
    effectRan.current = true;
    runBookingFlow();
    return () => {
      // In strict mode, this cleanup runs before remount.
      // Do NOT reset effectRan — we want to prevent double booking.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBookingFlow() {
    trackBookingReview();
    console.log("[runBookingFlow] STARTED — bills:", JSON.stringify(bills.map(b => ({ billId: b.billId, personId: b.personId, racer: b.racerName }))));
    setState({ status: "booking" });
    try {
      // Contact registration moved to unified checkout (/book/checkout)
      const ck = getBookingClientKey();

      // Get overview for each bill and combine totals
      let bmiTotal = 0;
      let bmiSubtotal = 0;
      let bmiTax = 0;
      const bmiLines: { name: string; quantity: number; amount: number; racers?: string[]; time?: string; lineId?: string; productGroup?: string }[] = [];
      let isCreditOrder = true; // assume credit until proven otherwise
      let cashOwed = 0;
      let creditApplied = 0;

      for (const bill of bills) {
        try {
          const overviewRes = await fetch(`/api/sms?endpoint=bill%2Foverview&billId=${bill.billId}${ck ? `&clientKey=${ck}` : ""}`);
          const overview = await overviewRes.json();

          const cashTotal = overview.total?.find((t: { depositKind: number }) => t.depositKind === 0);
          // Sum ALL credit entries (BMI may return multiple credit types as separate dk=2 entries)
          const creditTotals = (overview.total || []).filter((t: { depositKind: number }) => t.depositKind === 2);
          const cashSub = overview.subTotal?.find((t: { depositKind: number }) => t.depositKind === 0);
          const cashTax = overview.totalTax?.find((t: { depositKind: number }) => t.depositKind === 0);

          if (cashTotal) { bmiTotal += cashTotal.amount; cashOwed += cashTotal.amount; isCreditOrder = false; }
          if (cashSub) bmiSubtotal += cashSub.amount;
          if (cashTax) bmiTax += cashTax.amount;
          for (const ct of creditTotals) creditApplied += Math.abs(ct.amount);

          // Extract line items with racer name and scheduled time
          // Build racer name queue from bookings (lines are in booking order)
          const racerQueue: string[] = [];
          for (const b of bookings) {
            if (b.racerNames) {
              for (const name of b.racerNames) racerQueue.push(name);
            }
          }
          let racerIdx = 0;
          if (overview.lines) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const l of overview.lines as any[]) {
              // Skip BMI's auto-added membership license (kind=3, productId 11253570)
              // This is NOT our intentional license sell (productId 43473520, kind=1)
              // BMI auto-adds this for membersOnly races — subtract from totals
              if (l.kind === 3 && String(l.productId) === "11253570") {
                const memPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0)?.amount ?? 0;
                const memTax = l.totalTax ?? 0;
                bmiTotal -= (memPrice + memTax);
                bmiSubtotal -= memPrice;
                bmiTax -= memTax;
                cashOwed -= (memPrice + memTax);
                console.log("[bill overview] skipping BMI auto-added membership:", l.name, "subtracted:", memPrice + memTax);
                continue;
              }
              const cashPrice = l.totalPrice?.find((p: { depositKind: number }) => p.depositKind === 0);
              const lineTime = l.scheduledTime?.start || l.schedules?.[0]?.start;
              // Consume `quantity` racer names from the queue (BMI groups into one line with qty>1)
              const lineRacers: string[] = [];
              for (let q = 0; q < (l.quantity || 1); q++) {
                if (racerQueue[racerIdx]) lineRacers.push(racerQueue[racerIdx]);
                racerIdx++;
              }
              bmiLines.push({ name: l.name, quantity: l.quantity, amount: cashPrice?.amount ?? 0, racers: lineRacers.length > 0 ? lineRacers : undefined, time: lineTime || undefined, lineId: l.id ? String(l.id) : undefined, productGroup: l.productGroup || undefined });
            }
          }
        } catch {
          // Fallback for this bill
          bmiLines.push({ name: "Race", quantity: 1, amount: 0, racers: [bill.racerName] });
        }
      }

      // If all bills are credit-covered
      if (isCreditOrder && cashOwed === 0 && creditApplied > 0) {
        bmiTotal = 0;
      } else {
        isCreditOrder = false;
      }

      setState({ status: "booked", orderId: billId, isCreditOrder, cashOwed, creditApplied, bmiTotal, bmiSubtotal, bmiTax, bmiLines });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }

  /** Navigate to unified checkout page — payment happens there */
  function handleContinueToCheckout() {
    if (state.status !== "booked") return;
    // Racing items are already in sessionStorage (attractionOrderId + attractionCart)
    // Checkout page reads them automatically.
    window.location.href = "/book/checkout";
  }

  // ── Loading state ──────────────────────────────────────────────────────────

  if (state.status === "booking") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin" />
        <p className="text-white/60 text-sm">
          Reserving your heat{bookings.length > 1 ? "s" : ""}...
        </p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (state.status === "error") {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center gap-4 max-w-md mx-auto text-center">
        <div className="text-4xl">!</div>
        <p className="text-white font-bold text-lg">Booking Failed</p>
        <p className="text-red-400 text-sm">{state.message}</p>
        <button
          onClick={onBack}
          className="mt-2 text-sm text-white/50 hover:text-white underline"
        >
          Go back and try again
        </button>
      </div>
    );
  }

  // Payment form removed — handled by unified /book/checkout

  // ── Main UI ────────────────────────────────────────────────────────────────

  const isBooked = state.status === "booked";

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          {isBooked ? "Review Your Order" : "Preparing Order..."}
        </h2>
        {isBooked && (
          <p className="text-white/50 text-sm">
            Your heat{bookings.length > 1 ? "s are" : " is"} reserved. Continue to checkout or add more items.
          </p>
        )}
      </div>

      {/* Pack booking — special layout */}
      {isPack && packResult && packProduct && (
        <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/[0.08]">
          <div className="p-4 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                  {packResult.schedules.length}-Race Pack
                </span>
              </div>
              <p className="text-white font-bold">{packProduct.name}</p>
            </div>
            {onRemovePack && (
              <button
                type="button"
                disabled={removingPack}
                onClick={async () => {
                  if (removingPack) return;
                  if (!window.confirm(
                    `Remove the ${packResult.schedules.length}-race pack? ` +
                    `All ${packResult.schedules.length} reserved heats will be cancelled.`,
                  )) return;
                  setRemovingPack(true);
                  try { await onRemovePack(); } finally { setRemovingPack(false); }
                }}
                className="shrink-0 text-xs font-semibold text-red-400/80 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 rounded-full px-3 py-1.5 transition-colors disabled:opacity-50 cursor-pointer"
                aria-label="Remove this 3-race pack"
              >
                {removingPack ? "Removing..." : "Remove pack"}
              </button>
            )}
          </div>
          {packResult.schedules.map((s, i) => (
            <div key={i} className="p-4 flex justify-between items-center">
              <div>
                <p className="text-white/40 text-xs mb-0.5">
                  Race {i + 1}
                  {s.trackName ? ` -- ${s.trackName} Track` : ""}
                </p>
                <p className="text-white text-sm font-medium">
                  {formatTime(s.start)} - {formatTime(s.stop)}
                </p>
              </div>
              <p className="text-white/30 text-xs">{s.name}</p>
            </div>
          ))}
          <div className="p-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-white/40 text-xs mb-1">Date</p>
              <p className="text-white text-sm">{formatDate(date)}</p>
            </div>
            <div>
              <p className="text-white/40 text-xs mb-1">Contact</p>
              {contact ? (
                <>
                  <p className="text-white text-sm">
                    {contact.firstName} {contact.lastName}
                  </p>
                  <p className="text-white/50 text-xs">{contact.email}</p>
                </>
              ) : (
                <p className="text-white/50 text-xs">Collected at checkout</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Contact + date bar */}
      {!isPack && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 flex items-center justify-between text-sm">
          <div>
            {contact ? (
              <>
                <span className="text-white font-semibold">{contact.firstName} {contact.lastName}</span>
                <span className="text-white/30 mx-2">&middot;</span>
                <span className="text-white/50">{contact.email}</span>
              </>
            ) : (
              <span className="text-white/50">Contact info collected at checkout</span>
            )}
          </div>
          {date && <span className="text-white/40 text-xs">{formatDate(date)}</span>}
        </div>
      )}

      {/* All items — races + add-ons merged, sorted by time, compact rows */}
      {!isPack && (() => {
        type CardItem =
          | { type: "package"; packageId: string; time: string }
          | { type: "race"; time: string; bookingIdx: number }
          | { type: "pov" }
          | { type: "addon"; addOnIdx: number; time: string };

        // Group bookings by packageId so a mixed adult+junior
        // package flow renders ONE hero card per package round
        // (was a single card driven off `selectedPackage`, which
        // could only hold one package at a time and dropped the
        // first round on the floor).
        const packageBuckets = new Map<string, BookingItem[]>();
        const looseBookings: BookingItem[] = [];
        bookings.forEach((b) => {
          if (b.packageId) {
            const list = packageBuckets.get(b.packageId) ?? [];
            list.push(b);
            packageBuckets.set(b.packageId, list);
          } else {
            looseBookings.push(b);
          }
        });

        // Back-compat: when there are NO packageId-tagged bookings
        // but `selectedPackage` is set (mid-flow first round), still
        // render that as a package card. Same behavior as before
        // for the single-package path.
        const fallbackToSelectedPackage =
          packageBuckets.size === 0 && !!(selectedPackage && selectedPackage.races.length > 0);
        const anyPackage = packageBuckets.size > 0 || fallbackToSelectedPackage;

        const cards: CardItem[] = [];
        for (const [packageId, pkgBookings] of packageBuckets) {
          const earliest = pkgBookings.map((b) => b.block.start).sort()[0] || "";
          cards.push({ type: "package", packageId, time: earliest });
        }
        if (fallbackToSelectedPackage && selectedPackage) {
          cards.push({ type: "package", packageId: selectedPackage.id, time: bookings[0]?.block.start || "" });
        }
        // Race cards ONLY for bookings that aren't part of a package
        // round — package cards already roll up their own race lines.
        looseBookings.forEach((b) => {
          const idx = bookings.indexOf(b);
          if (idx >= 0) cards.push({ type: "race", time: b.block.start, bookingIdx: idx });
        });
        // POV row stays for the non-package POV-only path. When ANY
        // package is active the bundle line owns the POV display.
        if (!anyPackage && pov && pov.quantity > 0) cards.push({ type: "pov" });
        addOns.forEach((a, i) => { if (a.quantity > 0) cards.push({ type: "addon", addOnIdx: i, time: a.selectedTime || "" }); });

        cards.sort((a, b) => {
          const tA =
            a.type === "race" ? a.time
            : a.type === "addon" ? a.time
            : a.type === "package" ? a.time
            : "";
          const tB =
            b.type === "race" ? b.time
            : b.type === "addon" ? b.time
            : b.type === "package" ? b.time
            : "";
          if (!tA && !tB) return 0;
          if (!tA) return 1;
          if (!tB) return -1;
          return tA.localeCompare(tB);
        });

        const xBtn = (onClick: () => void) => (
          <button type="button" aria-label="Remove item" onClick={onClick} className="text-red-400/40 hover:text-red-400 transition-colors p-0.5 -mr-1 shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        );

        return (
          <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/[0.06]">
            {cards.map((card) => {
              if (card.type === "package") {
                // Resolve the package from the registry by its id.
                // Falls back to `selectedPackage` for the in-flight
                // case (no packageId-tagged bookings yet but mid-flow
                // first round).
                const cardPkg =
                  getPackageIgnoreFlag(card.packageId) ??
                  (selectedPackage && selectedPackage.id === card.packageId ? selectedPackage : null);
                if (!cardPkg) return null;
                // Bookings belonging to THIS package round.
                const ownBookings = bookings.filter((b) => b.packageId === card.packageId);
                const isFallback =
                  ownBookings.length === 0 &&
                  selectedPackage?.id === card.packageId;
                const sourceBookings = isFallback ? bookings : ownBookings;
                // Racer count = per-booking quantity (all heats in
                // the all-share-heats pattern reserve the same N).
                const racers = sourceBookings[0]?.quantity || 1;
                const heatLabels = sourceBookings
                  .map((b) => `${b.product.name} · ${formatTime(b.block.start)}`)
                  .join(" → ");
                // Disambiguate when multiple packages of the same
                // NAME are booked (adult + junior Ultimate Qualifier
                // share a name across two registry entries).
                const displayName =
                  cardPkg.category === "junior" && bookings.some((b) => b.packageId !== card.packageId && getPackageIgnoreFlag(b.packageId)?.name === cardPkg.name)
                    ? `${cardPkg.name} (Junior)`
                    : cardPkg.name;
                // Hero card lists what's included; per-line dollars
                // are intentionally NOT shown. The BMI bill summary
                // below this card is the authoritative price total —
                // showing component math here would duplicate (and
                // potentially contradict) BMI's actual charge if
                // their catalog price drifts from the registry.
                return (
                  <div key={`package-${card.packageId}`} className="px-4 py-4 bg-amber-500/[0.06]">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-amber-400 text-[10px] font-bold uppercase tracking-widest shrink-0">
                            {displayName}
                          </span>
                          <span className="text-white/20 text-xs shrink-0">
                            {racers} racer{racers === 1 ? "" : "s"}
                          </span>
                        </div>
                        <p className="text-white/70 text-xs">{cardPkg.shortDescription}</p>
                      </div>
                      {/* Remove this specific package round. Passes
                          the card's own packageId so multi-package
                          flows (adult + junior) can drop one side
                          without nuking the other. The handler
                          (`handleRemovePackage` in page.tsx) cancels
                          the matching bookings on the BMI bill and
                          bounces the user back to the picker scoped
                          to that category. */}
                      {onRemovePackage && state.status === "booked" && (
                        <button
                          type="button"
                          aria-label={`Cancel ${cardPkg.name} and pick a different option`}
                          onClick={() => { void onRemovePackage(card.packageId); }}
                          className="text-red-400/40 hover:text-red-400 transition-colors p-0.5 -mr-1 shrink-0"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {heatLabels && (
                      <p className="text-white/50 text-[11px] mb-2">{heatLabels}</p>
                    )}
                    <ul className="space-y-1 text-xs text-white/70">
                      {cardPkg.races.map((r) => (
                        <li key={r.ref} className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> {r.label}{racers > 1 ? <span className="text-white/40"> × {racers}</span> : null}</span>
                          <span className="text-emerald-300/80 font-semibold text-[11px] uppercase tracking-wider">Included</span>
                        </li>
                      ))}
                      {cardPkg.includesLicense && (
                        <li className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> Racing License{racers > 1 ? <span className="text-white/40"> × {racers}</span> : null}</span>
                          <span className="text-emerald-300/80 font-semibold text-[11px] uppercase tracking-wider">Included</span>
                        </li>
                      )}
                      {cardPkg.includesPov && (
                        <li className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> POV Race Video{racers > 1 ? <span className="text-white/40"> × {racers}</span> : null}</span>
                          <span className="text-emerald-300/80 font-semibold text-[11px] uppercase tracking-wider">Included</span>
                        </li>
                      )}
                      {cardPkg.appetizerCode && (
                        <li className="flex items-baseline justify-between gap-2">
                          <span>
                            <span className="text-emerald-400">✓</span> Free Appetizer at Nemo&apos;s
                            <span className="text-white/40"> (1 per group · race day only)</span>
                          </span>
                          <span className="text-emerald-300 font-semibold text-[11px] uppercase tracking-wider">Included</span>
                        </li>
                      )}
                    </ul>
                  </div>
                );
              }

              if (card.type === "race") {
                const b = bookings[card.bookingIdx];
                return (
                  <div key={`race-${card.bookingIdx}`} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-semibold text-sm truncate">{b.product.name}</span>
                        <span className="text-white/20 text-xs shrink-0">x{b.quantity}</span>
                      </div>
                      <p className="text-white/40 text-xs mt-0.5">
                        {b.block.name} &middot; {formatTime(b.block.start)}
                      </p>
                      {b.racerNames && b.racerNames.length > 0 && (
                        <p className="text-[#00E2E5]/60 text-xs mt-0.5">
                          {b.racerNames.join(", ")}
                        </p>
                      )}
                    </div>
                    {onRemoveBooking && (bookings.length > 1 || b.quantity > 1) && state.status === "booked" && xBtn(() => onRemoveBooking(card.bookingIdx))}
                  </div>
                );
              }

              if (card.type === "pov") {
                // Rookie Pack hero card — replaces the plain POV row
                // when the customer picked the bundle in PovUpsell.
                // Shows the bundle value framing on the review screen
                // even though the BMI bill below still lists each
                // SKU individually (license + POV separate lines).
                if (pov!.rookiePack) {
                  const racers = pov!.quantity;
                  const licensePerRacer = 4.99;
                  const povPerRacer = pov!.price;
                  const povAtCheckin = 7;
                  const appRetail = 10;
                  const totalCharged = (licensePerRacer + povPerRacer) * racers;
                  const wouldHavePaid = (licensePerRacer + povAtCheckin) * racers + appRetail;
                  const youSave = wouldHavePaid - totalCharged;
                  return (
                    <div key="pov" className="px-4 py-4 bg-amber-500/[0.06]">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-amber-400 text-[10px] font-bold uppercase tracking-widest shrink-0">Rookie Pack</span>
                            <span className="text-white/20 text-xs shrink-0">{racers} racer{racers === 1 ? "" : "s"}</span>
                          </div>
                          <p className="text-white/70 text-xs">License + POV Video + Free Appetizer</p>
                        </div>
                        {onCancelRookiePack && state.status === "booked" && (
                          <button
                            type="button"
                            aria-label="Cancel Rookie Pack and pick a different option"
                            onClick={onCancelRookiePack}
                            className="text-red-400/40 hover:text-red-400 transition-colors p-0.5 -mr-1 shrink-0"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <ul className="space-y-1 text-xs text-white/70 mb-2">
                        <li className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> Racing License × {racers}</span>
                          <span className="text-white/50">${(licensePerRacer * racers).toFixed(2)}</span>
                        </li>
                        <li className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> POV Race Video × {racers}</span>
                          <span className="text-white/50">${(povPerRacer * racers).toFixed(2)}</span>
                        </li>
                        <li className="flex items-baseline justify-between gap-2">
                          <span><span className="text-emerald-400">✓</span> Free Appetizer at Nemo&apos;s <span className="text-white/40">(1 per group · race day only)</span></span>
                          <span className="text-emerald-300 font-semibold">FREE</span>
                        </li>
                      </ul>
                      <div className="flex items-baseline justify-between text-xs pt-2 border-t border-white/[0.06]">
                        <span className="text-amber-400 font-bold">💰 You save ${youSave.toFixed(2)}</span>
                        <span className="text-white/40 line-through">${wouldHavePaid.toFixed(2)}</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key="pov" className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider shrink-0">Add-On</span>
                        <span className="text-white font-semibold text-sm truncate">POV Video</span>
                        <span className="text-white/20 text-xs shrink-0">x{pov!.quantity}</span>
                      </div>
                      <p className="text-[#00E2E5]/60 text-xs mt-0.5">${(pov!.price * pov!.quantity).toFixed(2)}</p>
                    </div>
                    {onRemovePov && state.status === "booked" && xBtn(() => onRemovePov())}
                  </div>
                );
              }

              if (card.type !== "addon") return null; // narrow for TS — package/race/pov already handled above
              const a = addOns[card.addOnIdx];
              return (
                <div key={`addon-${a.id}`} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[#00E2E5] text-xs font-bold uppercase tracking-wider shrink-0">Add-On</span>
                      <span className="text-white font-semibold text-sm truncate">{a.name}</span>
                      {a.quantity > 1 && <span className="text-white/20 text-xs shrink-0">x{a.quantity}</span>}
                    </div>
                    <p className="text-white/40 text-xs mt-0.5">
                      {a.selectedTime ? formatTime(a.selectedTime) : (a.perPerson ? `${a.quantity} ${a.quantity === 1 ? "person" : "people"}` : "")}
                      <span className="text-[#00E2E5]/60 ml-2">${(a.price * a.quantity).toFixed(2)}</span>
                    </p>
                  </div>
                  {onRemoveAddOn && state.status === "booked" && xBtn(() => onRemoveAddOn(card.addOnIdx))}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Price breakdown — from BMI bill */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
        {state.status === "booked" ? (
          <>
            {state.bmiLines.map((line, i) => {
              const isLicense = line.name.toLowerCase().includes("license");
              const isRace = line.productGroup === "Karting";
              const isPov = line.name.toLowerCase().includes("pov");
              // When the Rookie Pack OR a package hero card is showing
              // above, license + POV (and the package races for
              // owned-races packages) are already represented there.
              // Hide them here so customers don't see them twice.
              // Subtotal / tax / total below still reflect the full
              // bill.
              // Hide license/POV/race rows whenever ANY package
              // round has booked — bookings tagged with `packageId`
              // are represented by the hero card(s) above. Was a
              // single `selectedPackage` check that missed booked-
              // package rounds (the second-round flow).
              const anyPackageRound =
                bookings.some((b) => !!b.packageId) ||
                !!(selectedPackage && selectedPackage.races.length > 0);
              if (pov?.rookiePack && (isLicense || isPov)) return null;
              if (anyPackageRound && (isLicense || isPov || isRace)) return null;
              // Removable: not a license, not a race (races removed via item cards above)
              const canRemove = !isLicense && !isRace && line.lineId && state.status === "booked";
              return (
                <div key={i}>
                  <div className="flex justify-between text-sm items-center">
                    <div className="text-white/60 flex-1">
                      <span>{line.name} x {line.quantity}</span>
                      {line.racers && line.racers.length > 0 && (
                        <span className="text-white/30 ml-1">({line.racers.join(", ")})</span>
                      )}
                      {line.time && <span className="text-white/30 ml-1">{formatTime(line.time)}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-white">{line.amount > 0 ? `$${line.amount.toFixed(2)}` : "Credit"}</span>
                      {canRemove && (
                        <button
                          type="button"
                          aria-label="Remove item"
                          onClick={async () => {
                            try {
                              await fetch(`/api/bmi?endpoint=booking%2FremoveItem${getBookingClientKey() ? `&clientKey=${getBookingClientKey()}` : ""}`, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: `{"orderId":${billId},"orderItemId":${line.lineId}}`,
                              });
                              // Reload the bill overview
                              window.location.reload();
                            } catch { /* non-fatal */ }
                          }}
                          className="text-red-400/40 hover:text-red-400 transition-colors p-0.5"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                  {isLicense && (
                    <p className="text-white/30 text-xs mt-0.5 ml-1">
                      One-year license includes use of head sock, helmet, and access to the FastTrax app for race scheduling.
                    </p>
                  )}
                </div>
              );
            })}

            <div className="border-t border-white/10 pt-2 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Subtotal</span>
                <span className="text-white">${state.bmiSubtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Tax</span>
                <span className="text-white">${state.bmiTax.toFixed(2)}</span>
              </div>
              <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                <span className="text-white">Total</span>
                <span className="text-[#00E2E5] text-lg">${state.bmiTotal.toFixed(2)}</span>
              </div>

              {state.creditApplied > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-green-400">Credits Applied</span>
                    <span className="text-green-400">-{state.creditApplied} credit{state.creditApplied !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="border-t border-white/10 pt-2 flex justify-between font-bold">
                    <span className="text-white">{state.cashOwed > 0 ? "Due Now" : "Amount Due"}</span>
                    <span className={`text-lg ${state.cashOwed > 0 ? "text-[#00E2E5]" : "text-green-400"}`}>
                      {state.cashOwed > 0 ? `$${state.cashOwed.toFixed(2)}` : "$0.00"}
                    </span>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="text-center text-white/30 text-sm py-2">Calculating...</div>
        )}
      </div>

      {/* Info notes */}
      {isBooked && (() => {
        const hasRacing = state.status === "booked" && state.bmiLines.some(l => l.productGroup === "Karting");
        const hasLicense = state.status === "booked" && state.bmiLines.some(l => l.name.toLowerCase().includes("license"));
        return (
        <>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 text-xs text-white/40 space-y-1">
            <p>
              &middot; Arrive{" "}
              <strong className="text-white/60">30 minutes early</strong> for
              check-in.
            </p>
            {hasRacing && !hasLicense && (
              <p>
                &middot; A{" "}
                <strong className="text-white/60">$4.99 license fee</strong> per
                driver applies at first check-in.
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={onBack}
              className="text-sm text-white/40 hover:text-white/70 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleContinueToCheckout}
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-bold text-base bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
            >
              Continue to Checkout →
            </button>
          </div>
          <div className="text-center">
            <button
              onClick={() => {
                if (!confirm("Cancel your entire booking? This will remove all items including any attraction reservations.")) return;
                // Cancel the bill
                fetch(`/api/bmi?endpoint=bill/${billId}/cancel${getBookingClientKey() ? `&clientKey=${getBookingClientKey()}` : ""}`, { method: "DELETE" }).catch(() => {});
                sessionStorage.removeItem("attractionOrderId");
                sessionStorage.removeItem("attractionCart");
                window.location.href = "/book";
              }}
              className="text-xs text-red-400/50 hover:text-red-400 transition-colors"
            >
              Cancel &amp; Start Over
            </button>
          </div>
        </>
        );
      })()}
    </div>
  );
}
