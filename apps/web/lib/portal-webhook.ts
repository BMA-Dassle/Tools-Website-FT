import { createHmac } from "crypto";

const WEBHOOK_URL = process.env.PORTAL_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.PORTAL_WEBHOOK_SECRET || "";

export type PortalWebhookEvent =
  | "document.created"
  | "document.updated"
  | "document.signed"
  | "document.resign_required"
  | "document.cancelled"
  | "document.denied"
  | "document.expired"
  | "payment.deposit_paid"
  | "payment.balance_charged"
  | "payment.balance_link_sent"
  | "approval.needed"
  | "approval.approved";

interface WebhookPayload {
  event: PortalWebhookEvent;
  timestamp: string;
  data: {
    documentId: string | null;
    bmiCode: string;
    venue: string;
    status: string;
  };
}

export async function firePortalWebhook(
  event: PortalWebhookEvent,
  data: {
    documentId: string | null;
    bmiCode: string;
    venue: string;
    status: string;
  },
): Promise<void> {
  if (!WEBHOOK_URL) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const body = JSON.stringify(payload);
  const signature = WEBHOOK_SECRET
    ? `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`
    : "";

  const maxRetries = 3;
  const delays = [5_000, 30_000, 300_000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        console.log(`[portal-webhook] ${event} delivered for ${data.bmiCode}`);
        return;
      }

      console.warn(`[portal-webhook] ${event} attempt ${attempt + 1} failed: ${res.status}`);
    } catch (err) {
      console.warn(
        `[portal-webhook] ${event} attempt ${attempt + 1} error:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  console.error(
    `[portal-webhook] ${event} FAILED after ${maxRetries} attempts for ${data.bmiCode}`,
  );
}

export function firePortalWebhookAsync(
  event: PortalWebhookEvent,
  data: {
    documentId: string | null;
    bmiCode: string;
    venue: string;
    status: string;
  },
): void {
  if (!WEBHOOK_URL) return;
  firePortalWebhook(event, data).catch((err) =>
    console.error("[portal-webhook] async fire error:", err),
  );
}
