import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { finishEditEvent, getEditEvent } from "@/lib/reservation-edit-log";
import { buildEditPlan } from "~/features/reservation-edit/plan";
import {
  payLinkExpired,
  payLinkExpiresAtMs,
  verifyPayLinkToken,
} from "~/features/reservation-edit/pay-link";
import { EditGuardError, type EditSettlement, type EditSpec } from "~/features/reservation-edit";
import type { PaymentSourceKind } from "~/features/card-vault";

export const maxDuration = 60;

/**
 * Self-hosted payment-difference link backend (guest-facing, token-gated).
 *
 * GET  /api/edit-payments/{editId}?t={token}
 *   → { guestName, amountDueCents, expiresAt, state } for the pay page.
 *
 * POST /api/edit-payments/{editId}
 *   Body: { token, cardNonce, sourceKind?, saveCardConsent? }
 *   Completes the pending_payment edit: verifies the token + expiry, rebuilds
 *   the plan from the stored spec, refuses when the reservation moved since
 *   the link was created (planHash mismatch → staff re-run the edit), then
 *   resumes the SAME edit attempt with the guest's card nonce as the source.
 *   `sourceKind` / `saveCardConsent` are PaymentForm's tokenize tags — they
 *   drive the card-vault capture (a wallet is skipped, a ticked "save my card"
 *   becomes permanent consent) instead of a hard-coded 'card' / false.
 */

const SOURCE_KINDS: ReadonlySet<string> = new Set<PaymentSourceKind>([
  "card",
  "wallet",
  "saved",
  "gift_card",
]);

/** Unknown / missing → undefined, so the vault's "no_source_kind" skip applies
 *  to a stale bundle rather than guessing a wallet into CreateCard. */
const parseSourceKind = (v: unknown): PaymentSourceKind | undefined =>
  typeof v === "string" && SOURCE_KINDS.has(v) ? (v as PaymentSourceKind) : undefined;

const loadPending = async (
  editId: string,
  token: string,
): Promise<
  | { ok: true; event: NonNullable<Awaited<ReturnType<typeof getEditEvent>>> }
  | { ok: false; res: NextResponse }
> => {
  if (!verifyPayLinkToken(editId, token)) {
    return { ok: false, res: NextResponse.json({ error: "invalid_link" }, { status: 403 }) };
  }
  const event = await getEditEvent(editId);
  if (!event) {
    return { ok: false, res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (event.state === "completed") {
    return { ok: false, res: NextResponse.json({ error: "already_paid" }, { status: 409 }) };
  }
  if (event.state !== "pending_payment") {
    return { ok: false, res: NextResponse.json({ error: "link_void" }, { status: 410 }) };
  }
  return { ok: true, event };
};

const eventTimesMs = async (
  event: NonNullable<Awaited<ReturnType<typeof getEditEvent>>>,
): Promise<{ createdAtMs: number; eventAtMs: number | null; guestName: string }> => {
  const anchor = await getBowlingReservation(event.anchorReservationId);
  const eventAtMs = anchor?.bookedAt ? new Date(anchor.bookedAt).getTime() : null;
  return {
    createdAtMs: new Date(event.createdAt).getTime(),
    eventAtMs: Number.isFinite(eventAtMs) ? eventAtMs : null,
    guestName: anchor?.guestName ?? "Guest",
  };
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ editId: string }> }) {
  const { editId } = await ctx.params;
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const loaded = await loadPending(editId, token);
  if (!loaded.ok) return loaded.res;
  const { event } = loaded;

  const { createdAtMs, eventAtMs, guestName } = await eventTimesMs(event);
  if (payLinkExpired(createdAtMs, eventAtMs, Date.now())) {
    return NextResponse.json({ error: "link_expired" }, { status: 410 });
  }

  return NextResponse.json({
    guestName,
    amountDueCents: event.diffCents,
    expiresAt: new Date(payLinkExpiresAtMs(createdAtMs, eventAtMs)).toISOString(),
    state: event.state,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ editId: string }> }) {
  const { editId } = await ctx.params;
  let body: {
    token?: unknown;
    cardNonce?: unknown;
    sourceKind?: unknown;
    saveCardConsent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const cardNonce = typeof body.cardNonce === "string" ? body.cardNonce : "";
  if (!cardNonce) return NextResponse.json({ error: "card_required" }, { status: 400 });
  const sourceKind = parseSourceKind(body.sourceKind);
  const permanentConsent = body.saveCardConsent === true;

  const loaded = await loadPending(editId, token);
  if (!loaded.ok) return loaded.res;
  const { event } = loaded;

  const { createdAtMs, eventAtMs } = await eventTimesMs(event);
  if (payLinkExpired(createdAtMs, eventAtMs, Date.now())) {
    // Void the attempt so its key namespace retires and staff re-run cleanly.
    await finishEditEvent(editId, { state: "failed", error: "link_expired" });
    return NextResponse.json({ error: "link_expired" }, { status: 410 });
  }

  try {
    // Rebuild the plan from the STORED spec — the reservation must not have
    // moved since the link was created (the stored plan pinned the hash).
    const storedHash = (event.plan as { planHash?: string } | null)?.planHash;
    const plan = await buildEditPlan({
      neonId: event.anchorReservationId,
      spec: (event.spec ?? {}) as EditSpec,
      settlement: (event.settlement === "store_credit"
        ? "store_credit"
        : event.settlement === "card_refund"
          ? "card_refund"
          : undefined) as EditSettlement | undefined,
      paymentSource: { kind: "payment_link" },
    });
    if (storedHash && storedHash !== plan.planHash) {
      await finishEditEvent(editId, { state: "failed", error: "plan_stale_at_payment" });
      return NextResponse.json(
        { error: "plan_stale", detail: "the reservation changed — ask the venue to resend a link" },
        { status: 409 },
      );
    }

    const { executeEditCascade } = await import("~/features/reservation-edit/service");
    const result = await executeEditCascade({
      plan,
      paymentSource: { kind: "nonce", token: cardNonce },
      notifyGuest: true,
      actor: "guest",
      origin: req.nextUrl.origin,
      resumeEditId: editId,
    });

    // Vault the card the guest just used (best-effort, silent — same rules
    // as booking capture; never fails the edit).
    if (result.paymentIds.length > 0) {
      try {
        const anchor = await getBowlingReservation(event.anchorReservationId);
        if (anchor?.squareCustomerId) {
          const { captureCardFromDeposit } = await import("~/features/card-vault");
          await captureCardFromDeposit({
            squareCustomerId: anchor.squareCustomerId,
            paymentId: result.paymentIds[0],
            reservationId: anchor.id,
            depositOrderId: anchor.squareDepositOrderId ?? null,
            baseKey: editId.replace(/[^a-z0-9]/gi, "").slice(0, 16),
            sourceKind,
            permanentConsent,
          });
        }
      } catch {
        /* capture is always best-effort */
      }
    }

    return NextResponse.json({
      ok: true,
      state: result.state,
      chargedCents: result.diffCents,
    });
  } catch (err) {
    if (err instanceof EditGuardError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[edit-payments] ${editId} failed:`, msg);
    return NextResponse.json({ error: "payment_failed", detail: msg }, { status: 502 });
  }
}
