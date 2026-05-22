"use client";

import Link from "next/link";
import type { BookingSession, SessionItem } from "~/features/booking";
import { findOffering } from "~/features/booking";
import { AdditionalActivities } from "./AdditionalActivities";

/**
 * Session-level cart view.
 *
 * Renders the customer's current items, the AdditionalActivities cross-sell,
 * and a placeholder Checkout CTA. The CTA gets wired to Square anchor +
 * payment in commit 9 of PR-B2.
 *
 * Styling mirrors v1's dark navy theme and the `bg-white/5` card patterns
 * used by MiniCart + the attraction wizard. Primary CTA picks up the v1
 * cyan accent (#00E2E5).
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

  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="mb-4">
        <Link
          href={backToLandingHref}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
        >
          ← All activities
        </Link>
      </div>
      <h1 className="text-2xl font-semibold text-white sm:text-3xl">Your cart</h1>

      {session.items.length === 0 ? (
        <p className="mt-6 text-sm text-white/50">No items yet.</p>
      ) : (
        <ul className="mt-6 space-y-2">
          {session.items.map((item) => (
            <CartRow
              key={item.id}
              item={item}
              onEdit={() => onEditItem(item.id)}
              onRemove={() => onRemoveItem(item.id)}
            />
          ))}
        </ul>
      )}

      <AdditionalActivities session={session} />

      {session.items.length > 0 && (
        <div className="mt-8 flex justify-end">
          <button
            type="button"
            onClick={onCheckout}
            className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white"
          >
            Checkout →
          </button>
        </div>
      )}
    </section>
  );
}

function CartRow({
  item,
  onEdit,
  onRemove,
}: {
  item: SessionItem;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4 text-sm transition-colors hover:border-white/20">
      <div>
        <div className="font-semibold text-white">{itemTitle(item)}</div>
        <div className="mt-0.5 text-xs text-white/40">{itemSummary(item)}</div>
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

function itemTitle(item: SessionItem): string {
  if (item.kind === "attraction" && item.slug) {
    return findOffering(item.slug)?.displayName ?? item.slug;
  }
  return findOffering(item.kind)?.displayName ?? item.kind;
}

function itemSummary(item: SessionItem): string {
  switch (item.kind) {
    case "race": {
      // Heats are a flat list of (heat, assignedTo) tuples — show count
      // of heats + count of unique racers assigned, with the race day
      // (RaceItem.date) as a quick label. Empty state during wizard build is OK.
      const heatCount = item.heats.length;
      const racers = new Set(item.heats.map((h) => h.assignedTo).filter(Boolean));
      return [
        item.date,
        heatCount > 0 ? `${heatCount} heat${heatCount === 1 ? "" : "s"}` : null,
        racers.size > 0 ? `${racers.size} racer${racers.size === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
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
        item.slot,
        `${item.bowlers.length} bowler${item.bowlers.length === 1 ? "" : "s"}`,
        item.paidAdults > 0 ? `${item.paidAdults} adult(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
