import { NextRequest, NextResponse } from "next/server";
import { getGfQuoteByShortId, requestGfResign, appendAuditLog } from "@/lib/group-function-db";
import { notifyContractUpdated } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";
import { isAdminCredential } from "@/lib/admin-request-auth";
import { CENTERS } from "@/lib/bmi-scan";
import { RESIGNABLE_STATUSES } from "@/lib/group-function-material-change";

/**
 * POST /api/admin/group-functions/request-resign
 * Body: { shortId, reason?, token }
 *
 * Ask a guest to re-sign a contract they have already signed.
 *
 * The dispatch cron does this by itself for a material change (price / date / venue)
 * the moment it sees one. This endpoint is the manual path for the cases it cannot
 * reach: a change that was already synced to us under an older gate, or one that
 * never came through BMI at all.
 *
 * Mirrors the cron's re-sign branch exactly — quote → `resign_required`, BMI project
 * → "Pending Signed Contract", portal webhook, guest + planner notified — with one
 * deliberate difference: the cron refuses to email when the BMI state move fails,
 * because it re-runs every two minutes and a stuck project would re-ask the guest on
 * every pass. This runs once, on purpose, so a BMI failure is reported rather than
 * allowed to swallow the request. The result says plainly whether BMI moved.
 */
export async function POST(req: NextRequest) {
  const { shortId, reason, token } = (await req.json()) as {
    shortId?: string;
    reason?: string;
    token?: string;
  };

  if (!(await isAdminCredential(token ?? ""))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!shortId) {
    return NextResponse.json({ error: "shortId required" }, { status: 400 });
  }

  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });

  if (quote.status === "resign_required") {
    return NextResponse.json({ ok: true, action: "already_awaiting_resign", shortId });
  }

  // Status + signature guard lives in the UPDATE so the check and the write cannot race.
  const applied = await requestGfResign(quote.id);
  if (applied === 0) {
    return NextResponse.json(
      {
        error:
          `Contract is ${quote.status}${quote.contract_signed_at ? "" : " and was never signed"} — ` +
          `only a signed contract in ${RESIGNABLE_STATUSES.join(" / ")} can be asked to re-sign.`,
        code: "NOT_RESIGNABLE",
        status: quote.status,
      },
      { status: 409 },
    );
  }

  await appendAuditLog({
    quoteId: quote.id,
    event: "resign_requested",
    metadata: {
      trigger: "admin",
      reason: reason ?? null,
      priorStatus: quote.status,
      totalCents: quote.total_cents,
      collectedCents: quote.collected_cents,
      eventDateDisplay: quote.event_date_display,
    },
  }).catch((err) => console.error("[admin/request-resign] audit error:", err));

  // BMI back to "Pending Signed Contract" so the desk sees an event awaiting signature
  // rather than a confirmed one. Non-fatal — reported, never silent.
  let bmiMoved = false;
  let bmiError: string | null = null;
  const center = CENTERS.find((c) => c.centerCode === quote.center_code);
  if (!center) {
    bmiError = `no BMI center config for center_code=${quote.center_code}`;
  } else {
    try {
      const { setProjectState, appendProjectPrivateNote, noteTimestamp } =
        await import("@/lib/bmi-office-actions");
      await setProjectState({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        stateId: center.pendingSignedContractStateId,
        label: "Pending Signed Contract (resign requested)",
      });
      bmiMoved = true;
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note:
          `[${noteTimestamp()}] Re-signature requested by staff${reason ? ` — ${reason}` : ""}. ` +
          `Guest notified; awaiting signature.`,
        // Same fallback as the notifier's baseUrl(): base_url is nullable on older rows.
        contractUrl: `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}`,
      }).catch(() => {});
    } catch (err) {
      bmiError = err instanceof Error ? err.message : String(err);
      console.error("[admin/request-resign] BMI state move failed:", err);
    }
  }

  firePortalWebhookAsync("document.resign_required", {
    documentId: quote.contract_short_id,
    bmiCode: quote.bmi_reservation_id,
    venue: quote.center_code,
    status: "resign_required",
  });

  // Re-read so the email renders the just-written status (the guest page keys its
  // re-sign mode off it, and the link in this email goes straight there).
  const refreshed = await getGfQuoteByShortId(shortId);
  let notified = false;
  try {
    await notifyContractUpdated(refreshed ?? quote);
    notified = true;
  } catch (err) {
    console.error("[admin/request-resign] notify failed:", err);
  }

  console.log(
    `[admin/request-resign] shortId=${shortId} quote=${quote.id} ${quote.status} → resign_required ` +
      `(bmiMoved=${bmiMoved}${bmiError ? ` err=${bmiError}` : ""}, notified=${notified})`,
  );

  return NextResponse.json({
    ok: true,
    action: "resign_requested",
    shortId,
    priorStatus: quote.status,
    bmiMoved,
    bmiError,
    notified,
  });
}
