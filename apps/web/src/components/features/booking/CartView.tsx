"use client";

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
  onEditItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
}

export function CartView({ session, onEditItem, onRemoveItem }: CartViewProps) {
  return (
    <section className="mx-auto max-w-2xl p-4 sm:p-6">
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
            disabled
            title="Wired in commit 9 (Square anchor + payment)"
            className="rounded-xl bg-[#00E2E5] px-8 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
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
    case "race":
      return [item.date, item.partySize ? `party of ${item.partySize}` : null]
        .filter(Boolean)
        .join(" · ");
    case "attraction":
      return [item.date, item.slot, `qty ${item.qty}`].filter(Boolean).join(" · ");
    case "bowling":
      return [item.date, item.hour != null ? `${item.hour}:00` : null, `${item.laneCount} lane(s)`]
        .filter(Boolean)
        .join(" · ");
    case "kbf":
      return [
        item.slot,
        `${item.bowlers.length} bowlers`,
        item.paidAdults > 0 ? `${item.paidAdults} adult(s)` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
