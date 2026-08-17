/**
 * HP-branded send helpers shared by the arena pre-session cron
 * (service.ts) and the arena check-in alert cron (checkin-alerts.ts).
 *
 * Wraps voxSend with the HeadPinz sender + carries the DID into both
 * the retry queue and the quota queue so a queued arena SMS never goes
 * out from the FastTrax number. Email sends as "HeadPinz".
 */
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";
import { queueRetry, voxSend, type SmsRetryCron } from "@/lib/sms-retry";
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";
import { VOX_FROM_HEADPINZ_FM } from "./constants";

export type ArenaSmsSource = Extract<SmsRetryCron, "arena-pre-cron" | "arena-checkin-cron">;

export interface ArenaSmsAudit {
  sessionIds: (string | number)[];
  personIds: (string | number)[];
  memberCount: number;
  shortCode?: string;
  viaGuardian?: boolean;
}

export interface ArenaSendOpts {
  /** Sender DID for this center (FM vs Naples). Defaults to the FM DID
   *  for back-compat with pre-multi-center callers. */
  from?: string;
  /** Square/Pandora location the audit ids belong to — carried into the
   *  retry + quota queues so a drained retry rebuilds the SAME
   *  location-scoped dedup keys the cron scan checks (bmiKeyScope). */
  locationId?: string;
}

export async function sendArenaSms(
  source: ArenaSmsSource,
  to: string,
  body: string,
  audit: ArenaSmsAudit,
  opts?: ArenaSendOpts,
): Promise<boolean> {
  const from = opts?.from || VOX_FROM_HEADPINZ_FM;
  const ts = new Date().toISOString();
  const toFormatted = canonicalizePhone(to);
  if (!toFormatted) {
    await logSms({
      ts,
      phone: to,
      source,
      status: null,
      ok: false,
      error: "invalid phone format",
      body,
      ...audit,
    });
    return false;
  }

  const result = await voxSend(toFormatted, body, {
    fromOverride: from,
    fallbackPrefix: "HeadPinz: ",
  });
  if (result.ok) {
    await logSms({
      ts,
      phone: toFormatted,
      source,
      status: result.status,
      ok: true,
      body,
      provider: result.provider,
      failedOver: result.failedOver,
      providerMessageId: result.voxId,
      ...audit,
    });
    return true;
  }

  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      source,
      queuedAt: ts,
      shortCode: audit.shortCode,
      from,
      fallbackPrefix: "HeadPinz: ",
      ...(opts?.locationId ? { locationId: opts.locationId } : {}),
      audit: {
        sessionIds: audit.sessionIds,
        personIds: audit.personIds,
        memberCount: audit.memberCount,
      },
    });
    await logSms({
      ts,
      phone: toFormatted,
      source,
      status: result.status,
      ok: false,
      error: `[quota] queued for next reset window (${result.error || "429"})`,
      body,
      ...audit,
    });
    return false;
  }

  console.error(`[${source}] SMS ${result.status}: ${result.error}`);
  await logSms({
    ts,
    phone: toFormatted,
    source,
    status: result.status,
    ok: false,
    error: result.error || "",
    body,
    ...audit,
  });
  await queueRetry({
    cron: source,
    phone: toFormatted,
    body,
    audit,
    status: result.status,
    error: result.error || "",
    from,
    ...(opts?.locationId ? { locationId: opts.locationId } : {}),
  });
  return false;
}

export async function sendArenaEmail(to: string, subject: string, html: string): Promise<boolean> {
  const result = await sendGridEmail({
    to,
    subject,
    html,
    from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com", name: "HeadPinz" },
  });
  if (!result.ok) {
    console.error("[arena-send] Email error:", result.status, result.error);
    return false;
  }
  return true;
}
