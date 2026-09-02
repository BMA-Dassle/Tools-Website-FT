"use client";

/**
 * /kiosk/staff — Card loads tab. Three tools in one panel:
 *
 *  1. THIS kiosk's recent card sales from the ledger (`intercard_transactions`,
 *     scoped by the new kiosk_id column), each with a truthful outcome chip
 *     (loadOutcome) and the transport that actually delivered the credit.
 *     A center-wide toggle exists because rows written before kiosk_id shipped
 *     are NULL — and because guests walk over from the other machine.
 *  2. Card lookup — live Intercard balance + real on-card history (the
 *     router's accountHistory, which asks the onsite relay explicitly).
 *  3. Clear card — TPI_ClearAccount behind the server's money guards: balance
 *     shown first, value-holding cards refused without an explicit override,
 *     confirmation by typing the full account number, never retried on an
 *     ambiguous outcome (the server logs it and says to re-read the card).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { staffFetch } from "./KioskStaff";
import { loadOutcome } from "../staff/outcome";
import type { TxnRow } from "../../game-cards/data/transactions-log";
import type { CardTxn, VerifyResult } from "../../game-cards/types";
import { centerCodeFor } from "~/config/intercard-centers";
import type { Brand } from "~/features/booking";

const POLL_MS = 30_000;

const KIND_LABEL: Record<string, string> = {
  new_card: "New card",
  reload: "Reload",
  voucher: "Voucher card",
  voucher_reload: "Voucher reload",
};

const TONE_CHIP: Record<string, string> = {
  good: "bg-[#46d68c]/20 text-[#46d68c]",
  warn: "bg-amber-400/20 text-amber-200",
  bad: "bg-red-400/20 text-red-200",
  idle: "bg-white/10 text-white/50",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface CardView {
  verify: VerifyResult & { transport?: string };
  /** null = the history read failed (distinct from a card with no activity). */
  transactions: CardTxn[] | null;
  historyTransport: string;
  onsiteStatus: string;
}

