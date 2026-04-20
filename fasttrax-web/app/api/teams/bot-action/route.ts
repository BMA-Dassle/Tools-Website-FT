import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  buildSalesLeadCardForState,
  buildSalesLeadSummary,
  type SalesLeadState,
  type SalesLeadActor,
} from "@/lib/sales-lead-card";
import { updateAdaptiveCard } from "@/lib/teams-bot";
import { appendPrivateNote } from "@/lib/bmi-office-notes";

/**
 * POST /api/teams/bot-action
 *
 * Receives Bot Framework invoke activities that the portal forwards here
 * (see plan §8). Portal's `api/bot/messages.ts` detects `sales_lead_*`
 * verbs and POSTs the full activity envelope with the shared-secret
 * header `x-portal-forward-secret`.
 *
 * This handler:
 *   1. Verifies the shared secret
 *   2. Extracts verb + actor + projectID from the activity
 *   3. Loads SalesLeadState from Redis
 *   4. Applies the state transition:
 *        - sales_lead_ack       → ackedBy = {name, aadObjectId, at}
 *        - sales_lead_contacted → contactedBy = ...; implies ackedBy
 *   5. Persists updated state back to Redis
 *   6. Calls updateAdaptiveCard to refresh the card in place for all
 *      participants
 *   7. Appends a private-note audit line
 *   8. Responds with an invoke response containing the new card (Teams
 *      shows this to the clicker immediately)
 */

const STATE_TTL_SECONDS = 60 * 60 * 24 * 90;

export async function POST(req: NextRequest) {
  // ── 1. Verify shared secret ──────────────────────────────────────────────
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-portal-forward-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 2. Parse activity envelope ───────────────────────────────────────────
  let activity: Record<string, unknown>;
  try {
    activity = (await req.json()) as Record<string, unknown>;
  } catch {
    return invokeErrorResponse("Invalid JSON body");
  }

  const { verb, projectID, actor, conversationId, replyToId } = extractInvoke(activity);
  if (!verb) {
    return invokeErrorResponse("Missing action verb");
  }
  if (!projectID) {
    return invokeErrorResponse("Missing projectID in action data");
  }
  if (!conversationId) {
    return invokeErrorResponse("Missing conversation.id");
  }

  // ── 3. Load state ────────────────────────────────────────────────────────
  const stateKey = `salescard:${projectID}`;
  const raw = await redis.get(stateKey);
  if (!raw) {
    return invokeErrorResponse(`No sales lead state for projectID ${projectID} (expired?)`);
  }

  let state: SalesLeadState;
  try {
    state = JSON.parse(raw) as SalesLeadState;
  } catch {
    return invokeErrorResponse("Corrupt state record");
  }

  // ── 4. Apply state transition ────────────────────────────────────────────
  const now = new Date().toISOString();
  const actorRecord: SalesLeadActor = {
    name: actor.name || "Unknown",
    aadObjectId: actor.aadObjectId || "",
    at: now,
  };

  let auditMessage = "";
  if (verb === "sales_lead_ack") {
    if (!state.ackedBy && !state.contactedBy) {
      state.ackedBy = actorRecord;
      auditMessage = "acknowledged";
    } else {
      // Idempotent — don't overwrite existing acknowledge timestamp.
      auditMessage = "acknowledge clicked (already handled)";
    }
  } else if (verb === "sales_lead_contacted") {
    if (!state.contactedBy) {
      state.contactedBy = actorRecord;
      // Contacted implies Acknowledged — set both to the same actor/time
      // if not previously acked.
      if (!state.ackedBy) {
        state.ackedBy = actorRecord;
      }
      auditMessage = "marked contacted";
    } else {
      auditMessage = "contacted clicked (already handled)";
    }
  } else {
    return invokeErrorResponse(`Unknown verb: ${verb}`);
  }

  // ── 5. Persist ───────────────────────────────────────────────────────────
  await redis.set(stateKey, JSON.stringify(state), "EX", STATE_TTL_SECONDS);

  // ── 6. Update card in place ──────────────────────────────────────────────
  const newCard = buildSalesLeadCardForState(state);
  // Prefer the replyToId from the invoke; fall back to persisted cardActivityId.
  const activityIdToUpdate = replyToId || state.cardActivityId || "";
  if (activityIdToUpdate) {
    await updateAdaptiveCard(conversationId, activityIdToUpdate, newCard, {
      summaryText: buildSalesLeadSummary(state),
    });
  }

  // ── 7. Audit line ────────────────────────────────────────────────────────
  await appendPrivateNote({
    projectId: state.projectID,
    channel: "action",
    message: auditMessage,
    actor: actorRecord.name,
  });

  // ── 8. Invoke response ───────────────────────────────────────────────────
  return NextResponse.json({
    statusCode: 200,
    type: "application/vnd.microsoft.card.adaptive",
    value: newCard,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ExtractedInvoke {
  verb: string;
  /** String per Pandora swagger — but also accept numeric for defensive compatibility. */
  projectID: string | null;
  actor: { name: string; aadObjectId: string };
  conversationId: string;
  replyToId: string;
}

function extractInvoke(activity: Record<string, unknown>): ExtractedInvoke {
  const value = activity.value as Record<string, unknown> | undefined;
  const action = (value?.action as Record<string, unknown>) || {};
  const data = (action.data as Record<string, unknown>) || (value?.data as Record<string, unknown>) || {};
  const verb = (action.verb as string) || (data.action as string) || "";

  const rawProjectId = data.projectID ?? data.projectId;
  const projectID =
    rawProjectId === undefined || rawProjectId === null
      ? null
      : String(rawProjectId);

  const from = (activity.from as Record<string, unknown>) || {};
  const conversation = (activity.conversation as Record<string, unknown>) || {};

  return {
    verb,
    projectID,
    actor: {
      name: (from.name as string) || "",
      aadObjectId: (from.aadObjectId as string) || (from.id as string) || "",
    },
    conversationId: (conversation.id as string) || "",
    replyToId: (activity.replyToId as string) || "",
  };
}

/**
 * Respond to an invoke with a CLIENT-SIDE error toast, WITHOUT replacing
 * the card. Teams shows the error only to the clicker; the card for
 * everyone else stays intact.
 *
 * Bot Framework / Teams Adaptive Card invoke response shapes:
 *   { statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: <card> }
 *       → replaces the card for ALL viewers
 *   { statusCode: 4xx/5xx, type: "application/vnd.microsoft.error", value: { code, message } }
 *       → shows a toast to the clicker only; original card stays
 *
 * We always use the error-toast shape for our failure paths so a transient
 * Redis miss / forward hiccup never nukes the card for the planner chat.
 */
function invokeErrorResponse(message: string, statusCode = 500): NextResponse {
  return NextResponse.json(
    {
      statusCode,
      type: "application/vnd.microsoft.error",
      value: {
        code: statusCode === 403 ? "Unauthorized" : "BadRequest",
        message,
      },
    },
    { status: 200 }, // outer HTTP status stays 200 so the portal forwarder
                    // passes our payload through unchanged
  );
}
