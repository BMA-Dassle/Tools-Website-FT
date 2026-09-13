/**
 * The web form's intake, re-based on `createLead` (v2 alongside v1, R16):
 * `POST /api/sales-lead/submit` becomes zod → `createLead(input, {source:"web"})`
 * → THE SAME RESPONSE SHAPE AS TODAY, so the five `SalesLeadForm.tsx` pages
 * need no change:
 *
 *   success  200 { ok:true, projectID, projectNumber, planner:{displayName,isIndividual}, results:{sms,email,teams} }
 *   invalid  400 { error: "Missing required fields: …" } | { error: "Unknown centerKey: …" }
 *   Pandora  502 { error }          — the lead row EXISTS in Neon by then (R2); the guest sees
 *                                     the same failure as before and a resubmit re-uses the row
 *
 * Everything here is pure (tested); the route is a thin shell.
 */

import { resolveCenter, type CenterConfig } from "@/lib/sales-lead-config";
import type { CentreCode, EventType } from "../../core/types";
import { EVENT_TYPE_LABEL } from "../contracts";
import type { WebSubmitBody } from "../schemas";
import type { CreateLeadInput, CreateLeadResult } from "./create-lead";

/** The form's `centerKey` → our centre. Unknown key → null (400 like today). */
export function centreForCenterKey(
  centerKey: string,
): { centre: CentreCode; center: CenterConfig } | null {
  const center = resolveCenter(centerKey);
  if (!center) return null;
  const centre: CentreCode =
    center.pandoraKey === "fasttrax" ? "FT" : center.pandoraKey === "naples" ? "HPN" : "HPFM";
  return { centre, center };
}

/**
 * The form's richer event values → the CRM vocabulary. `birthday-kid` is the
 * ONLY way a lead becomes a kids' party (mint policy (c) / rule R2). "other"
 * has no CRM equivalent and is filed as corporate with the raw value kept in
 * `capture_payload`.
 */
export const FORM_EVENT_TO_CRM: Record<string, { type: EventType; kids: boolean }> = {
  corporate: { type: "corporate", kids: false },
  "team-building": { type: "team", kids: false },
  fundraiser: { type: "fundraiser", kids: false },
  "school-group": { type: "school", kids: false },
  "birthday-kid": { type: "birthday", kids: true },
  "birthday-adult": { type: "birthday", kids: false },
  other: { type: "corporate", kids: false },
};

export function webEventType(
  formValue: string | undefined,
  /** The form's own prop; `"all"` is the combined group-events dropdown. */
  kind: "group" | "birthday" | "all" | undefined,
) {
  if (formValue && FORM_EVENT_TO_CRM[formValue]) return FORM_EVENT_TO_CRM[formValue];
  if (kind === "birthday") return { type: "birthday" as EventType, kids: false };
  return { type: "corporate" as EventType, kids: false };
}

/** The friendly label the cards / emails show (ported from `friendlyEventLabel`). */
export const FORM_EVENT_FRIENDLY: Record<string, string> = {
  corporate: "Corporate event",
  "team-building": "Team building",
  fundraiser: "Fundraiser",
  "school-group": "School / youth group",
  "birthday-kid": "Kids birthday",
  "birthday-adult": "Adult birthday",
  other: "Other",
};

export function friendlyEventLabel(formValue: string | undefined, type: EventType): string {
  if (formValue && FORM_EVENT_FRIENDLY[formValue]) return FORM_EVENT_FRIENDLY[formValue];
  return EVENT_TYPE_LABEL[type];
}

/**
 * The `specialRequests` blob planners read in Office — ported VERBATIM from
 * the route (`buildPandoraNotes`): under-minimum disclosure first, then the
 * pre-selected package, the event subtype, the interests, the free text.
 */
export function buildPandoraNotes(body: WebSubmitBody): string {
  const parts: string[] = [];
  const minimum = body.eventType === "birthday-kid" ? 12 : 20;
  const guests = Number(body.guestCount) || 0;
  if (guests > 0 && guests < minimum) {
    parts.push(
      `⚠️ UNDER MINIMUM — guest submitted ${guests} but acknowledged pricing will be billed at the ${minimum}-guest package minimum.`,
    );
  }
  if (body.packagePrefill?.trim())
    parts.push(`Package interested in: ${body.packagePrefill.trim()}`);
  const { type } = webEventType(body.eventType, body.kind);
  const friendly = friendlyEventLabel(body.eventType, type);
  if (friendly && friendly !== "Event") parts.push(`Event subtype: ${friendly}`);
  if (body.activityInterest?.length) parts.push(`Interests: ${body.activityInterest.join(", ")}`);
  if (body.notes?.trim()) parts.push(body.notes.trim());
  return parts.join("\n");
}

