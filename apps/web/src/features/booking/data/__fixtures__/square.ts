/**
 * Square fixture data for mock mode.
 *
 * Just enough shape to let the booking wizard run end-to-end without
 * credentials. Replace with `recorded` real responses if/when we capture
 * a Square Sandbox playback to make fixtures match reality more closely.
 */
import type { SquareOrder } from "../square";

let nextId = 1;

/** Fixture: minimal Square Order used by mockSquareAdapter.createOrder. */
export function buildSquareOrder(metadata: Record<string, string>): SquareOrder {
  const id = `mock-order-${nextId++}`;
  return {
    id,
    state: "DRAFT",
    totalCents: 0,
    metadata,
    lineItems: [],
  };
}
