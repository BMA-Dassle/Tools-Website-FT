/**
 * Sales-lead flow configuration — planners + centers.
 *
 * Single source of truth for:
 *   1. Which center a submitted form targets (keyed on form's `centerKey`)
 *   2. How to map a Pandora `assignedAgent.name` string to a real planner
 *      (email + phone + Teams chat ID)
 *   3. The guest-services fallback when Pandora can't match a named planner
 */

import { PANDORA_LOCATION_MAP, PANDORA_CENTER_NAMES } from "@/lib/pandora-locations";

// ── Planners ────────────────────────────────────────────────────────────────

export interface Planner {
  /** Internal key for matching against Pandora `assignedAgent.name`. */
  key: string;
  /** Name shown in SMS, email, Teams card. */
  displayName: string;
  /** Direct phone in E.164 for SMS caller-ID + tel: links. */
  phone: string;
  /** Email for SendGrid from + replyTo + bcc. */
  email: string;
  /** Teams chat conversation ID (`19:…@thread.v2`) the Adaptive Card lands in. */
  teamsChatId: string;
  /** Individual planner (name on card, direct SMS) vs generic Guest Services bucket. */
  isIndividual: boolean;
}

/**
 * Named planners — matched against `assignedAgent.name` via substring
 * (lowercased, `.includes(key)`). Guest Services is the fallback when none
 * of the individual planners matches.
 *
 */
export const PLANNERS: Record<string, Planner> = {
  stephanie: {
    key: "stephanie",
    displayName: "Stephanie",
    phone: "+12392148353",
    email: "stephanie@headpinz.com",
    teamsChatId: "19:85691711056541ff9f273d8f787eb532@thread.v2",
    isIndividual: true,
  },
  lori: {
    key: "lori",
    displayName: "Lori",
    phone: "+12392042328",
    email: "lori@headpinz.com",
    teamsChatId: "19:599dd54ba7984d398e5816938f614720@thread.v2",
    isIndividual: true,
  },
  kelsea: {
    key: "kelsea",
    displayName: "Kelsea",
    phone: "+12392058142",
    email: "kelsea@headpinz.com",
    teamsChatId: "19:726ae7d6395e433da63ad3980a32c48a@thread.v2",
    isIndividual: true,
  },
};

/**
 * Guest-services fallback — used when `assignedAgent.name` contains
 * "guest services" / "call center" or no individual planner matches.
 *
 * Phone is center-specific (filled in by `resolveGuestServicesPhone`).
 * Email is the shared guestservices mailbox.
 * Teams chat ID is the Guest Services conversation.
 */
const GUEST_SERVICES_BASE = {
  key: "guestservices",
  displayName: "Guest Services",
  email: "guestservices@headpinz.com",
  teamsChatId: "19:1bda68726a584a25af9569c0d764a2e3@thread.v2",
  isIndividual: false as const,
};

// ── Centers ─────────────────────────────────────────────────────────────────

/**
 * Form-side center keys (what the SalesLeadForm component passes) →
 *   - pandoraKey: fed into `/api/pandora/party-lead` via `location` field
 *   - displayName: shown in emails / cards
 *   - guestServicesPhone: dialled when the planner is the GS fallback
 */
export interface CenterConfig {
  centerKey: "fasttrax-ft-myers" | "headpinz-ft-myers" | "headpinz-naples";
  pandoraKey: "fasttrax" | "headpinz" | "naples";
  displayName: string;
  /** Public-facing main phone number for this center, E.164 format. */
  guestServicesPhone: string;
  /** Brand classifier for email/card styling. */
  brand: "ft" | "hp";
}

