"use client";

/**
 * Game Zone card FULFILLMENT on the kiosk confirmation screen — the "you're
 * booked" page also dispenses/loads the cards bought WITH the booking (owner
 * 2026-07-18: "we're combining the you're-booked and card-dispense screen").
 *
 * Reads the charged row pointers checkout stashed (gz-fulfillment.ts) and runs
 * the SAME per-card sequence as the standalone Game Zone flow:
 *   new_card — dispense → read → bridge-load (SOAP fallback server-side via
 *              /load-card preLoaded) → present → wait for pickup; a failed load
 *              captures the blank (never hand over an empty card).
 *   reload   — bridge-load each card the guest already holds + report.
 * Rows are already CHARGED in the ledger, so any failure here recovers forward
 * via the reconcile cron — the guest's money is never stranded, never re-charged.
 *
 * Owns its own CRT-591 connection (the Game Zone screen is long unmounted);
 * auto-reconnects silently on a provisioned kiosk. The parent pauses its
 * auto-reset while this is busy.
 */
import { useEffect, useRef, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { useGameCardDispenser } from "../card-reader";
import { creditTokensViaBridge } from "../service/game-card-bridge";
import { clearGzFulfillment, type GzFulfillmentPayload } from "../service/gz-fulfillment";

/** Mag reads pad the account with leading zeros; guests know the printed
 *  (unpadded) form. Display-only — API calls keep the raw value. */
function displayCardNumber(acct: string): string {
  return acct.replace(/^0+(?=\d)/, "");
}

type CardStatus = "waiting" | "dispensing" | "loading" | "take" | "done" | "failed";

interface CardRow {
  txnId: string;
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
  status: CardStatus;
}

const STATUS_LABEL: Record<CardStatus, string> = {
  waiting: "Waiting…",
  dispensing: "Dispensing…",
  loading: "Loading tokens…",
  take: "Take your card",
  done: "Loaded ✓",
  failed: "See an attendant",
};

export function KioskGzFulfillment({
  payload,
  onBusyChange,
}: {
  payload: GzFulfillmentPayload;
  /** True while cards are still coming out — parent pauses its auto-reset. */
  onBusyChange: (busy: boolean) => void;
}) {
  const { config } = useKioskConfig();
  const dispenser = useGameCardDispenser({ config });
  const [rows, setRows] = useState<CardRow[]>(
    payload.cards.map((c) => ({
      txnId: c.txnId,
      accountNumber: c.accountNumber,
      tokens: c.tokens + (c.bonusTokens || 0),
      bonusTokens: c.bonusTokens,
      status: "waiting",
    })),
  );
  const [note, setNote] = useState<string | null>(null);
  const startedRef = useRef(false);

  const setRow = (i: number, patch: Partial<CardRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Run ONCE. Reloads need only the on-prem bridge; new cards wait for the
  // dispenser connection (silent auto-reconnect) before starting.
  const ready = payload.mode === "reload" || dispenser.ready;
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    onBusyChange(true);

    const loadCard = async (
      txnId: string,
      accountNumber: string,
      tokens: number,
      bonusTokens: number,
    ): Promise<{ loaded: boolean; balanceTokens?: number }> => {
      // On-prem bridge FIRST (fast local EIS); /load-card records it (preLoaded)
      // or falls back to cloud SOAP server-side — never both, no double-credit.
      const bridged = await creditTokensViaBridge({ accountNumber, tokens, bonusTokens });
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId: payload.groupId,
            txnId,
            accountNumber,
            locationCode: payload.locationCode,
            preLoaded: bridged,
          }),
        });
        const data = await res.json();
        return { loaded: res.ok && data.loaded === true, balanceTokens: data.balance?.tokens };
      } catch {
        return { loaded: false };
      }
    };

    void (async () => {
      try {
        if (payload.mode === "reload") {
          // Cards are already in the guest's hand — credit each + report.
          for (let i = 0; i < payload.cards.length; i++) {
            const c = payload.cards[i];
            setRow(i, { status: "loading" });
            const { loaded } = await loadCard(c.txnId, c.accountNumber, c.tokens, c.bonusTokens);
            // A failed report leaves the row pending — the reconcile cron loads
            // it via cloud SOAP shortly. Paid tokens always arrive.
            setRow(i, { status: loaded ? "done" : "failed" });
            if (!loaded) setNote("A card will finish loading in a few minutes — it's paid for.");
          }
        } else {
          for (let i = 0; i < payload.cards.length; i++) {
            const c = payload.cards[i];
            setRow(i, { status: "dispensing" });
            const account = await dispenser.dispenseAndRead();
            if (!account) {
              setRow(i, { status: "failed" });
              setNote(
                dispenser.error?.message ??
                  "We couldn't dispense a card. Your payment is safe — please see an attendant.",
              );
              return;
            }
            setRow(i, { accountNumber: account, status: "loading" });
            const { loaded, balanceTokens } = await loadCard(
              c.txnId,
              account,
              c.tokens,
              c.bonusTokens,
            );
            if (!loaded) {
              // Never hand over an unloaded blank — bin it; the row recovers forward.
              await dispenser.capture();
              setRow(i, { status: "failed" });
              setNote(
                "A card couldn't be loaded and was retained. Your payment is safe — please see an attendant.",
              );
              return;
            }
            setRow(i, {
              status: "take",
              ...(balanceTokens != null ? { tokens: balanceTokens } : {}),
            });
            await dispenser.present();
            await dispenser.waitTaken({ timeoutMs: 30_000 });
            setRow(i, { status: "done" });
          }
        }
      } finally {
        clearGzFulfillment();
        onBusyChange(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="relative w-full max-w-[860px] rounded-[24px] border border-[#f800c6]/40 bg-white/[0.04] p-[32px] text-left">
      <div className="k-eyebrow text-[#f800c6]">
        {payload.mode === "new_card" ? "Your Game Zone cards" : "Loading your Game Zone cards"}
      </div>
      {payload.mode === "new_card" && (
        <p className="mt-[6px] text-[24px] text-white/55">
          Take each card from the dispenser as it comes out.
        </p>
      )}
      <div className="mt-[16px] space-y-[10px]">
        {rows.map((r, i) => (
          <div
            key={r.txnId}
            className="flex items-center justify-between rounded-2xl border border-white/12 bg-white/[0.03] px-[24px] py-[16px]"
          >
            <div className="min-w-0">
              <div className="text-[18px] font-bold uppercase tracking-[0.25em] text-white/40">
                Card {i + 1}
              </div>
              <div className="text-[28px] font-extrabold tabular-nums">
                {r.accountNumber ? `#${displayCardNumber(r.accountNumber)}` : "—"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[26px] font-extrabold tabular-nums text-[#00e2e5]">
                {r.tokens} tk
              </div>
              <div
                className={`text-[20px] ${
                  r.status === "failed"
                    ? "text-red-300"
                    : r.status === "done"
                      ? "text-[#46d68c]"
                      : r.status === "take"
                        ? "text-[#f0b341]"
                        : "text-white/50"
                }`}
              >
                {STATUS_LABEL[r.status]}
              </div>
            </div>
          </div>
        ))}
      </div>
      {payload.mode === "new_card" && !dispenser.ready && !startedRef.current && (
        <p className="mt-[12px] text-[22px] text-amber-300/80">
          Connecting to the card dispenser… if this doesn&rsquo;t start, see an attendant — your
          cards are paid for.
        </p>
      )}
      {note && <p className="mt-[12px] text-[22px] text-amber-300/80">{note}</p>}
    </div>
  );
}
