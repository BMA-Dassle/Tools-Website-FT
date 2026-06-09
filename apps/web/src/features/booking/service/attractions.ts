/**
 * Attraction booking service — resolves config + books slots via bmiAdapter.
 *
 * All four BMI-vendored attractions (gel-blaster, laser-tag, duck-pin,
 * shuffly) share the same booking/book endpoint as races. The bmiAdapter
 * handles raw-ID precision internally, so callers never touch
 * stringifyWithRawIds.
 */
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import type { AttractionItem, BookingSession } from "../state/types";
import { bmiAdapter } from "../data/bmi";
import { registerContact } from "./bmi-register";
import {
  ATTRACTIONS,
  getClientKey,
  type AttractionConfig,
  type AttractionProductDef,
  type LocationKey,
} from "@/lib/attractions-data";

export type { AttractionConfig, AttractionProductDef, LocationKey };
export { ATTRACTIONS, getClientKey };

export interface AttractionContext {
  config: AttractionConfig;
  location: LocationKey;
  clientKey: string | undefined;
}

/**
 * Resolve config, location, and clientKey for an attraction slug
 * given the session's entry brand.
 */
export function resolveAttractionContext(
  slug: string,
  session: BookingSession,
): AttractionContext | null {
  const config = ATTRACTIONS[slug];
  if (!config) return null;

  let location: LocationKey =
    config.location === "both"
      ? session.entryBrand === "headpinz"
        ? "headpinz"
        : "fasttrax"
      : config.location;

  // Fallback: if no products exist at the resolved location (e.g. gel-blaster
  // at "fasttrax"), try the center-based location instead.
  if (!config.products.some((p) => p.location === location)) {
    const centerLoc = session.center === "naples" ? "naples" : "headpinz";
    if (config.products.some((p) => p.location === centerLoc)) {
      location = centerLoc;
    }
  }

  return { config, location, clientKey: getClientKey(config, location) };
}

/**
 * Book an attraction slot with BMI when the customer advances past
 * the slot step ("Add to cart"). Mirrors bookHeatsOnAdvance for races
 * but simpler — one slot, one BMI line.
 */
export async function bookAttractionOnAdvance(
  session: BookingSession,
  item: AttractionItem,
  dispatch: Dispatch<Action>,
): Promise<void> {
  if (!item.productId || !item.slotProposal) {
    throw new Error("Cannot book: productId or slotProposal missing");
  }
  if (item.bmiLineId) return; // already booked

  const ctx = item.slug ? resolveAttractionContext(item.slug, session) : null;

  const result = await bmiAdapter.bookHeat({
    productId: item.productId,
    quantity: item.qty,
    proposal: item.slotProposal,
    orderId: session.bmiBillId,
    clientKey: ctx?.clientKey,
  });

  if (!session.bmiBillId) {
    dispatch({ type: "setBmiBillId", id: result.rawOrderId });
    // Attach the customer to the brand-new bill immediately (v1 parity) so an
    // attraction reservation never exists without a contact. Contact is collected
    // up front (ContactStep), so session.contact is populated. Non-fatal.
    await registerContact(result.rawOrderId, session.contact, session.party);
  }

  dispatch({
    type: "updateItem",
    id: item.id,
    patch: { bmiLineId: result.billLineId },
  });
}
