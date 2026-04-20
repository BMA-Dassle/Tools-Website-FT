/**
 * Adaptive Card builders for the sales-lead flow.
 *
 * Three states:
 *   1. `buildSalesLeadCard(state)` — initial, two action buttons
 *   2. `buildSalesLeadCardAcked(state)` — "✓ Acknowledged" banner + Contacted button
 *   3. `buildSalesLeadCardDone(state)` — "✓ Acknowledged" + "✓ Contacted" banners, no buttons
 *
 * Action.Execute verbs:
 *   - `sales_lead_ack`        — click = Acknowledged only
 *   - `sales_lead_contacted`  — click = Contacted (and implicitly Acknowledged if not already)
 *
 * The Teams bot registered for the portal forwards these verbs to
 * `/api/teams/bot-action` in fasttrax-web (see plan §8).
 */

import type { Planner, CenterConfig } from "@/lib/sales-lead-config";

export interface SalesLeadLead {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  eventType: string;
  preferredDate: string;
  preferredTime?: string;
  guestCount: number;
  notes?: string;
  activityInterest?: string[];
  /** How the customer prefers to be reached: "phone" | "text" | "email". */
  preferredContactMethod?: string;
  /** Best time of day to call: "Morning" | "Afternoon" | "Evening". */
  bestTimeToCall?: string;
}

export interface SalesLeadActor {
  /** Clicker's display name. */
  name: string;
  /** Stable AAD Object ID for the clicker. */
  aadObjectId: string;
  /** ISO timestamp when the click arrived server-side. */
  at: string;
}

