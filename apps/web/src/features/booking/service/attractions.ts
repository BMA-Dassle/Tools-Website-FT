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

  // CENTER FIRST: a Naples session must resolve Naples products and the Naples
  // BMI client key. Brand-based resolution alone maps "headpinz" to HP Fort
  // Myers, which sent every Naples gel-blaster / laser-tag booking into the
  // Fort Myers BMI — invisible to Naples staff (2026-07-20 incident; the
  // fallback below never fired because FM sells both attractions too).
  let location: LocationKey =
    session.center === "naples" && config.products.some((p) => p.location === "naples")
      ? "naples"
      : config.location === "both"
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

  // Response orderId is AUTHORITATIVE — adopt it whenever it differs. BMI
  // silently reparents onto a fresh order when the chained order was cancelled
  // (e.g. a race deselect emptied it — emptied Pending-online orders
  // auto-cancel); keeping the stale id strands the line on an invisible new
  // W-number (live find 2026-07-19, race flow).
  if (result.rawOrderId && result.rawOrderId !== session.bmiBillId) {
    dispatch({ type: "setBmiBillId", id: result.rawOrderId });
    // Attach the customer to the (possibly brand-new) bill immediately (v1
    // parity) so an attraction reservation never exists without a contact.
    // Same clientKey as the bill was created with — a Naples bill lives in the
    // Naples BMI; the default (FM) key would silently attach nothing.
    // Non-fatal.
    await registerContact(result.rawOrderId, session.contact, session.party, ctx?.clientKey);
  }

  dispatch({
    type: "updateItem",
    id: item.id,
    patch: { bmiLineId: result.billLineId },
  });
}
