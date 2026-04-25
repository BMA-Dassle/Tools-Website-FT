/**
 * Twilio SMS — failover path used when Voxtelesys returns a quota /
 * rate-limit error. Standalone, no npm dependency: hits the Twilio
 * REST API directly via fetch. Keeps the bundle small and avoids
 * pulling Twilio's SDK into every cold start.
 *
 * Env required:
 *   TWILIO_SID            — Account SID (starts with AC...)
 *   TWILIO_TOKEN          — Auth token
 *   TWILIO_PHONE_NUMBER   — E.164 sender (we use +12393022151)
 *
 * Failover rules (handled by voxSend, not here):
 *   1. Vox returns quota error -> immediately retry via twilioSend
 *   2. Twilio succeeds          -> caller sees ok:true (no queue, no delay)
 *   3. Twilio also fails quota  -> mark Redis cooldown flag + caller queues
 */

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface TwilioSendResult {
  ok: boolean;
  status: number | null;
  error?: string;
  /** Twilio message SID on success — useful for delivery-status callbacks later */
  sid?: string;
}

export async function twilioSend(to: string, body: string, fromOverride?: string): Promise<TwilioSendResult> {
  const sid = process.env.TWILIO_SID || "";
  const token = process.env.TWILIO_TOKEN || "";
  const from = fromOverride || process.env.TWILIO_PHONE_NUMBER || "";

  if (!sid || !token) return { ok: false, status: null, error: "TWILIO_SID/TWILIO_TOKEN missing" };
  if (!from) return { ok: false, status: null, error: "TWILIO_PHONE_NUMBER missing" };

  // Basic auth header — the Twilio REST API uses the SID as username
  // and the auth token as password.
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  // Form-encoded body — Twilio's REST API doesn't accept JSON for the
  // Messages resource.
  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", from);
  form.set("Body", body);

  try {
    const res = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // Truncate to keep log entries small.
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    let parsedSid: string | undefined;
    try { parsedSid = (JSON.parse(text) as { sid?: string }).sid; } catch { /* non-JSON */ }
    return { ok: true, status: res.status, sid: parsedSid };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : "twilio network error" };
  }
}

/**
 * Twilio's own rate-limit / quota response. Distinct from Vox's so we
 * can detect both and fall through to the queue when neither provider
 * is available.
 */
export function isTwilioQuotaError(status: number | null, body: string): boolean {
  if (status === 429) return true;
  const lower = (body || "").toLowerCase();
  // Twilio error codes 14107 (429), 20429 (Too Many Requests), 30001
  // (queue overflow), 21610 (unsubscribed) etc — we treat the rate /
  // quota family as failover-failed.
  if (lower.includes("queue overflow")) return true;
  if (lower.includes("too many requests")) return true;
  if (lower.includes("rate limit")) return true;
  if (lower.includes("daily")) return true;
  if (lower.includes("\"code\":14107")) return true;
  if (lower.includes("\"code\":20429")) return true;
  if (lower.includes("\"code\":30001")) return true;
  return false;
}
