import { randomBytes } from "crypto";
import {
  appendAuditLog,
  claimGfBalanceCharge,
  parseGiftCardGans,
  parseGiftCardIds,
  updateGfBalanceChargeCaptured,
  updateGfBalanceCharged,
  updateGfBalanceLinkSent,
  updateGfBalancePrepaid,
  updateGfGiftCardList,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";
import { loadBalanceOntoGiftCards, sumGiftCardLoadsForPayment } from "@/lib/square-gift-card";
import { buildPaymentLineItems, serviceChargeCentsFromLineItems } from "@/lib/service-charge";
import { notifyBalanceLinkSent, notifyBalanceReceipt } from "@/lib/group-function-notify";
import { firePortalWebhookAsync } from "@/lib/portal-webhook";

/**
 * THE per-quote balance rail, extracted verbatim from the body of
 * `app/api/cron/group-balance-charge/route.ts` so the 72-hour cron and the
 * CRM's "Charge balance now" / "Send balance link" run the SAME code (brief
 * §4 B5). The cron keeps its scan, its dry run and its summary; this module
 * owns what happens to ONE quote.
 *
 * Nothing about the money changed in the move. In particular:
 *   - the ATOMIC CLAIM still runs first (`claimGfBalanceCharge`), which is the
 *     only thing standing between a director pressing "Charge balance now"
 *     while the cron is mid-flight and a double charge (#H2884, 2026-06-10);
 *   - the persist-first capture marker and its RESUME branch are untouched, so
 *     a fulfilment failure re-finalises instead of re-charging;
 *   - a captured-but-unfinalised charge still refuses to send a "balance due"
 *     link (that invites a second payment) and pages ops instead.
 *
 * What the extraction ADDS is provenance: `actor` and `reason` reach the audit
 * ledger and the BMI private note, so a hand-run charge is distinguishable
 * from the cron's forever after. `actor` is null for the cron — the metadata
 * then reads exactly as it did before (`source: "auto_charge_cron"`).
 *
 * `mode: "link"` skips Path A entirely: that is the CRM's "Send balance link"
 * action, for a guest who asked to pay by link rather than have the card on
 * file charged. It is NOT a decline path, so nothing is recorded as one.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export type BalanceChargeOutcome = "auto_charged" | "link_sent" | "skipped";

export interface ChargeBalanceOptions {
  /** The signed-in director who pressed the button; null on the cron. */
  actor?: string | null;
  /** "Guest asked to pay early" — recorded, never acted on. */
  reason?: string | null;
  /** "auto" (default) tries the saved card first; "link" goes straight to the pay page. */
  mode?: "auto" | "link";
}

/** `source` for the audit ledger — the cron's value is unchanged by design. */
function auditSource(opts: ChargeBalanceOptions): string {
  return opts.actor ? "crm_manual_charge" : "auto_charge_cron";
}

function actorSuffix(opts: ChargeBalanceOptions): string {
  if (!opts.actor) return "";
  return opts.reason ? ` by ${opts.actor} — ${opts.reason}` : ` by ${opts.actor}`;
}

