/**
 * THE EVENT TAB — the BMI project behind a deal: schedule, products, people,
 * waivers and the day-of line.
 *
 * `getReservationDetail(locationId, projectId)` is the SAME read the v2 Daily
 * Events detail page makes (`fetchProjectRaw` + metadata, ids parsed with
 * `parseWithRawIds`, so every id here is a string). Nothing is written.
 *
 * Money: Office reports `totalPrice` in DOLLARS on a product line and a dollar
 * `balance` on the project. The CRM speaks cents everywhere (`core/format`),
 * so the conversion happens ONCE, here, and `*_cents` is the only shape that
 * crosses the wire.
 */

import { getGfQuoteByReservationId } from "@/lib/group-function-db";
import { hasWaiverRequiredActivities } from "@/lib/bmi-office-actions";
import { getEventMetadata, getReservationDetail } from "~/features/daily-events/service";
import type { EventMetadata, Person, ReservationDetail } from "~/features/daily-events/types";
import { centreByCode } from "../../core/centres";
import type { CentreCode } from "../../core/types";
import {
  EMPTY_FOOD_OUT,
  type EventContractView,
  type EventDetailView,
  type EventFoodOut,
  type EventPersonRow,
  type EventProductRow,
  type EventScheduleRow,
} from "../contracts";
import { contractView, type BoardQuote } from "../projection";

export interface EventDetailDeps {
  getReservationDetail: (locationId: number, projectId: string) => Promise<ReservationDetail>;
  getEventMetadata: (projectId: string, locationId: number, date: string) => Promise<EventMetadata>;
  getQuote: (projectId: string) => Promise<BoardQuote | null>;
}

export function defaultEventDetailDeps(): EventDetailDeps {
  return {
    getReservationDetail,
    getEventMetadata,
    getQuote: (projectId) =>
      getGfQuoteByReservationId(projectId) as unknown as Promise<BoardQuote | null>,
  };
}

export function foodOutView(m: EventMetadata | null): EventFoodOut {
  if (!m) return EMPTY_FOOD_OUT;
  return {
    time: m.foodOutTime,
    source: m.foodOutSource,
    confidence: m.foodOutConfidence,
    reasoning: m.foodOutReasoning,
    updatedAt: m.updatedAt,
  };
}

function dollarsToCents(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0;
}

/**
 * Office puts a person's contact details EITHER on the row (`person/{id}`) or
 * inside `addresses[]` (`personsByIds`), and `getReservationDetail` returns
 * both shapes — the contact from one call and the attendees from the other.
 * Read both rather than picking one and rendering half the roster blank.
 */
function personRow(p: Person, role: string): EventPersonRow {
  const address = (p.addresses ?? []).find((a) => a.email || a.mobile || a.phone) ?? {};
  const name = [p.name, p.firstName].find((v) => typeof v === "string" && v.trim() !== "") ?? "";
  const email = p.email || address.email || "";
  const phone = p.mobile || p.phone || address.mobile || address.phone || "";
  return {
    id: String(p.id ?? p.personId ?? ""),
    name: String(name).trim(),
    email: email ? String(email) : null,
    phone: phone ? String(phone) : null,
    role,
  };
}

/** `ReservationDetail` → the Event tab's view. Pure once the reads are in. */
export function projectEventDetail(
  centre: CentreCode,
  detail: ReservationDetail,
  metadata: EventMetadata | null,
  quote: BoardQuote | null,
): EventDetailView {
  const schedules: EventScheduleRow[] = (detail.schedules || []).map((s) => ({
    id: String(s.id),
    start: s.start,
    stop: s.stop,
    resource: s.resourceName || "",
    products: s.productLines || "",
    persons: Number(s.persons) || 0,
  }));

  const products: EventProductRow[] = (detail.products || []).map((p) => ({
    id: String(p.id),
    productId: String(p.productId),
    name: p.productName || "",
    nameOverride: p.nameOverride ?? null,
    quantity: Number(p.quantity) || 0,
    totalPriceCents: dollarsToCents(p.totalPrice),
  }));

  const people = (detail.persons_list || []).map((p) => personRow(p, "attendee"));
  const contact = detail.contactPerson ? personRow(detail.contactPerson, "host") : null;

  const contract: EventContractView | null = quote ? contractView(quote) : null;

  return {
    projectId: String(detail.id),
    number: detail.number ? String(detail.number) : "",
    name: detail.name || "",
    when: detail.when || null,
    centre,
    stateName: detail.state || "",
    kindName: detail.kind || "",
    responsible: detail.responsible || "",
    persons: Number(detail.persons) || 0,
    registered: people.length || null,
    balanceCents: dollarsToCents(detail.balance),
    createdAt: detail.creationDate || null,
    schedules,
    products,
    people,
    contact,
    foodOut: foodOutView(metadata),
    waiversRequired: hasWaiverRequiredActivities(products.map((p) => ({ name: p.name }))),
    contract,
  };
}

/** The Event tab's one read: BMI detail + food-out + the contract row. */
export async function eventDetail(
  centreCode: CentreCode,
  projectId: string,
  deps: EventDetailDeps = defaultEventDetailDeps(),
): Promise<EventDetailView> {
  const centre = centreByCode(centreCode);
  const detail = await deps.getReservationDetail(centre.locationId, projectId);
  const eventYmd = (detail.when || "").slice(0, 10);
  const [metadata, quote] = await Promise.all([
    eventYmd
      ? deps.getEventMetadata(projectId, centre.locationId, eventYmd).catch(() => null)
      : Promise.resolve(null),
    deps.getQuote(projectId).catch(() => null),
  ]);
  return projectEventDetail(centreCode, detail, metadata, quote);
}