export interface SalesLeadState {
  /** String per Pandora swagger (v2.4.9 /bmi/party-lead response). */
  projectID: string;
  projectNumber: string;
  createdAt: string;
  planner: Planner;
  center: CenterConfig;
  lead: SalesLeadLead;
  /** Activity ID of the original card post — set after the initial send. */
  cardActivityId?: string;
  ackedBy?: SalesLeadActor;
  contactedBy?: SalesLeadActor;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  if (!iso) return "(unspecified)";
  try {
    const d = new Date(iso.includes("T") ? iso : iso + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function prettyPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const ten = digits.startsWith("1") && digits.length === 11 ? digits.slice(1) : digits;
  if (ten.length !== 10) return e164;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ── Shared card fragments ───────────────────────────────────────────────────

/**
 * Compact FactSet — only the fields that aren't already in the header.
 * Keeps the card short enough to read without scrolling in the Teams pane.
 */
function leadFactsSet(state: SalesLeadState): Record<string, unknown> {
  const dateLine = state.lead.preferredTime
    ? `${formatDate(state.lead.preferredDate)} · ${state.lead.preferredTime}`
    : formatDate(state.lead.preferredDate);

  const phoneLine = state.lead.preferredContactMethod
    ? `${prettyPhone(state.lead.phone)} · prefers ${state.lead.preferredContactMethod}${
        state.lead.bestTimeToCall ? ` (${state.lead.bestTimeToCall})` : ""
      }`
    : prettyPhone(state.lead.phone);

  const facts: Array<{ title: string; value: string }> = [
    { title: "Date:", value: dateLine },
    { title: "Phone:", value: phoneLine },
    { title: "Email:", value: state.lead.email },
  ];
  if (state.lead.eventType) {
    facts.push({ title: "Type:", value: state.lead.eventType });
  }
  if (state.lead.activityInterest && state.lead.activityInterest.length > 0) {
    facts.push({ title: "Interests:", value: state.lead.activityInterest.join(", ") });
  }
  return { type: "FactSet", facts, spacing: "Small" };
}

/**
 * Header — colored Container that signals state at a glance:
 *   initial     → blue  (Container style "accent")
 *   acked       → yellow (Container style "warning")
 *   contacted   → green  (Container style "good")
 *
 * Bleed: true so the colored band spans the full card width.
 *
 * Eyebrow text also flips to match the state (NEW / ACKNOWLEDGED / CONTACTED)
 * so planners scanning a busy chat can tell status from 3+ feet away.
 */
function headerContainer(state: SalesLeadState): Record<string, unknown> {
  let style: "accent" | "warning" | "good" = "accent";
  let eyebrow = `NEW SALES LEAD · #${state.projectNumber}`;
  if (state.contactedBy) {
    style = "good";
    eyebrow = `CONTACTED · #${state.projectNumber}`;
  } else if (state.ackedBy) {
    style = "warning";
    eyebrow = `ACKNOWLEDGED · #${state.projectNumber}`;
  }
  return {
    type: "Container",
    style,
    bleed: true,
    items: [
      {
        type: "TextBlock",
        text: eyebrow,
        weight: "Bolder",
        size: "Small",
        spacing: "None",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `${state.lead.firstName} ${state.lead.lastName} · ${state.lead.guestCount} guests`,
        weight: "Bolder",
        size: "Large",
        spacing: "Small",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: `${state.center.displayName} · ${state.planner.displayName}`,
        isSubtle: true,
        size: "Small",
        spacing: "None",
        wrap: true,
      },
    ],
  };
}

/** Single TextBlock for notes — no wrapper container. */
function notesBlock(state: SalesLeadState): Record<string, unknown> | null {
  const notes = (state.lead.notes || "").trim();
  if (!notes) return null;
  return {
    type: "TextBlock",
    text: `📝 ${notes}`,
    wrap: true,
    size: "Small",
    isSubtle: true,
    spacing: "Small",
  };
}

/** Compact one-line status banner (no bleed, no big container padding). */
function statusBanner(actor: SalesLeadActor, label: string, color: "good" | "warning"): Record<string, unknown> {
  return {
    type: "TextBlock",
    text: `✓ ${label} by ${actor.name} · ${formatTimeET(actor.at)}`,
    weight: "Bolder",
    size: "Small",
    color: color === "good" ? "Good" : "Warning",
    spacing: "Small",
    wrap: true,
  };
}

function actionSet(verbs: Array<{ verb: string; title: string; style?: "default" | "positive" | "destructive" }>, projectID: string): Record<string, unknown> {
  return {
    type: "ActionSet",
    actions: verbs.map((v) => ({
      type: "Action.Execute",
      verb: v.verb,
      title: v.title,
      style: v.style || "default",
      data: { action: v.verb, projectID },
    })),
  };
}

function baseCard(body: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}

// ── Card builders ───────────────────────────────────────────────────────────

/** Initial card — both Acknowledged + Contacted buttons active. */
export function buildSalesLeadCard(state: SalesLeadState): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    headerContainer(state),
    leadFactsSet(state),
  ];
  const notes = notesBlock(state);
  if (notes) body.push(notes);
  body.push(
    actionSet(
      [
        { verb: "sales_lead_ack", title: "Acknowledged", style: "default" },
        { verb: "sales_lead_contacted", title: "Contacted", style: "positive" },
      ],
      state.projectID,
    ),
  );
  return baseCard(body);
}

/** Acked-only card — Acknowledged banner + Contacted button still available. */
export function buildSalesLeadCardAcked(state: SalesLeadState): Record<string, unknown> {
  if (!state.ackedBy) {
    // Defensive — shouldn't happen but fall through to initial card.
    return buildSalesLeadCard(state);
  }
  const body: Array<Record<string, unknown>> = [
    headerContainer(state),
    statusBanner(state.ackedBy, "Acknowledged", "warning"),
    leadFactsSet(state),
  ];
  const notes = notesBlock(state);
  if (notes) body.push(notes);
  body.push(
    actionSet(
      [{ verb: "sales_lead_contacted", title: "Mark Contacted", style: "positive" }],
      state.projectID,
    ),
  );
  return baseCard(body);
}

/** Contacted card — both banners shown, no more actions. */
export function buildSalesLeadCardDone(state: SalesLeadState): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [headerContainer(state)];
  // Contacted implies Acknowledged — show both if we have them, else synthesize
  // the ack banner from the contacted actor.
  const ack = state.ackedBy || state.contactedBy;
  if (ack) body.push(statusBanner(ack, "Acknowledged", "warning"));
  if (state.contactedBy) body.push(statusBanner(state.contactedBy, "Contacted", "good"));
  body.push(leadFactsSet(state));
  const notes = notesBlock(state);
  if (notes) body.push(notes);
  return baseCard(body);
}

/**
 * Pick the right card shape from state. Single entrypoint used by both the
 * submit endpoint (initial post) and the bot-action endpoint (live update).
 */
export function buildSalesLeadCardForState(state: SalesLeadState): Record<string, unknown> {
  if (state.contactedBy) return buildSalesLeadCardDone(state);
  if (state.ackedBy) return buildSalesLeadCardAcked(state);
  return buildSalesLeadCard(state);
}

/** Activity feed summary text shown in Teams notification preview. */
export function buildSalesLeadSummary(state: SalesLeadState): string {
  return `New sales lead: ${state.lead.firstName} ${state.lead.lastName} · ${state.lead.guestCount} guests · ${state.center.displayName}`;
}