export async function chargeBalanceForQuote(
  quote: GroupFunctionQuote,
  opts: ChargeBalanceOptions = {},
): Promise<BalanceChargeOutcome> {
  const mode = opts.mode ?? "auto";

  // Atomic claim: only one runner may process a quote. A lost claim means a
  // concurrent run (or a state change) got there first — touching the card
  // again risks a double charge (#H2884, 2026-06-10).
  const claimed = await claimGfBalanceCharge(quote.id, quote.balance_charge_attempts || 0);
  if (!claimed) {
    console.warn(`[group-balance-charge] quote=${quote.id} claim lost — skipping`);
    return "skipped";
  }

  if (quote.balance_cents <= 0) {
    // Full-prepay (booked within 96h): entire amount taken at deposit, gift card already
    // loaded. Nothing to charge — advance status so the day-of payout/close crons run.
    // Without this, prepaid events stay 'deposit_paid' forever and never pay out day-of.
    await updateGfBalancePrepaid(quote.id);
    return "auto_charged";
  }

  // Staleness check: warn if quote hasn't been updated in 30+ days
  const daysSinceUpdate = (Date.now() - new Date(quote.updated_at).getTime()) / 86_400_000;
  if (daysSinceUpdate > 30) {
    console.warn(
      `[group-balance-charge] STALE quote=${quote.id} last updated ${Math.round(daysSinceUpdate)}d ago — charging anyway but event data may be outdated`,
    );
  }

  const baseKey = randomBytes(8).toString("hex");

  // Service charge is collected on the deposit first; only the remainder (usually $0)
  // lands on the balance. Break it out so the portal's Service Charges page detects it.
  const serviceChargeCents = serviceChargeCentsFromLineItems(quote.line_items);
  const balanceServiceCharge = Math.max(
    0,
    serviceChargeCents - Math.min(serviceChargeCents, quote.deposit_due_cents),
  );

  // Captured from a Square payment decline in Path A so Path B can persist the reason
  // + send the card-declined notification (vs the generic "no card on file" link).
  let declineCode: string | null = null;
  let declineDetail: string | null = null;

  // Path A: auto-charge saved card
  if (mode === "auto" && quote.saved_card_id && quote.square_customer_id) {
    let chargeCaptured = false;
    try {
      let balanceOrderId: string | undefined;
      let balancePaymentId: string | undefined;
      let resumedPayment = false;

      // Resume: a prior run's charge CAPTURED but fulfillment failed (persist-first
      // marker present, quote not marked paid). Re-charging would double-bill.
      if (quote.square_balance_payment_id && !quote.balance_paid_at) {
        try {
          const pRes = await fetch(
            `${SQUARE_BASE}/payments/${encodeURIComponent(quote.square_balance_payment_id)}`,
            { headers: sqHeaders() },
          );
          const pData = await pRes.json();
          if (
            pRes.ok &&
            pData.payment?.status === "COMPLETED" &&
            (pData.payment.amount_money?.amount ?? 0) === quote.balance_cents
          ) {
            balancePaymentId = pData.payment.id as string;
            balanceOrderId = quote.square_balance_order_id || (pData.payment.order_id as string);
            resumedPayment = true;
            chargeCaptured = true;
            console.log(
              `[group-balance-charge] RESUME quote=${quote.id} payment=${balancePaymentId} — skipping charge`,
            );
          }
        } catch {
          /* lookup failed — proceed with a fresh charge */
        }
      }

      if (!balancePaymentId) {
        // Create balance order
        const orderRes = await fetch(`${SQUARE_BASE}/orders`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-bal-order-${baseKey}`,
            order: {
              location_id: quote.square_location_id,
              reference_id: `GF Balance: ${quote.event_number || ""}`.slice(0, 40),
              line_items: buildPaymentLineItems(
                "Group Event Balance",
                quote.balance_cents,
                balanceServiceCharge,
              ),
            },
          }),
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok || !orderData.order?.id) {
          throw new Error(`Balance order failed: ${JSON.stringify(orderData).slice(0, 200)}`);
        }
        balanceOrderId = orderData.order.id as string;

        // Charge saved card
        const payRes = await fetch(`${SQUARE_BASE}/payments`, {
          method: "POST",
          headers: sqHeaders(),
          body: JSON.stringify({
            idempotency_key: `gf-bal-pay-${baseKey}`,
            source_id: quote.saved_card_id,
            amount_money: { amount: quote.balance_cents, currency: "USD" },
            order_id: balanceOrderId,
            location_id: quote.square_location_id,
            customer_id: quote.square_customer_id,
            autocomplete: true,
            note: `GF Balance: ${quote.event_name || ""} (${quote.event_number || ""})`,
          }),
        });
        const payData = await payRes.json();
        if (!payRes.ok || payData.errors) {
          const sqErr = payData.errors?.[0];
          declineCode = sqErr?.code || "CHARGE_FAILED";
          declineDetail = sqErr?.detail || null;
          throw new Error(`Balance charge failed: ${declineCode}`);
        }
        balancePaymentId = payData.payment?.id as string;
        chargeCaptured = true;

        // Persist-first: a fulfillment failure below resumes from THIS payment on
        // the next run instead of re-charging the saved card.
        await updateGfBalanceChargeCaptured(quote.id, {
          square_balance_order_id: balanceOrderId,
          square_balance_payment_id: balancePaymentId,
        });
      }

      // LOAD gift cards with balance amount ($2k max per card; overflow → new cards).
      // Resume-idempotent: only the portion this payment hasn't already loaded goes on.
      const knownGiftCardIds = parseGiftCardIds(quote.square_gift_card_id);
      const alreadyLoaded = resumedPayment
        ? await sumGiftCardLoadsForPayment({
            giftCardIds: knownGiftCardIds,
            paymentId: balancePaymentId,
          })
        : 0;
      const remainingToLoad = Math.max(0, quote.balance_cents - alreadyLoaded);
      if (remainingToLoad > 0) {
        const loaded = await loadBalanceOntoGiftCards({
          giftCardIds: knownGiftCardIds,
          locationId: quote.square_location_id,
          amountCents: remainingToLoad,
          baseKey,
          buyerPaymentInstrumentIds: [balancePaymentId],
        });
        if (loaded.createdCards.length) {
          await updateGfGiftCardList(quote.id, {
            giftCardIds: loaded.giftCardIds,
            giftCardGans: [
              ...parseGiftCardGans(quote.square_gift_card_gan),
              ...loaded.createdCards.map((c) => c.gan ?? ""),
            ],
          });
        }
      }

      await updateGfBalanceCharged(quote.id, {
        square_balance_order_id: balanceOrderId ?? "",
        square_balance_payment_id: balancePaymentId,
        balance_paid_at: new Date().toISOString(),
        balance_payment_method: "auto_card",
      });

      // Single point: confirm BMI + record the balance payment (non-fatal). The
      // "Balance charged via saved card" private note is appended below.
      const { confirmAndRecordBmiPayment } = await import("@/lib/bmi-office-actions");
      await confirmAndRecordBmiPayment({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        lineItems: (quote.line_items || []) as Array<{ name: string }>,
        amountDollars: quote.balance_cents / 100,
        source: "gf-balance-charge-cron",
        quoteId: quote.id,
        sourceRef: balancePaymentId,
      });

      console.log(
        `[group-balance-charge] auto-charged quote=${quote.id} ` +
          `amount=${quote.balance_cents} payment=${balancePaymentId}`,
      );

      // Send receipt email with card last4. The waiver link is resolved inside
      // notifyBalanceReceipt now (lib/waiver-link-send) — no BMI Office lookup, and
      // it is only minted when the event actually needs waivers.
      (async () => {
        let cardLast4: string | undefined;
        // Get card last4 from the payment
        try {
          const payRes = await fetch(`${SQUARE_BASE}/payments/${balancePaymentId}`, {
            headers: sqHeaders(),
          });
          if (payRes.ok) {
            const payData = await payRes.json();
            cardLast4 = payData.payment?.card_details?.card?.last_4;
          }
        } catch {
          /* non-fatal */
        }
        await notifyBalanceReceipt(
          {
            ...quote,
            balance_cents: 0,
            balance_paid_at: new Date().toISOString(),
            balance_payment_method: "auto_card",
          },
          cardLast4,
        );
      })().catch((err) => console.error("[group-balance-charge] receipt notify error:", err));

      try {
        const { appendProjectPrivateNote, noteTimestamp } =
          await import("@/lib/bmi-office-actions");
        await appendProjectPrivateNote({
          centerCode: quote.center_code,
          projectId: quote.bmi_reservation_id,
          note:
            `[${noteTimestamp()}] Balance charged: $${(quote.balance_cents / 100).toFixed(2)} via saved card` +
            actorSuffix(opts),
        });
      } catch {
        /* non-fatal */
      }

      firePortalWebhookAsync("payment.balance_charged", {
        documentId: quote.contract_short_id,
        bmiCode: quote.bmi_reservation_id,
        venue: quote.center_code,
        status: "balance_charged",
      });

      return "auto_charged";
    } catch (err) {
      console.error(`[group-balance-charge] auto-charge failed for quote=${quote.id}:`, err);

      // Contract-history ledger row (surfaces on the admin Contract tab timeline).
      {
        const errMsg = err instanceof Error ? err.message : String(err);
        const { isCardDeclineCode } = await import("@/lib/square-decline");
        appendAuditLog({
          quoteId: quote.id,
          event:
            declineCode && isCardDeclineCode(declineCode)
              ? "balance_declined"
              : "balance_payment_failed",
          actorEmail: opts.actor ?? undefined,
          metadata: {
            code: declineCode ?? "UNKNOWN",
            error: (declineDetail || errMsg).slice(0, 300),
            amountCents: quote.balance_cents,
            attempt: (quote.balance_charge_attempts || 0) + 1,
            chargeCaptured,
            source: auditSource(opts),
            reason: opts.reason ?? undefined,
          },
        }).catch((e) => console.error("[group-balance-charge] audit log error:", e));
      }

      if (chargeCaptured) {
        // Money captured but fulfillment failed — do NOT send a "balance due"
        // link (it invites a second payment). The persist-first marker makes the
        // next cron run resume + finalize without charging; alert ops meanwhile.
        try {
          const { notifyDispatchError } = await import("@/lib/group-function-alert");
          await notifyDispatchError({
            reservationId: quote.bmi_reservation_id,
            centerName: quote.center_name,
            plannerEmail: quote.planner_email ?? undefined,
            error: new Error(
              `Balance CAPTURED for "${quote.event_name}" but fulfillment failed (will auto-resume next run): ${err instanceof Error ? err.message : String(err)}`,
            ),
          });
        } catch {
          /* alert is best-effort */
        }
        const { sql } = await import("@/lib/db");
        const q = sql();
        await q`UPDATE group_function_quotes SET
          balance_charge_attempts = balance_charge_attempts + 1,
          balance_last_error = ${`CAPTURED_FINALIZE_FAILED: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)},
          updated_at = NOW()
        WHERE id = ${quote.id}`.catch(() => {});
        return "skipped";
      }
      // Fall through to payment link
    }
  }

  // Path B: send the guest to our self-hosted balance payment page.
  // Square-hosted payment links are retired here: a paid quick-pay link's
  // backing order can sit OPEN forever and the DB only learns via the
  // reconcile poller (the #H2821 stuck-paid failure). Our page charges via
  // /api/group-function/balance-pay, which updates the DB synchronously.
  try {
    if (!quote.contract_short_id) {
      throw new Error(`quote=${quote.id} has no contract_short_id — cannot build pay page URL`);
    }
    const paymentLinkUrl = `${quote.base_url || "https://fasttraxent.com"}/contract/${quote.contract_short_id}/pay`;

    const updated = await updateGfBalanceLinkSent(quote.id, {
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
      balance_charge_attempts: (quote.balance_charge_attempts || 0) + 1,
      balance_last_error:
        mode === "link"
          ? `Payment page sent on request${opts.actor ? ` by ${opts.actor}` : ""}`
          : quote.saved_card_id
            ? "Auto-charge failed, sent payment page"
            : "No saved card, sent payment page",
    });
    if (updated === 0) {
      // Quote already advanced (paid by a concurrent runner / the pay page) —
      // a "balance due" notification now would be wrong and risks double-pay.
      console.warn(
        `[group-balance-charge] quote=${quote.id} already paid — suppressing balance-due link`,
      );
      return "skipped";
    }

    // A saved card that the issuer DECLINED → persist the reason + send the
    // card-declined notification (clear "your card ending in X was declined, here's
    // why, retry or use another card"). A missing-card / non-decline failure keeps the
    // generic balance-due link.
    const wasCardDecline = Boolean(quote.saved_card_id) && declineCode !== null;
    let declineMessage: string | null = null;
    if (wasCardDecline) {
      const { friendlyDeclineMessage } = await import("@/lib/square-decline");
      declineMessage = friendlyDeclineMessage(declineCode, declineDetail);
      const { recordGfBalanceDecline } = await import("@/lib/group-function-db");
      await recordGfBalanceDecline(quote.id, {
        code: declineCode!,
        message: declineMessage,
      }).catch((err) => console.error("[group-balance-charge] recordDecline error:", err));
    }

    console.log(
      `[group-balance-charge] payment link sent for quote=${quote.id} url=${paymentLinkUrl}` +
        (wasCardDecline ? ` (card declined: ${declineCode})` : ""),
    );

    const notifyQuote = {
      ...quote,
      balance_payment_link_url: paymentLinkUrl,
      balance_link_sent_at: new Date().toISOString(),
      balance_decline_code: declineCode,
      balance_decline_message: declineMessage,
    };
    if (wasCardDecline) {
      const { notifyCardDeclined } = await import("@/lib/group-function-notify");
      notifyCardDeclined(notifyQuote, declineMessage!).catch((err) =>
        console.error("[group-balance-charge] card-declined notify error:", err),
      );
    } else {
      notifyBalanceLinkSent(notifyQuote).catch((err) =>
        console.error("[group-balance-charge] notify error:", err),
      );
    }

    try {
      const { appendProjectPrivateNote, noteTimestamp } = await import("@/lib/bmi-office-actions");
      await appendProjectPrivateNote({
        centerCode: quote.center_code,
        projectId: quote.bmi_reservation_id,
        note: wasCardDecline
          ? `[${noteTimestamp()}] Card DECLINED ($${(quote.balance_cents / 100).toFixed(2)}): ${declineCode} — ${declineMessage}. Pay link sent.`
          : mode === "link"
            ? `[${noteTimestamp()}] Balance link sent: $${(quote.balance_cents / 100).toFixed(2)}${actorSuffix(opts)}`
            : `[${noteTimestamp()}] Balance link sent: $${(quote.balance_cents / 100).toFixed(2)} (auto-charge failed)`,
      });
    } catch {
      /* non-fatal */
    }

    firePortalWebhookAsync("payment.balance_link_sent", {
      documentId: quote.contract_short_id,
      bmiCode: quote.bmi_reservation_id,
      venue: quote.center_code,
      status: "balance_link_sent",
    });

    return "link_sent";
  } catch (err) {
    console.error(`[group-balance-charge] payment link failed for quote=${quote.id}:`, err);
    throw err;
  }
}
