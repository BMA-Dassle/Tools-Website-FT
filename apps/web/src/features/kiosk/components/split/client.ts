/**
 * Client fetch helpers for the kiosk gift-card (split-tender v1) routes.
 * Every call carries the prepare-minted splitToken — the seed alone is not a
 * secret. Money amounts always come back from the server; the client never
 * computes what a card is worth.
 */

export interface GiftCardLookupResult {
  ok: true;
  lookupToken: string;
  balanceCents: number;
  last4: string;
}

export async function lookupGiftCard(params: {
  seed: string;
  splitToken: string;
  gan: string;
}): Promise<GiftCardLookupResult | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/kiosk/gift-card-lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? "lookup failed" };
    return data as GiftCardLookupResult;
  } catch {
    return { ok: false, error: "network" };
  }
}

export interface AppliedTender {
  /** Keys the board row's per-tender Remove. */
  paymentId?: string;
  ganLast4: string;
  amountCents: number;
}

export async function addGiftCardTender(params: {
  seed: string;
  splitToken: string;
  lookupToken: string;
}): Promise<
  | { ok: true; tender: AppliedTender; remainingCents: number }
  | { ok: false; error: string; code?: string }
> {
  try {
    const res = await fetch("/api/kiosk/deposit-tenders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? "apply failed", code: data.code };
    }
    return data;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function removeGiftCardTender(params: {
  seed: string;
  splitToken: string;
  /** Void ONLY this tender (the ambient board's per-row Remove); absent =
   *  the legacy full unwind (every hold voided). */
  paymentId?: string;
}): Promise<{ ok: boolean; remainingCents?: number }> {
  try {
    const qs = new URLSearchParams({ seed: params.seed, splitToken: params.splitToken });
    if (params.paymentId) qs.set("paymentId", params.paymentId);
    const res = await fetch(`/api/kiosk/deposit-tenders?${qs.toString()}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, remainingCents: data.remainingCents };
  } catch {
    return { ok: false };
  }
}

/** One authorized tender as the server's status/poll routes report it. */
export interface BoardTender {
  kind: "gift_card" | "terminal";
  isGiftCard: boolean;
  paymentId?: string;
  last4?: string;
  amountCents: number;
}

/** Resume state after a refresh/crash — the ambient board rebuilds from this. */
export async function getSplitStatus(params: { seed: string; splitToken: string }): Promise<
  | {
      ok: true;
      status: {
        totalCents: number;
        remainingCents: number;
        tenders: BoardTender[];
        capturedAt?: string;
      };
    }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(
      `/api/kiosk/deposit-tenders?seed=${encodeURIComponent(params.seed)}&splitToken=${encodeURIComponent(params.splitToken)}`,
    );
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? "status failed" };
    return data;
  } catch {
    return { ok: false, error: "network" };
  }
}

/** Fire-and-forget release of every un-captured hold — used by unmount /
 *  idle-reset. keepalive so a page teardown still delivers it. */
export function abandonSplit(params: { seed: string; splitToken: string }): void {
  try {
    void fetch("/api/kiosk/deposit-tenders/abandon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort — the server sweep / Square auto-void backstop covers it */
  }
}

export async function captureSplit(params: {
  seed: string;
  splitToken: string;
}): Promise<
  { ok: true; paymentIds: string[]; primaryPaymentId: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch("/api/kiosk/deposit-tenders/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? "capture failed" };
    return data;
  } catch {
    return { ok: false, error: "network" };
  }
}
