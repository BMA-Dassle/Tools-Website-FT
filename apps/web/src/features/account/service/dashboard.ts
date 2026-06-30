/**
 * Aggregates the logged-in customer dashboard from four independent domains:
 * reservations (Neon), group events (Neon), HeadPinz Rewards (Square loyalty),
 * and the BMI race account. `buildDashboard` fans out with Promise.allSettled so
 * a slow/failing upstream degrades only its own section — the page still renders.
 *
 * AUTHORIZATION: the verified session contact is the ONLY key. The client never
 * supplies a phone/email/personId; we match Neon rows on the proven channel only
 * (single-channel — never OR phone+email) and gate the phone-keyed sections
 * (Rewards, Race) behind a phone-typed session.
 */
import type { AccountSession } from "../types";
import { maskValue } from "../contact";
import type {
  AccountDashboardResponse,
  DashGroupEvent,
  DashRaceAccount,
  DashReservation,
  DashRewards,
} from "../dashboard-types";
import { getReservationsByContact, type BowlingReservationWithLines } from "@/lib/bowling-db";
import { getGroupQuotesByContact, type GroupFunctionQuote } from "@/lib/group-function-db";
import { confirmationShortUrl } from "@/lib/booking-confirmation-link";
import { lookupLoyaltyByPhone } from "../data/loyalty";
import { getRacerAccounts } from "../data/bmi-race";

function siteBase(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
}

/** Current ET wall-clock as a naive ISO ("YYYY-MM-DDTHH:MM:SS") to compare with event_at. */
function nowEtIso(): string {
  // sv-SE renders "YYYY-MM-DD HH:MM:SS"; swap the space for a T so it sorts/compares
  // lexically against the naive ET event_at strings the list queries emit.
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T");
}

function brandOf(productKind: string): "fasttrax" | "headpinz" {
  return productKind === "race" ? "fasttrax" : "headpinz";
}

function lineSummary(r: BowlingReservationWithLines): string[] {
  return r.lines.map((l) => (l.quantity > 1 ? `${l.quantity} × ${l.label}` : l.label));
}

async function toDashReservation(r: BowlingReservationWithLines): Promise<DashReservation> {
  const cancelled = r.status === "cancelled";
  return {
    id: r.id,
    productKind: r.productKind as DashReservation["productKind"],
    centerCode: r.centerCode,
    brand: brandOf(r.productKind),
    status: r.status,
    cancelled,
    eventAt: r.eventAt ?? r.bookedAt,
    bookedAt: r.bookedAt,
    playerCount: r.playerCount ?? null,
    guestName: r.guestName ?? null,
    shortCode: r.shortCode ?? null,
    // Always v2 (multi-activity) confirmation page, matching the admin board.
    confirmationUrl: r.bmiBillId ? await confirmationShortUrl(r.bmiBillId, true) : null,
    comboGroupId: r.comboSpecialId ? (r.squareDayofOrderId ?? null) : null,
    comboSpecialId: r.comboSpecialId ?? null,
    lineSummary: lineSummary(r),
  };
}

export async function loadReservations(
  session: AccountSession,
): Promise<AccountDashboardResponse["reservations"]> {
  const rows = await getReservationsByContact(
    session.contactType === "phone" ? { phone: session.contact } : { email: session.contact },
  );
  const dash = await Promise.all(rows.map(toDashReservation));
  const cutoff = nowEtIso();
  const upcoming = dash
    .filter((d) => !d.cancelled && d.eventAt >= cutoff)
    .sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const past = dash
    .filter((d) => d.cancelled || d.eventAt < cutoff)
    .sort((a, b) => b.eventAt.localeCompare(a.eventAt));
  return { status: "ok", upcoming, past };
}

function toDashGroupEvent(q: GroupFunctionQuote): DashGroupEvent {
  const collected = q.collected_cents ?? 0;
  return {
    id: q.id,
    eventName: q.event_name,
    eventDate: q.event_date,
    centerName: q.center_name,
    status: q.status,
    totalCents: q.total_cents,
    collectedCents: collected,
    balanceCents: Math.max(0, q.total_cents - collected),
    contractUrl: q.contract_short_id ? `${siteBase()}/contract/${q.contract_short_id}` : null,
  };
}

export async function loadGroupEvents(
  session: AccountSession,
): Promise<AccountDashboardResponse["groupEvents"]> {
  const rows = await getGroupQuotesByContact(
    session.contactType === "phone" ? { phone: session.contact } : { email: session.contact },
  );
  return { status: "ok", items: rows.map(toDashGroupEvent) };
}

export async function loadRewards(session: AccountSession): Promise<DashRewards> {
  // Loyalty is phone-keyed; an email-only session has no verified phone.
  if (session.contactType !== "phone") return { status: "not_applicable", account: null };
  const account = await lookupLoyaltyByPhone(session.contact);
  if (account === undefined) return { status: "unavailable", account: null };
  if (account === null) return { status: "ok", account: null }; // not enrolled
  return {
    status: "ok",
    account: {
      balance: account.balance,
      lifetimePoints: account.lifetimePoints,
      enrolledAt: account.enrolledAt,
    },
  };
}

export async function loadRaceAccount(session: AccountSession): Promise<DashRaceAccount> {
  // BMI is phone-keyed; an email-only session has no verified phone to search.
  if (session.contactType !== "phone") return { status: "not_applicable", accounts: [] };
  const accounts = await getRacerAccounts(session.contact, session.contact);
  // Trim to the dashboard shape — email/loginCode/birthDate stay server-side.
  return {
    status: "ok",
    accounts: accounts.map((a) => ({
      personId: a.personId,
      fullName: a.fullName,
      lastSeen: a.lastSeen,
      races: a.races,
      memberships: a.memberships,
      credits: a.credits,
    })),
  };
}

/** Fan out all four sections; a rejected loader degrades only its own card. */
export async function buildDashboard(session: AccountSession): Promise<AccountDashboardResponse> {
  const [reservations, groupEvents, rewards, raceAccount] = await Promise.allSettled([
    loadReservations(session),
    loadGroupEvents(session),
    loadRewards(session),
    loadRaceAccount(session),
  ]);

  const phone = session.contactType === "phone";
  return {
    contactMasked: maskValue(session.contact, session.contactType),
    contactType: session.contactType,
    reservations:
      reservations.status === "fulfilled"
        ? reservations.value
        : { status: "unavailable", upcoming: [], past: [] },
    groupEvents:
      groupEvents.status === "fulfilled" ? groupEvents.value : { status: "unavailable", items: [] },
    rewards:
      rewards.status === "fulfilled"
        ? rewards.value
        : { status: phone ? "unavailable" : "not_applicable", account: null },
    raceAccount:
      raceAccount.status === "fulfilled"
        ? raceAccount.value
        : { status: phone ? "unavailable" : "not_applicable", accounts: [] },
  };
}
