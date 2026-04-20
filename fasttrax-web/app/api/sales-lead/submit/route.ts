import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { canonicalizePhone } from "@/lib/participant-contact";
import { voxSend } from "@/lib/sms-retry";
import { sendEmail } from "@/lib/sendgrid";
import {
  sendAdaptiveCardToChannel,
  type BotActivityResponse,
} from "@/lib/teams-bot";
import {
  buildSalesLeadCardForState,
  buildSalesLeadSummary,
  type SalesLeadState,
  type SalesLeadLead,
} from "@/lib/sales-lead-card";
import {
  resolveCenter,
  resolvePlanner,
  toPandoraEventType,
  friendlyEventLabel,
  type CenterConfig,
  type Planner,
} from "@/lib/sales-lead-config";
import {
  buildSalesLeadSms,
  buildSalesLeadEmailSubject,
  buildSalesLeadEmailText,
  buildSalesLeadEmailHtml,
  type SalesLeadCopyContext,
} from "@/lib/sales-lead-copy";
import { appendPrivateNote } from "@/lib/bmi-office-notes";
import { submitPartyLead } from "@/lib/pandora-party-lead";

/**
 * POST /api/sales-lead/submit
 *
 * Orchestrator for the sales-lead flow:
 *   1. Validate body
 *   2. POST to Pandora /bmi/party-lead → get projectID + assignedAgent.name
 *   3. Resolve center + planner
 *   4. Persist SalesLeadState to Redis (`salescard:{projectID}`, 90-day TTL)
 *   5. Fan out (allSettled): SMS → customer, email → customer, card → Teams
 *   6. Append audit lines to BMI Office private notes (currently stubbed
 *      into Redis; flushed to Pandora once endpoint HAR is captured)
 *   7. Persist the Teams card activity ID so later button clicks can update
 *      the card in place
 *   8. Respond `{ ok, projectNumber }`
 */

const STATE_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

interface SubmitBody {
  centerKey?: string;
  kind?: "group" | "birthday";
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  /** Friendly form value, mapped to Pandora canonical via toPandoraEventType(). */
  eventType?: string;
  preferredDate?: string;
  preferredTime?: string;
  guestCount?: number;
  notes?: string;
  activityInterest?: string[];
  /** How the customer prefers to be reached: "phone" | "text" | "email". */
  preferredContactMethod?: "phone" | "text" | "email";
  /** Best time to call: "Morning" | "Afternoon" | "Evening". */
  bestTimeToCall?: "Morning" | "Afternoon" | "Evening";
}

