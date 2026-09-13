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
  kind: "group" | "birthday" | undefined,
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
