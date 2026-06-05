"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  AttractionItem,
  BookingSession,
  PartyMember,
  RaceHeatAssignment,
  RaceItem,
  SessionItem,
} from "~/features/booking";
import { findOffering } from "~/features/booking";
import { ATTRACTIONS, resolveAttractionContext } from "~/features/booking/service/attractions";
import { getRaceProductById, type RaceProduct } from "~/features/booking/service/race-products";
import { LICENSE_PRICE, POV_PRICE } from "~/features/booking/service/race-pricing";
import { getPackage, packageBundleTotal } from "~/features/booking/service/packages";
import { modalBackdropProps } from "@/lib/a11y";
import { AdditionalActivities } from "./AdditionalActivities";

/**
 * Session-level cart view.
 *
 * Renders the customer's current items, the AdditionalActivities cross-sell,
 * and a Checkout CTA. Race items get a structured preview pulled from
 * RaceItem state (product registry name + chosen track + per-heat racer
 * assignments + estimated total) so the customer can verify what's in their
 * cart before paying — replaces the generic "High-Speed Electric Racing"
 * placeholder that just read offering displayName.
 *
 * The "All activities" link kills the in-memory session, so it gates on a
 * confirmation modal when the cart has items.
 */
export interface CartViewProps {
  session: BookingSession;
  urlCode?: string | null;
  onEditItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onCheckout: () => void;
}