/** The default event time the route has always sent when the form gave none. */
export const WEB_DEFAULT_EVENT_TIME = "12:00";

export function webBodyToCreateInput(body: WebSubmitBody, centre: CentreCode): CreateLeadInput {
  const { type, kids } = webEventType(body.eventType, body.kind);
  return {
    centre,
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    email: body.email,
    company: null,
    eventDate: body.preferredDate!,
    eventTime: (body.preferredTime || WEB_DEFAULT_EVENT_TIME).slice(0, 5),
    guests: Number(body.guestCount) || 1,
    type,
    kids,
    notes: body.notes?.trim() || null,
    prefers:
      body.preferredContactMethod === "text"
        ? "text"
        : body.preferredContactMethod === "phone"
          ? "call"
          : body.preferredContactMethod === "email"
            ? "email"
            : null,
    preferredContactMethod: body.preferredContactMethod,
    bestTimeToCall: body.bestTimeToCall,
    activityInterest: body.activityInterest,
    packageType: body.packagePrefill,
    // B7: the guest's answer to "Who would you like to work with?" — a slug,
    // resolved against the roster by `createLead`, never trusted as an id.
    requestedPlannerSlug: body.requestedPlanner ?? null,
    specialRequests: buildPandoraNotes(body),
    eventTypeLabel: friendlyEventLabel(body.eventType, type),
    capturePayload: body as unknown as Record<string, unknown>,
    createdBy: null,
  };
}

/** Legacy `validateBody` wording from zod's issues. */
export function missingFieldsMessage(paths: readonly string[]): string {
  return `Missing required fields: ${paths.join(", ")}`;
}

/**
 * The legacy required-field names, in the legacy order, for the legacy
 * message (`route.ts` validateBody, before the cutover) — plus
 * `preferredDate`, which Pandora requires (`eventDate: z.iso.date()`) and the
 * form now gates step 2 on.
 */
export const WEB_REQUIRED_ORDER = [
  "centerKey",
  "firstName",
  "lastName",
  "email",
  "phone",
  "preferredDate",
  "guestCount",
] as const;

export interface WebSubmitRejection {
  /** The guest left it blank (absent, null, `""`, or an empty list). */
  missing: string[];
  /** The guest filled it in and the shape rejected the value. */
  invalid: string[];
}

/** Blank as the FORM means it: an absent key, null, `""`, or an empty list. */
export function isBlankWebValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * "Missing" and "invalid" are different failures and the guest must be told
 * which: a present-but-malformed email used to come back as
 * "Missing required fields: email", which reads as a bug in our form. The
 * raw body decides — a key the guest never filled in is missing, anything
 * else the shape rejected is invalid.
 */
export function classifyWebSubmitIssues(
  raw: unknown,
  paths: readonly string[],
): WebSubmitRejection {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const k of WEB_REQUIRED_ORDER) {
    if (paths.includes(k) && !seen.has(k)) {
      seen.add(k);
      ordered.push(k);
    }
  }
  for (const k of paths) {
    if (k && !seen.has(k)) {
      seen.add(k);
      ordered.push(k);
    }
  }
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const k of ordered) (isBlankWebValue(body[k]) ? missing : invalid).push(k);
  return { missing, invalid };
}

/**
 * The 400 body. Blank fields keep the legacy wording byte-for-byte (the form
 * shows `data.error` verbatim); anything present-but-rejected is named as
 * invalid instead of pretending it was never sent.
 */
export function webSubmitErrorMessage(r: WebSubmitRejection): string {
  if (r.missing.length) return missingFieldsMessage(r.missing);
  return `Invalid fields: ${r.invalid.join(", ") || "body"}`;
}

export interface LegacyWebResponse {
  status: number;
  body: Record<string, unknown>;
}

function channel(
  c:
    | {
        ok: boolean;
        status?: number | null;
        error?: string;
        skipped?: boolean;
        reason?: string;
        activityId?: string;
      }
    | undefined,
) {
  if (!c) return { ok: false, error: "not attempted" };
  return c;
}

/** The exact body the form reads (`SalesLeadForm.tsx:365-372`). */
export function legacyWebResponse(result: CreateLeadResult): LegacyWebResponse {
  const { mint, notify } = result;
  if (mint.status !== "minted") {
    return {
      status: 502,
      body: {
        error: mint.status === "failed" ? mint.error || "Pandora submit failed" : mint.error,
      },
    };
  }
  const planner = notify?.planner ?? { displayName: "Guest Services", isIndividual: false };
  return {
    status: 200,
    body: {
      ok: true,
      projectID: mint.projectId,
      projectNumber: mint.projectNumber,
      planner,
      results: {
        sms: channel(notify?.sms),
        email: channel(notify?.email),
        teams: channel(notify?.plannerCard),
      },
      leadId: result.lead.publicId,
    },
  };
}