export const CENTERS: Record<string, CenterConfig> = {
  "fasttrax-ft-myers": {
    centerKey: "fasttrax-ft-myers",
    pandoraKey: "fasttrax",
    displayName: PANDORA_CENTER_NAMES.fasttrax,
    guestServicesPhone: "+12394819666",
    brand: "ft",
  },
  "headpinz-ft-myers": {
    centerKey: "headpinz-ft-myers",
    pandoraKey: "headpinz",
    displayName: PANDORA_CENTER_NAMES.headpinz,
    guestServicesPhone: "+12393022155",
    brand: "hp",
  },
  "headpinz-naples": {
    centerKey: "headpinz-naples",
    pandoraKey: "naples",
    displayName: PANDORA_CENTER_NAMES.naples,
    guestServicesPhone: "+12394553755",
    brand: "hp",
  },
};

export function resolveCenter(centerKey: string | null | undefined): CenterConfig | null {
  if (!centerKey) return null;
  return CENTERS[centerKey] ?? null;
}

export function resolvePandoraLocationForCenter(centerKey: string): string {
  const center = resolveCenter(centerKey);
  if (!center) {
    // Fallback — use the default from pandora-locations (Fort Myers HP).
    return PANDORA_LOCATION_MAP.headpinz;
  }
  return PANDORA_LOCATION_MAP[center.pandoraKey];
}

// ── Planner matching ────────────────────────────────────────────────────────

/**
 * Match a Pandora `assignedAgent.name` to a planner.
 *
 * Strategy:
 *   1. Lowercase the input.
 *   2. If it contains any individual planner's key (`stephanie` / `lori` /
 *      `kelsea`) as a substring, return that planner.
 *   3. Otherwise — including "Guest Services", "Call Center", or unknown
 *      names — return the guest-services bucket with the center's phone.
 */
// ── Event-type mapping (form-value → Pandora canonical) ─────────────────────
//
// The Cognito form used 4 canonical values that the Pandora /bmi/party-lead
// endpoint accepts:  "Company Event" | "Adult Birthday" | "Child Birthday" | "Other Event"
// Our in-app form offers a wider, more user-friendly set of values — this map
// collapses them back to one of the 4 before the Pandora POST. The friendly
// label (what the user picked) is preserved in SalesLeadState for the Teams
// card / emails, so planners see the richer description we captured.

export type PandoraEventType =
  | "Company Event"
  | "Adult Birthday"
  | "Child Birthday"
  | "Other Event";

export const FORM_EVENT_TO_PANDORA: Record<string, PandoraEventType> = {
  // Group-events form values
  corporate:       "Company Event",
  "team-building": "Company Event",
  fundraiser:      "Other Event",
  "school-group":  "Other Event",
  // Birthday form values
  "birthday-kid":   "Child Birthday",
  "birthday-adult": "Adult Birthday",
  // Shared
  other: "Other Event",
};

/** Canonical labels for display (when we ever need to surface the Pandora bucket). */
export const FORM_EVENT_FRIENDLY: Record<string, string> = {
  corporate: "Corporate event",
  "team-building": "Team building",
  fundraiser: "Fundraiser",
  "school-group": "School / youth group",
  "birthday-kid": "Kids birthday",
  "birthday-adult": "Adult birthday",
  other: "Other",
};

export function toPandoraEventType(formValue: string | null | undefined): PandoraEventType {
  if (!formValue) return "Other Event";
  return FORM_EVENT_TO_PANDORA[formValue] ?? "Other Event";
}

export function friendlyEventLabel(formValue: string | null | undefined): string {
  if (!formValue) return "Event";
  return FORM_EVENT_FRIENDLY[formValue] ?? formValue;
}

export function resolvePlanner(
  assignedAgentName: string | null | undefined,
  center: CenterConfig,
): Planner {
  const name = (assignedAgentName || "").toLowerCase();
  for (const planner of Object.values(PLANNERS)) {
    if (name.includes(planner.key)) {
      return planner;
    }
  }
  // Fallback — Guest Services with center-specific phone.
  return {
    ...GUEST_SERVICES_BASE,
    phone: center.guestServicesPhone,
  };
}