export function KioskStaffCardLoads({
  pin,
  kioskId,
  center,
  brand,
}: {
  pin: string;
  kioskId: string | null;
  center: string | null;
  brand: Brand | null;
}) {
  const locationCode = center && brand ? centerCodeFor(center, brand) : null;

  const [rows, setRows] = useState<TxnRow[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [centerWide, setCenterWide] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);

  const [account, setAccount] = useState("");
  const [card, setCard] = useState<CardView | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const [confirmAccount, setConfirmAccount] = useState("");
  const [override, setOverride] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadRows = useCallback(
    async (wide: boolean) => {
      if (!kioskId || locationCode == null) return;
      setLoadingRows(true);
      const { ok, data } = await staffFetch(
        pin,
        `/api/kiosk/staff?action=loads&kioskId=${encodeURIComponent(kioskId)}&locationCode=${locationCode}&centerWide=${wide ? "1" : "0"}`,
      );
      if (!aliveRef.current) return;
      setLoadingRows(false);
      if (!ok) {
        setRowsError(typeof data?.error === "string" ? data.error : "Couldn't read the ledger.");
        return;
      }
      setRowsError(null);
      setRows(data.rows as TxnRow[]);
    },
    [pin, kioskId, locationCode],
  );

  // Load on open + 30s poll while visible (a fresh sale shows up on its own).
  useEffect(() => {
    // Deferred past the synchronous effect body (react-hooks/set-state-in-effect).
    void (async () => {
      await Promise.resolve();
      if (aliveRef.current) await loadRows(centerWide);
    })();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadRows(centerWide);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadRows, centerWide]);

  const lookUp = useCallback(
    async (acct: string) => {
      const a = acct.trim();
      if (!/^\d{3,20}$/.test(a) || locationCode == null) {
        setCardError("Enter the card's account number (digits only).");
        return;
      }
      setLookingUp(true);
      setCardError(null);
      setClearMsg(null);
      setConfirmAccount("");
      setOverride(false);
      const { ok, data } = await staffFetch(
        pin,
        `/api/kiosk/staff?action=card&account=${encodeURIComponent(a)}&locationCode=${locationCode}`,
      );
      if (!aliveRef.current) return;
      setLookingUp(false);
      if (!ok) {
        setCard(null);
        setCardError(typeof data?.error === "string" ? data.error : "Lookup failed.");
        return;
      }
      setAccount(a);
      setCard(data as CardView);
    },
    [pin, locationCode],
  );

  const clearCard = useCallback(async () => {
    if (!card || locationCode == null || clearing) return;
    setClearing(true);
    setClearMsg(null);
    const { ok, data } = await staffFetch(pin, "/api/kiosk/staff", {
      method: "POST",
      body: JSON.stringify({
        action: "clear-card",
        accountNumber: card.verify.accountNumber,
        confirmAccount: confirmAccount.trim(),
        locationCode,
        kioskId,
        override,
      }),
    });
    if (!aliveRef.current) return;
    setClearing(false);
    if (ok) {
      setClearMsg({ ok: true, text: "Cleared. Re-checking the card…" });
      // Prove it: the follow-up read should say the account no longer exists.
      void lookUp(card.verify.accountNumber);
    } else {
      setClearMsg({
        ok: false,
        text: typeof data?.error === "string" ? data.error : "Clear failed.",
      });
    }
  }, [pin, card, confirmAccount, override, locationCode, kioskId, clearing, lookUp]);

  const balance = card?.verify.balance;
  const holdsValue =
    !!card?.verify.exists &&
    ((balance?.tokens ?? 0) > 0 ||
      (balance?.bonusTokens ?? 0) > 0 ||
      (balance?.eTickets ?? 0) > 0 ||
      (balance?.timeMinutes ?? 0) > 0 ||
      (card?.verify.cashBalance ?? 0) > 0);

  if (!kioskId || locationCode == null) {
    return (
      <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 px-5 py-4 text-sm text-amber-200">
        This device has no kiosk identity, so there is no &quot;this kiosk&quot; ledger to show.
        Provision it in Kiosk admin (Device tab) first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Card lookup ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
        <div className="text-sm font-bold uppercase tracking-widest text-white/40">Card lookup</div>
        <div className="mt-3 flex gap-2">
          <input
            inputMode="numeric"
            data-osk-layout="numeric"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void lookUp(account)}
            placeholder="Account number (type or swipe)"
            className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 font-mono text-lg text-white focus:border-[#46d68c] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void lookUp(account)}
            disabled={lookingUp}
            className="rounded-xl bg-[#46d68c] px-5 py-3 text-sm font-bold text-[#04250f] disabled:opacity-40"
          >
            {lookingUp ? "Checking…" : "Look up"}
          </button>
        </div>
        {cardError && <p className="mt-2 text-sm text-red-300">{cardError}</p>}

        {card && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg font-bold">{card.verify.accountNumber}</span>
              {card.verify.name && <span className="text-white/70">{card.verify.name}</span>}
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                  card.verify.exists ? TONE_CHIP.good : TONE_CHIP.bad
                }`}
              >
                {card.verify.exists
                  ? "Active"
                  : card.verify.notFound === "confirmed"
                    ? "No such account"
                    : "Unknown (Intercard error)"}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${TONE_CHIP.idle}`}
              >
                {card.onsiteStatus === "onsite"
                  ? "onsite relay up"
                  : `onsite: ${card.onsiteStatus}`}
              </span>
            </div>

            {card.verify.exists && (
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  ["Tokens", balance?.tokens ?? 0],
                  ["Bonus", balance?.bonusTokens ?? 0],
                  ["eTickets", balance?.eTickets ?? 0],
                  ["Time (min)", balance?.timeMinutes ?? 0],
                ].map(([label, v]) => (
                  <div
                    key={String(label)}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-2 py-3"
                  >
                    <div className="text-2xl font-extrabold">{Number(v)}</div>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-white/40">
                  Card history
                </span>
                <span className="text-[10px] text-white/30">via {card.historyTransport}</span>
              </div>
              {card.transactions === null ? (
                // A failed history read must never masquerade as "no activity" —
                // that difference is exactly what staff are here to check.
                <p className="text-sm text-amber-300/80">
                  Couldn&apos;t read this card&apos;s history right now — try again.
                </p>
              ) : card.transactions.length === 0 ? (
                <p className="text-sm text-white/40">No activity on this card.</p>
              ) : (
                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {card.transactions.map((t, i) => (
                    <div
                      key={i}
                      className="flex items-baseline justify-between gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs"
                    >
                      <span className="shrink-0 text-white/45">{fmtWhen(t.timeStamp)}</span>
                      <span className="min-w-0 flex-1 truncate text-white/80">
                        {t.transType}
                        {t.device ? ` · ${t.device}` : ""}
                      </span>
                      <span className="shrink-0 font-mono text-white/70">
                        {t.tokens !== 0 && `${t.tokens > 0 ? "+" : ""}${t.tokens}t`}
                        {t.bonusTokens !== 0 && ` ${t.bonusTokens > 0 ? "+" : ""}${t.bonusTokens}b`}
                        {t.points !== 0 && ` ${t.points > 0 ? "+" : ""}${t.points}p`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Clear card (danger zone) ────────────────────────── */}
            {card.verify.exists && (
              <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-4">
                <div className="text-xs font-bold uppercase tracking-widest text-red-300/70">
                  Clear this card in Intercard
                </div>
                <p className="mt-1 text-xs text-white/50">
                  De-registers the account — any value on it is destroyed and cannot be recovered.
                  Every attempt is logged with the balance shown above.
                </p>
                {holdsValue && (
                  <label className="mt-3 flex items-center gap-2 text-sm text-amber-200">
                    <input
                      type="checkbox"
                      checked={override}
                      onChange={(e) => setOverride(e.target.checked)}
                      className="h-5 w-5"
                    />
                    This card still holds value — a manager approved destroying it.
                  </label>
                )}
                <div className="mt-3 flex gap-2">
                  <input
                    inputMode="numeric"
                    data-osk-layout="numeric"
                    value={confirmAccount}
                    onChange={(e) => setConfirmAccount(e.target.value)}
                    placeholder="Type the full account number to confirm"
                    className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 font-mono text-sm text-white focus:border-red-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void clearCard()}
                    disabled={
                      clearing ||
                      confirmAccount.trim() !== card.verify.accountNumber ||
                      (holdsValue && !override)
                    }
                    className="rounded-xl border border-red-400/60 bg-red-400/20 px-5 py-2.5 text-sm font-bold text-red-200 disabled:opacity-30"
                  >
                    {clearing ? "Clearing…" : "Clear card"}
                  </button>
                </div>
                {clearMsg && (
                  <p className={`mt-2 text-sm ${clearMsg.ok ? "text-[#46d68c]" : "text-red-300"}`}>
                    {clearMsg.text}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Recent loads ────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-bold uppercase tracking-widest text-white/40">
            Recent card loads
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCenterWide((w) => !w)}
              className={`rounded-full px-4 py-1.5 text-xs font-bold ${
                centerWide
                  ? "bg-amber-400/20 text-amber-200"
                  : "border border-white/15 text-white/60"
              }`}
            >
              {centerWide ? "Whole center" : `This kiosk (${kioskId})`}
            </button>
            <button
              type="button"
              onClick={() => void loadRows(centerWide)}
              disabled={loadingRows}
              className="rounded-full border border-white/15 px-4 py-1.5 text-xs font-bold text-white/60 disabled:opacity-40"
            >
              {loadingRows ? "Reading…" : "Refresh"}
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-white/35">
          Last 24 hours. Rows from before kiosk tracking shipped only appear on &quot;Whole
          center&quot;.
        </p>

        {rowsError && <p className="mt-3 text-sm text-red-300">{rowsError}</p>}
        {rows && rows.length === 0 && (
          <p className="mt-3 text-sm text-white/40">
            No card loads {centerWide ? "at this center" : "from this kiosk"} in the last 24 hours.
          </p>
        )}

        <div className="mt-3 space-y-2">
          {rows?.map((r) => {
            const outcome = loadOutcome(r);
            return (
              <button
                key={r.txnId}
                type="button"
                onClick={() => void lookUp(r.accountNumber)}
                className="block w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    <span className="font-mono text-sm text-white/70">{r.accountNumber}</span>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${TONE_CHIP[outcome.tone]}`}
                  >
                    {outcome.label}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-white/45">
                  <span>{fmtWhen(r.createdAt)}</span>
                  <span>
                    {r.tokens}t{r.bonusTokens > 0 ? ` +${r.bonusTokens}b` : ""}
                  </span>
                  {r.amountCents > 0 && <span>${(r.amountCents / 100).toFixed(2)}</span>}
                  {r.voucherCode && <span>voucher {r.voucherCode}</span>}
                  {r.loadedVia && <span>via {r.loadedVia}</span>}
                  {centerWide && <span>{r.kioskId ?? "unknown kiosk / web"}</span>}
                  {r.attempt > 0 && <span>retry #{r.attempt}</span>}
                </div>
                {r.error && <div className="mt-1 text-xs text-red-300/80">{r.error}</div>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