export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 1. Validate ──────────────────────────────────────────────────────────
  const missing = validateBody(body);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  const center = resolveCenter(body.centerKey!);
  if (!center) {
    return NextResponse.json(
      { error: `Unknown centerKey: ${body.centerKey}` },
      { status: 400 },
    );
  }

  // ── 2. Submit to Pandora ─────────────────────────────────────────────────
  const pandoraResult = await submitToPandora(body, center);
  if (!pandoraResult.ok) {
    return NextResponse.json(
      { error: pandoraResult.error || "Pandora submit failed" },
      { status: 502 },
    );
  }

  const { projectID, projectNumber, assignedAgent } = pandoraResult;

  // ── 3. Resolve planner ───────────────────────────────────────────────────
  const planner = resolvePlanner(assignedAgent?.name || "", center);

  // ── 4. Build + persist state ─────────────────────────────────────────────
  const lead: SalesLeadLead = {
    firstName: body.firstName!,
    lastName: body.lastName!,
    email: body.email!,
    phone: body.phone!,
    // Display-friendly label — "Team building", "Kids birthday", etc. Used in
    // Teams card / emails. The Pandora canonical value (one of 4 accepted by
    // /bmi/party-lead) is sent separately inside submitToPandora.
    eventType: friendlyEventLabel(body.eventType),
    preferredDate: body.preferredDate || "",
    preferredTime: body.preferredTime,
    guestCount: Number(body.guestCount) || 1,
    notes: body.notes,
    activityInterest: body.activityInterest,
    preferredContactMethod: body.preferredContactMethod,
    bestTimeToCall: body.bestTimeToCall,
  };

  const state: SalesLeadState = {
    projectID,
    projectNumber,
    createdAt: new Date().toISOString(),
    planner,
    center,
    lead,
  };

  const stateKey = `salescard:${projectID}`;
  await redis.set(stateKey, JSON.stringify(state), "EX", STATE_TTL_SECONDS);

  // ── 5. Fan out: SMS + email + Teams ──────────────────────────────────────
  const copyCtx: SalesLeadCopyContext = {
    firstName: lead.firstName,
    projectNumber,
    plannerName: planner.displayName,
    plannerPhone: planner.phone,
    plannerEmail: planner.email,
    preferredDate: lead.preferredDate,
    centerName: center.displayName,
    isIndividualPlanner: planner.isIndividual,
  };

  const [smsResult, emailResult, teamsResult] = await Promise.allSettled([
    sendCustomerSms(lead.phone, copyCtx, planner),
    sendCustomerEmail(lead, copyCtx, planner),
    postToTeams(state),
  ]);

  // ── 6. Audit lines ───────────────────────────────────────────────────────
  await Promise.allSettled([
    writeAuditLine(projectID, "sms", smsResult, { actor: planner.displayName, to: lead.phone }),
    writeAuditLine(projectID, "email", emailResult, { actor: planner.displayName, to: lead.email }),
    writeAuditLine(projectID, "teams", teamsResult, { actor: planner.displayName, to: `${planner.displayName}'s chat` }),
  ]);

  // ── 7. Persist cardActivityId if Teams post succeeded ────────────────────
  if (teamsResult.status === "fulfilled" && teamsResult.value.ok && teamsResult.value.activityId) {
    state.cardActivityId = teamsResult.value.activityId;
    await redis.set(stateKey, JSON.stringify(state), "EX", STATE_TTL_SECONDS);
  }

  return NextResponse.json({
    ok: true,
    projectID,
    projectNumber,
    planner: { displayName: planner.displayName, isIndividual: planner.isIndividual },
    results: {
      sms: flattenPromiseResult(smsResult),
      email: flattenPromiseResult(emailResult),
      teams: flattenPromiseResult(teamsResult),
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function validateBody(body: SubmitBody): string[] {
  const missing: string[] = [];
  if (!body.centerKey) missing.push("centerKey");
  if (!body.firstName) missing.push("firstName");
  if (!body.lastName) missing.push("lastName");
  if (!body.email) missing.push("email");
  if (!body.phone) missing.push("phone");
  if (!body.guestCount || Number(body.guestCount) < 1) missing.push("guestCount");
  return missing;
}

/**
 * Build the specialRequests body — the richer "subtype" the customer picked
 * (e.g. "Fundraiser", "Team building"), activity interests, and their free-text
 * notes, all in one blob. The canonical `eventType` sent separately collapses
 * to one of 4 Pandora values, so we surface the nicer label here so planners
 * don't lose that context.
 */
function buildPandoraNotes(body: SubmitBody): string {
  const parts: string[] = [];
  const friendly = friendlyEventLabel(body.eventType);
  if (friendly && friendly !== "Event") {
    parts.push(`Event subtype: ${friendly}`);
  }
  if (body.activityInterest?.length) {
    parts.push(`Interests: ${body.activityInterest.join(", ")}`);
  }
  if (body.notes?.trim()) {
    parts.push(body.notes.trim());
  }
  return parts.join("\n");
}

/**
 * Submit to Pandora via the shared helper (no internal HTTP hop). This
 * used to POST to our own `/api/pandora/party-lead` route — that required
 * NEXT_PUBLIC_SITE_URL to be set correctly in every environment, which it
 * wasn't in prod. Direct lib call is simpler + faster.
 */
async function submitToPandora(
  body: SubmitBody,
  center: CenterConfig,
): Promise<
  | {
      ok: true;
      projectID: string;
      projectNumber: string;
      personID?: string;
      assignedAgent: { userId?: string; name?: string } | null;
    }
  | { ok: false; error: string }
> {
  const result = await submitPartyLead({
    location: center.pandoraKey,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone, // helper strips to digits
    // Map friendly form value → one of 4 canonical values Pandora accepts.
    eventType: toPandoraEventType(body.eventType),
    eventDate: body.preferredDate,
    eventTime: body.preferredTime || "12:00",
    estimatedGuests: String(body.guestCount ?? ""),
    preferredContact: body.preferredContactMethod,
    preferredTime: body.bestTimeToCall,
    // All rich context (friendly event subtype, activity interests,
    // customer free-text) goes into specialRequests so planners see one
    // cohesive blob instead of scattered across extra fields.
    specialRequests: buildPandoraNotes(body),
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    projectID: result.projectID,
    projectNumber: result.projectNumber,
    personID: result.personID,
    assignedAgent: result.assignedAgent,
  };
}

async function sendCustomerSms(
  rawPhone: string,
  ctx: SalesLeadCopyContext,
  planner: Planner,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const canonical = canonicalizePhone(rawPhone);
  if (!canonical) {
    return { ok: false, status: null, error: "invalid phone" };
  }
  const body = buildSalesLeadSms(ctx);
  return await voxSend(canonical, body, {
    fromOverride: planner.phone,
    fallbackPrefix: `(From ${planner.displayName}) `,
  });
}

async function sendCustomerEmail(
  lead: SalesLeadLead,
  ctx: SalesLeadCopyContext,
  planner: Planner,
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  return await sendEmail({
    to: lead.email,
    toName: `${lead.firstName} ${lead.lastName}`.trim(),
    from: { email: planner.email, name: planner.displayName },
    replyTo: planner.email,
    bcc: planner.email,
    subject: buildSalesLeadEmailSubject(ctx),
    html: buildSalesLeadEmailHtml(ctx),
    text: buildSalesLeadEmailText(ctx),
  });
}

async function postToTeams(
  state: SalesLeadState,
): Promise<{ ok: boolean; activityId?: string; error?: string }> {
  try {
    const card = buildSalesLeadCardForState(state);
    const summary = buildSalesLeadSummary(state);
    const resp: BotActivityResponse = await sendAdaptiveCardToChannel(
      state.planner.teamsChatId,
      card,
      { summaryText: summary },
    );
    return { ok: true, activityId: resp.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "teams send error" };
  }
}

async function writeAuditLine(
  projectId: string,
  channel: "sms" | "email" | "teams",
  settled: PromiseSettledResult<{ ok: boolean; status?: number | null; error?: string; activityId?: string }>,
  meta: { actor?: string; to?: string },
): Promise<void> {
  const outcome = settled.status === "fulfilled" ? settled.value : { ok: false, error: settled.reason?.message || "rejected" };
  const toPart = meta.to ? ` to ${meta.to}` : "";
  const message = outcome.ok
    ? `sent ok${toPart}`
    : `FAILED${toPart}${outcome && "status" in outcome && outcome.status ? ` (${outcome.status})` : ""}: ${(outcome as { error?: string }).error || "unknown"}`;
  await appendPrivateNote({
    projectId,
    channel,
    message,
    actor: meta.actor,
  });
}

function flattenPromiseResult<T>(
  settled: PromiseSettledResult<T>,
): T | { ok: false; error: string } {
  if (settled.status === "fulfilled") return settled.value;
  return { ok: false, error: settled.reason?.message || "rejected" };
}