export function CartView({
  session,
  urlCode,
  onEditItem,
  onRemoveItem,
  onCheckout,
}: CartViewProps) {
  // Back-to-landing prefers the validated `appliedPromo.code` (set when the
  // code resolved + matched scope), falls back to the raw `?code=` from
  // the URL so a wrong-domain attempt still travels back to the landing.
  const backCode = session.appliedPromo?.code ?? urlCode ?? null;
  const backToLandingHref = backCode ? `/book/v2?code=${encodeURIComponent(backCode)}` : "/book/v2";

  const hasItems = session.items.length > 0;
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="mb-4">
        {hasItems ? (
          <button
            type="button"
            onClick={() => setLeaveConfirm(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            ← All activities
          </button>
        ) : (
          <Link
            href={backToLandingHref}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
          >
            ← All activities
          </Link>
        )}
      </div>
      <h1 className="text-2xl font-semibold text-white sm:text-3xl">Your cart</h1>

      {session.items.length === 0 ? (
        <p className="mt-6 text-sm text-white/50">No items yet.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {session.items.map((item) => (
            <CartItemCard
              key={item.id}
              item={item}
              session={session}
              onEdit={() => onEditItem(item.id)}
              onRemove={() => onRemoveItem(item.id)}
            />
          ))}
        </ul>
      )}

      <AdditionalActivities session={session} />

      {hasItems && (
        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={onCheckout}
            disabled={!allItemsReady(session)}
            title={
              !allItemsReady(session) ? "Finish configuring all items before checkout" : undefined
            }
            className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Checkout →
          </button>
        </div>
      )}

      {leaveConfirm && (
        <LeaveConfirmModal backHref={backToLandingHref} onCancel={() => setLeaveConfirm(false)} />
      )}
    </section>
  );
}

/**
 * Leave-confirmation modal — shown before navigating to the landing page
 * when the cart has items. Without this, customers who click "All activities"
 * lose their in-progress booking because session state is in-memory React.
 */
export function LeaveConfirmModal({
  backHref,
  onCancel,
}: {
  backHref: string;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      {...modalBackdropProps(onCancel)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-6"
        style={{ backgroundColor: "#0a1128" }}
      >
        <h3 className="font-display text-xl tracking-widest text-white uppercase">
          Leave your booking?
        </h3>
        <p className="mt-2 text-sm text-white/60">
          Your progress is saved. You can come back to finish your booking.
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/40 hover:text-white"
          >
            Stay
          </button>
          <Link
            href={backHref}
            className="flex-1 rounded-xl bg-amber-400/90 px-4 py-2.5 text-center text-sm font-bold text-[#010A20] transition-colors hover:bg-amber-300"
          >
            Leave anyway
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Per-item cards ─────────────────────────────────────────────────────────

function CartItemCard({
  item,
  session,
  onEdit,
  onRemove,
}: {
  item: SessionItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
}) {
  if (item.kind === "race") {
    return <RaceCartCard item={item} session={session} onEdit={onEdit} onRemove={onRemove} />;
  }
  if (item.kind === "attraction") {
    return <AttractionCartCard item={item} session={session} onEdit={onEdit} onRemove={onRemove} />;
  }
  return (
    <li className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4 text-sm transition-colors hover:border-white/20">
      <div>
        <div className="font-semibold text-white">{otherItemTitle(item)}</div>
        <div className="mt-0.5 text-xs text-white/40">{otherItemSummary(item)}</div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function RaceCartCard({
  item,
  session,
  onEdit,
  onRemove,
}: {
  item: RaceItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const pkg = item.packageId ? getPackage(item.packageId) : null;
  const adultProduct = item.productIdAdult ? getRaceProductById(item.productIdAdult) : null;
  const juniorProduct = item.productIdJunior ? getRaceProductById(item.productIdJunior) : null;

  // Heat groups by category (so we can label heats clearly when both
  // adult + junior categories are in play).
  const adultProductIds = new Set(
    adultProduct
      ? Object.values(adultProduct.trackProducts ?? {})
          .map((t) => t.productId)
          .concat([adultProduct.productId])
      : item.productIdAdult
        ? [item.productIdAdult]
        : [],
  );
  const juniorProductIds = new Set(
    juniorProduct
      ? Object.values(juniorProduct.trackProducts ?? {})
          .map((t) => t.productId)
          .concat([juniorProduct.productId])
      : item.productIdJunior
        ? [item.productIdJunior]
        : [],
  );

  const adultHeats = item.heats.filter((h) => h.productId && adultProductIds.has(h.productId));
  const juniorHeats = item.heats.filter((h) => h.productId && juniorProductIds.has(h.productId));

  const dateLabel = item.date
    ? new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  // Estimate — package bundles their own pricing; individual races sum components
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  const racerCount = session.party.length;
  let estimated: number;
  if (pkg) {
    estimated =
      packageBundleTotal(pkg, racerCount) +
      item.addons.reduce((sum, a) => sum + estimateAddon(a), 0);
  } else {
    const adultRacerCount = session.party.filter((m) => (m.category ?? "adult") === "adult").length;
    const juniorRacerCount = session.party.filter((m) => m.category === "junior").length;
    const racesTotal =
      (adultProduct?.price ?? 0) *
        Math.max(1, adultProduct?.raceCount ?? 1) *
        Math.max(1, adultRacerCount) +
      (juniorProduct?.price ?? 0) *
        Math.max(1, juniorProduct?.raceCount ?? 1) *
        Math.max(1, juniorRacerCount);
    const licenseTotal = LICENSE_PRICE * newRacerCount;
    const povTotal = POV_PRICE * item.povQuantity;
    const addonsTotal = item.addons.reduce((sum, a) => sum + estimateAddon(a), 0);
    estimated = racesTotal + licenseTotal + povTotal + addonsTotal;
  }

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
      {/* Header: race title + edit/remove */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white">
            {pkg ? pkg.name : raceTitle(item, adultProduct, juniorProduct)}
          </h3>
          {dateLabel && <p className="mt-0.5 text-xs text-white/50">{dateLabel}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Heats — package shows all heats; individual races group by category */}
      {pkg && item.heats.length > 0 ? (
        <div className="mt-3 space-y-2">
          <HeatGroup label="Heats" heats={item.heats} party={session.party} accent="cyan" />
        </div>
      ) : adultHeats.length > 0 || juniorHeats.length > 0 ? (
        <div className="mt-3 space-y-2">
          {adultHeats.length > 0 && (
            <HeatGroup
              label={juniorHeats.length > 0 ? "Adult heats" : "Heats"}
              heats={adultHeats}
              party={session.party}
              accent="cyan"
            />
          )}
          {juniorHeats.length > 0 && (
            <HeatGroup
              label={adultHeats.length > 0 ? "Junior heats" : "Heats"}
              heats={juniorHeats}
              party={session.party}
              accent="amber"
            />
          )}
        </div>
      ) : null}

      {/* Extras */}
      {pkg ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {pkg.includesLicense && (
            <ExtraRow icon="✓" label="Racing License included" amount={null} />
          )}
          {pkg.includesPov && <ExtraRow icon="✓" label="POV Race Video included" amount={null} />}
          {pkg.appetizerCode && (
            <>
              <ExtraRow
                icon="✓"
                label={`Free Appetizer at Nemo's (${pkg.appetizerNote ?? "1 per group"})`}
                amount={null}
              />
              {pkg.appetizerItems && (
                <div className="ml-6 space-y-0 text-[11px] text-white/40">
                  {pkg.appetizerItems.map((mi) => (
                    <div key={mi}>· {mi}</div>
                  ))}
                </div>
              )}
            </>
          )}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
        </div>
      ) : item.povQuantity > 0 || item.rookiePack === true || item.addons.length > 0 ? (
        <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs">
          {item.rookiePack === true && (
            <ExtraRow icon="🎁" label={`Rookie Pack × ${newRacerCount}`} amount={null} />
          )}
          {item.povQuantity > 0 && !item.rookiePack && (
            <ExtraRow
              icon="🎥"
              label={`POV Camera × ${item.povQuantity}`}
              amount={POV_PRICE * item.povQuantity}
            />
          )}
          {item.addons.map((a) => (
            <ExtraRow key={a.id} icon="➕" label={addonLabel(a)} amount={estimateAddon(a)} />
          ))}
        </div>
      ) : null}

      {/* Estimated total */}
      {estimated > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-xs uppercase tracking-wider text-white/40">Est. total</span>
          <span className="font-bold text-[#00E2E5]">${estimated.toFixed(2)}</span>
        </div>
      )}

      {/* Empty-state nudge: race added but nothing picked yet */}
      {!adultProduct && !juniorProduct && item.heats.length === 0 && (
        <p className="mt-3 text-xs text-amber-300/80">
          Click <strong>Edit</strong> to pick your race details.
        </p>
      )}
    </li>
  );
}

function AttractionCartCard({
  item,
  session,
  onEdit,
  onRemove,
}: {
  item: AttractionItem;
  session: BookingSession;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const ctx = item.slug ? resolveAttractionContext(item.slug, session) : null;
  const config = item.slug ? ATTRACTIONS[item.slug] : null;
  const isPerPerson = config?.bookingMode === "per-person";

  const product = config?.products.find((p) => p.productId === item.productId);
  const title = product?.name ?? findOffering(item.slug ?? "")?.displayName ?? "Attraction";
  const accentColor = config?.color ?? "#00E2E5";

  const dateLabel = item.date
    ? new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  const timeLabel = item.slot
    ? new Date(item.slot.replace(/Z$/, "")).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : null;

  const total = isPerPerson ? item.price * item.qty : item.price;

  return (
    <li className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-white/50">
            {dateLabel && <span>{dateLabel}</span>}
            {dateLabel && timeLabel && <span className="text-white/20">·</span>}
            {timeLabel && <span>{timeLabel}</span>}
            {isPerPerson && item.qty > 1 && (
              <>
                <span className="text-white/20">·</span>
                <span>{item.qty} people</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            Remove
          </button>
        </div>
      </div>

      {total > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
          <span className="text-xs uppercase tracking-wider text-white/40">Est. total</span>
          <span className="font-bold" style={{ color: accentColor }}>
            ${total.toFixed(2)}
          </span>
        </div>
      )}

      {!item.productId && (
        <p className="mt-3 text-xs text-amber-300/80">
          Click <strong>Edit</strong> to pick your activity details.
        </p>
      )}
    </li>
  );
}

function HeatGroup({
  label,
  heats,
  party,
  accent,
}: {
  label: string;
  heats: RaceHeatAssignment[];
  party: PartyMember[];
  accent: "cyan" | "amber";
}) {
  // Dedup heats by heatId (state stores one entry per racer × heat).
  const byHeat = new Map<string, RaceHeatAssignment[]>();
  for (const h of heats) {
    if (!h.heatId) continue;
    const list = byHeat.get(h.heatId) ?? [];
    list.push(h);
    byHeat.set(h.heatId, list);
  }
  const sorted = Array.from(byHeat.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const labelColor = accent === "cyan" ? "text-[#00E2E5]" : "text-amber-400";

  return (
    <div>
      <p className={`mb-1 text-[10px] font-bold tracking-wider uppercase ${labelColor}`}>{label}</p>
      <ul className="space-y-1 text-xs">
        {sorted.map(([heatId, entries]) => {
          const time = formatHeatTime(heatId);
          const track = entries[0]?.track ?? null;
          const racers = entries
            .map((e) => party.find((m) => m.id === e.assignedTo)?.firstName)
            .filter((n): n is string => !!n);
          return (
            <li
              key={heatId}
              className="flex items-baseline justify-between gap-2 rounded-md bg-white/[0.02] px-2.5 py-1.5"
            >
              <span className="text-white/80">
                {time}
                {track && <span className="ml-1.5 text-white/40">· {track} Track</span>}
              </span>
              <span className="shrink-0 text-white/50">
                {racers.length > 0 ? racers.join(", ") : "Unassigned"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExtraRow({ icon, label, amount }: { icon: string; label: string; amount: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-white/70">
      <span>
        <span className="mr-1.5">{icon}</span>
        {label}
      </span>
      {amount !== null && <span className="text-white/50">${amount.toFixed(2)}</span>}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function raceTitle(
  item: RaceItem,
  adultProduct: RaceProduct | null,
  juniorProduct: RaceProduct | null,
): string {
  const trackOf = (track: string | null | undefined) => (track ? ` (${track})` : "");
  const adultLabel = adultProduct
    ? `${adultProduct.name}${trackOf(item.productTrackAdult ?? adultProduct.track)}`
    : null;
  const juniorLabel = juniorProduct
    ? `${juniorProduct.name}${trackOf(item.productTrackJunior ?? juniorProduct.track)}`
    : null;
  if (adultLabel && juniorLabel) return `${adultLabel} + ${juniorLabel}`;
  if (adultLabel) return adultLabel;
  if (juniorLabel) return juniorLabel;
  return findOffering("race")?.displayName ?? "Race";
}

function formatHeatTime(iso: string): string {
  const clean = iso.replace(/Z$/, "");
  return new Date(clean).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Add-on price estimates — uses the same prices the AddonsStep displays.
// Source-of-truth pricing comes from BMI overview at checkout, but the
// estimate is close enough for cart preview.
const ADDON_ESTIMATES: Record<string, { name: string; price: number }> = {
  "27488020": { name: "FT Shuffly Combo", price: 10 },
  "23345635": { name: "Duckpin Bowling", price: 35 },
  "27488200": { name: "Gel Blaster", price: 10 },
  "8976685": { name: "Laser Tag", price: 10 },
};

function addonLabel(a: { id: string; qty: number }): string {
  const meta = ADDON_ESTIMATES[a.id];
  const name = meta?.name ?? `Add-on ${a.id}`;
  return a.qty > 1 ? `${name} × ${a.qty}` : name;
}

function estimateAddon(a: { id: string; qty: number }): number {
  const meta = ADDON_ESTIMATES[a.id];
  return (meta?.price ?? 0) * a.qty;
}

function allItemsReady(session: BookingSession): boolean {
  return session.items.every((item) => {
    switch (item.kind) {
      case "race":
        return item.heats.some((h) => h.heatId);
      case "attraction":
        return !!item.productId && !!item.slot;
      case "bowling":
      case "kbf":
        return true;
    }
  });
}

function otherItemTitle(item: SessionItem): string {
  if (item.kind === "attraction" && item.slug) {
    return findOffering(item.slug)?.displayName ?? item.slug;
  }
  return findOffering(item.kind)?.displayName ?? item.kind;
}

function otherItemSummary(item: SessionItem): string {
  switch (item.kind) {
    case "race":
      return "";
    case "attraction":
      return [
        item.date,
        item.slot,
        `qty ${item.qty}`,
        item.assignedTo.length > 0 ? `${item.assignedTo.length} assigned` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "bowling":
      return [
        item.date,
        item.hour != null ? `${item.hour}:00` : null,
        `${item.laneCount} lane(s)`,
        item.assignedTo.length > 0 ? `${item.assignedTo.length} players` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "kbf":
      return [
        item.bookedAt,
        `${item.bowlers.length} bowler${item.bowlers.length === 1 ? "" : "s"}`,
        item.paidAdults > 0 ? `${item.paidAdults} adult(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
