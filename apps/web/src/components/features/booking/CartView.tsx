"use client";

import type { BookingSession, SessionItem } from "~/features/booking";
import { findOffering } from "~/features/booking";
import { AdditionalActivities } from "./AdditionalActivities";

/**
 * Session-level cart view.
 *
 * Renders the customer's current items, the AdditionalActivities cross-sell,
 * and a placeholder "Checkout" CTA. The CTA gets wired to Square anchor +
 * payment in commit 9 of PR-B2.
 *
 * Item editing / removal lands when real per-activity step components exist
 * (commit 8); for now items render as read-only summary rows so the cart
 * shape is visible.
 */
export interface CartViewProps {
  session: BookingSession;
  onEditItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
}

export function CartView({ session, onEditItem, onRemoveItem }: CartViewProps) {
  return (
    <section className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Your cart</h1>

      {session.items.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500">No items yet.</p>
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
            className="rounded bg-black px-6 py-2 text-sm text-white disabled:opacity-40"
          >
            Checkout
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
    <li className="flex items-center justify-between rounded border border-gray-200 p-4 text-sm">
      <div>
        <div className="font-medium">{itemTitle(item)}</div>
        <div className="text-xs text-gray-500">{itemSummary(item)}</div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="rounded border border-gray-300 px-3 py-1 text-xs hover:border-black"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-gray-300 px-3 py-1 text-xs text-red-600 hover:border-red-600"
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
