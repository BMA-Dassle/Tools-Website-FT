"use client";

/**
 * Game Zone card FULFILLMENT on the kiosk confirmation screen — the "you're
 * booked" page also dispenses/loads the cards bought WITH the booking (owner
 * 2026-07-18: "we're combining the you're-booked and card-dispense screen").
 *
 * Reads the charged row pointers checkout stashed (gz-fulfillment.ts) and runs
 * the SAME per-card sequence as the standalone Game Zone flow, on whichever
 * hardware rail this kiosk has (gameZoneCapability):
 *   new_card, DISPENSER — dispense → read → bridge-load (SOAP fallback
 *              server-side via /load-card preLoaded) → present → wait for
 *              pickup; a failed load captures the blank (never hand over an
 *              empty card).
 *   new_card, SWIPE kiosk (no dispenser, owner 2026-08-28) — the account was
 *              either swiped in the Game Zone cart and rides the row, or (a
 *              checkout-upsell card) the guest is asked HERE to take a blank
 *              from the holder under the screen and swipe it; then bridge-load.
 *              Nothing to present or retain — a load that doesn't confirm
 *              leaves the row pending WITH its account and the guest keeps the
 *              card. A swiped card is never clear-on-encoded (load-card.ts).
 *   reload   — bridge-load each card the guest already holds + report.
 * Rows are already CHARGED in the ledger, so any failure here recovers forward
 * via the reconcile cron — the guest's money is never stranded, never re-charged.
 *
 * Every wait on hardware is BOUNDED. This screen disables Done and pauses the
 * auto-reset while cards are in flight; a device that never connects, or a
 * guest who walks away mid-swipe, must release the screen — otherwise the next
 * guest's swipe would collect the previous guest's paid tokens.
 *
 * Owns its own CRT-591 / MSR connection (the Game Zone screen is long
 * unmounted); auto-reconnects silently on a provisioned kiosk.
 */
import { useEffect, useRef, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { gameZoneCapability } from "../config";
import {
  createSwipeWaiter,
  useGameCardDispenser,
  useSerialMsr,
  type FaultBehavior,
} from "../card-reader";
import { acquireBlankBySwipe } from "../service/swiped-card";
import { creditTokensViaBridge } from "../service/game-card-bridge";
import { clearGzFulfillment, type GzFulfillmentPayload } from "../service/gz-fulfillment";
import { KioskDispenserHold } from "./KioskDispenserHold";
import { SwipeBlankGuide } from "./SwipeBlankGuide";
import { useT } from "../i18n";

type HoldFault = Extract<FaultBehavior, { kind: "hold" }>;

/** Mag reads pad the account with leading zeros; guests know the printed
 *  (unpadded) form. Display-only — API calls keep the raw value. */
function displayCardNumber(acct: string): string {
  return acct.replace(/^0+(?=\d)/, "");
}

/** `pending` — the credit didn't confirm but the row carries its account, so
 *  the reconcile cron finishes it (swipe kiosk: the guest keeps the card).
 *  `failed` — needs an attendant. */
type CardStatus =
  | "waiting"
  | "dispensing"
  | "swipe"
  | "loading"
  | "take"
  | "done"
  | "pending"
  | "failed";

interface CardRow {
  txnId: string;
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
  status: CardStatus;
}

/**
 * How long to wait for the device (CRT / MSR) to connect before releasing the
 * screen — the payment is safe, the rows recover forward. Generous on purpose:
 * a first CRT connect on this screen (Game Zone never opened this session, so
 * no parked connection to adopt) can hunt every granted COM port through two
 * baud passes with backoffs, and staff may be mid-replug; before 2026-08-28 the
 * screen waited forever, which at least let a late connect finish the cards.
 * Five minutes keeps that recovery for any realistic connect while still
 * guaranteeing the screen cannot stay locked (Done disabled, auto-reset
 * paused) indefinitely.
 */
const DEVICE_READY_MS = 5 * 60_000;

export function KioskGzFulfillment({
  payload,
  onBusyChange,
}: {
  payload: GzFulfillmentPayload;
  /** True while cards are still coming out — parent pauses its auto-reset. */
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const { config } = useKioskConfig();
  const swipeKiosk = gameZoneCapability(config) === "swipe";
  const dispenser = useGameCardDispenser({ config });

  // Swipe kiosk: only rows WITHOUT an account need the reader here (cards
  // swiped in the Game Zone cart already carry theirs).
  const needsSwipe =
    swipeKiosk && payload.mode === "new_card" && payload.cards.some((c) => !c.accountNumber);
  // ONE waiter for the component's life (lazy state, never re-created; a
  // StrictMode remount reuses it).
  const [swipeWaiter] = useState(createSwipeWaiter);
  const [swipeNote, setSwipeNote] = useState<string | null>(null);
  const [swipeChecking, setSwipeChecking] = useState(false);
  const msr = useSerialMsr({
    enabled: needsSwipe && !!config?.msrEnabled,
    portInfo: config?.msrPortInfo ?? null,
    baud: config?.msrBaud ?? null,
    onSwipe: (acct) => {
      swipeWaiter.feed(acct);
    },
    onBadSwipe: () => setSwipeNote(t("gamezone.badSwipe")),
  });
  const msrListening = msr.connection.state === "listening";
  useEffect(() => () => swipeWaiter.cancel(), [swipeWaiter]);

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
  // Mirror of startedRef for render use (reading a ref during render is unsafe).
  const [started, setStarted] = useState(false);

  // Recoverable-fault hold — SAME machinery as the standalone Game Zone screen
  // (2026-07-23: out-of-cards mid-fulfillment dead-ended the whole basket with
  // "see an attendant"; since the checkout upsell most card purchases dispense
  // HERE, so staff lost the refill-and-Resume path they had on the GZ screen).
  // The dispense loop awaits `holdUntilResolved`: staff Resume retries the SAME
  // card; "See an attendant" fails the row (recover-forward, money safe).
  const [holdFault, setHoldFault] = useState<HoldFault | null>(null);
  const holdRef = useRef<{ resolve: (resume: boolean) => void; reinit: boolean } | null>(null);
  const holdUntilResolved = (fault: HoldFault): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      holdRef.current = { resolve, reinit: fault.reinitOnResume };
      setHoldFault(fault);
    });
  const onHoldResume = async () => {
    const h = holdRef.current;
    holdRef.current = null;
    setHoldFault(null);
    if (h?.reinit) await dispenser.reinit(); // device lost its card position
    h?.resolve(true);
  };
  const onHoldAttendant = () => {
    const h = holdRef.current;
    holdRef.current = null;
    setHoldFault(null);
    h?.resolve(false);
  };

  const setRow = (i: number, patch: Partial<CardRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // What this payload waits on before starting: reload → nothing (bridge only);
  // new cards on a swipe kiosk → the MSR, and only if some row still needs a
  // swipe; new cards on a dispenser kiosk → the CRT (silent auto-reconnect).
  const ready =
    payload.mode === "reload" || (swipeKiosk ? !needsSwipe || msrListening : dispenser.ready);

  // A device that never connects must not freeze the confirmation screen (Done
  // disabled, auto-reset paused) forever: give up, release the screen with the
  // payment-safe message. Rows stay charged + pending; the cron / staff recover.
  useEffect(() => {
    if (ready || startedRef.current) return;
    const timer = setTimeout(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      setStarted(true);
      setRows((rs) => rs.map((r) => (r.status === "waiting" ? { ...r, status: "failed" } : r)));
      setNote(t("gamezone.fulfill.gaveUp"));
      clearGzFulfillment();
      onBusyChange(false);
    }, DEVICE_READY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Run ONCE, as soon as the device this payload needs is ready.
  useEffect(() => {
    if (!ready || startedRef.current) return;
    startedRef.current = true;
    setStarted(true);
    onBusyChange(true);

    // A guest-PRESENTED card (swipe kiosk, new cards): the server never
    // clear-on-encodes it. Derived once here, not threaded per call — a copied
    // `false` on the swipe rail would be the one way to wipe a guest's card.
    const swiped = swipeKiosk && payload.mode === "new_card";
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
            swiped,
          }),
        });
        const data = await res.json();
        return { loaded: res.ok && data.loaded === true, balanceTokens: data.balance?.tokens };
      } catch {
        return { loaded: false };
      }
    };

    /** Swipe kiosk: wait for the guest to swipe a BLANK for row `i` — the
     *  shared loop (service/swiped-card.ts), so this screen and the Game Zone
     *  cart give the same swiped card the same verdict and the same re-prompt.
     *  Null = the wait ended (guest gone) — the caller fails the rest of the run. */
    const swipeBlankFor = async (i: number, used: Set<string>): Promise<string | null> => {
      setRow(i, { status: "swipe" });
      const got = await acquireBlankBySwipe({
        waiter: swipeWaiter,
        locationCode: payload.locationCode,
        used,
        t,
        onState: (s) => {
          setSwipeChecking(s.phase === "checking");
          setSwipeNote(s.phase === "waiting" ? s.note : null);
        },
      });
      return got.ok ? got.account : null;
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
            setRow(i, { status: loaded ? "done" : "pending" });
            if (!loaded) setNote(t("gamezone.fulfill.note.pendingReload"));
          }
        } else if (swipeKiosk) {
          // SWIPE kiosk: a pre-swiped account rides the row; a card without
          // one (checkout upsell) is swiped here. Load, nothing to hand over.
          const used = new Set<string>(
            payload.cards.map((c) => c.accountNumber).filter((a): a is string => !!a),
          );
          for (let i = 0; i < payload.cards.length; i++) {
            const c = payload.cards[i];
            let account: string | null = c.accountNumber || null;
            if (!account) {
              account = await swipeBlankFor(i, used);
              if (!account) {
                // The guest walked away. Fail this and every remaining row —
                // payment safe, rows pending for the cron / staff — and let the
                // screen go (finally releases busy).
                setRows((rs) =>
                  rs.map((r, idx) =>
                    idx >= i && r.status !== "done" && r.status !== "pending"
                      ? { ...r, status: "failed" }
                      : r,
                  ),
                );
                setNote(t("gamezone.fulfill.swipeTimeout"));
                return;
              }
              used.add(account);
            }
            setRow(i, { accountNumber: account, status: "loading" });
            const { loaded, balanceTokens } = await loadCard(
              c.txnId,
              account,
              c.tokens,
              c.bonusTokens,
            );
            // The card is in the guest's hand and the row carries its account:
            // an unconfirmed credit is finished by the reconcile cron.
            setRow(i, {
              status: loaded ? "done" : "pending",
              ...(balanceTokens != null ? { tokens: balanceTokens } : {}),
            });
            if (!loaded) setNote(t("gamezone.swipe.loadPending"));
          }
        } else {
          const SAFE = t("gamezone.seeAttendantSafe");
          // Bin a held card WITHOUT ever forcing it into a full bin (owner hard
          // rule): capture() refuses on full and returns the bin-full hold —
          // pause for staff, then finish the capture (GZ-screen captureSafely).
          const captureSafely = async (): Promise<boolean> => {
            for (;;) {
              const cr = await dispenser.capture();
              if (cr.ok) return true;
              if (cr.fault.kind === "hold") {
                const resumed = await holdUntilResolved(cr.fault);
                if (!resumed) return false;
                continue;
              }
              return false;
            }
          };
          // Every dispensed blank has a UNIQUE pre-encoded account; a repeat means
          // the reader handed back a stale read (the "same number on N cards" bug) —
          // bin it and re-dispense rather than credit the same account twice.
          const usedAccounts = new Set<string>();
          let blanksBad = 0; // consecutive bad-blank captures (bounded)
          for (let i = 0; i < payload.cards.length; i++) {
            const c = payload.cards[i];
            setRow(i, { status: "dispensing" });
            const r = await dispenser.dispenseAndRead();
            if (!r.ok) {
              // Hold-class fault (out of cards / bin full / jam): pause on the
              // full-screen hold until staff fix it and Resume, then retry THIS
              // card — same recovery the standalone GZ screen has. Only a
              // "See an attendant" bail dead-ends the basket (recover forward,
              // the guest is already paid).
              if (r.fault.kind === "hold") {
                const resumed = await holdUntilResolved(r.fault);
                if (resumed) {
                  i--;
                  continue;
                }
                setRow(i, { status: "failed" });
                setNote(`${r.info.message} ${SAFE}`);
                return;
              }
              // Clear whatever's at the gate, then decide. A bad-blank read
              // (card-retry) tries the next blank, bounded; anything else — an
              // abort (reader gone) or too many bad blanks — fails this row.
              await captureSafely();
              if (r.fault.kind === "card-retry" && ++blanksBad <= 3) {
                i--;
                continue;
              }
              setRow(i, { status: "failed" });
              setNote(r.fault.kind === "abort" ? r.fault.message : `${r.info.message} ${SAFE}`);
              return;
            }
            const account = r.value;
            // Stale/duplicate read guard — bin + re-dispense (bounded) rather than
            // load an account we already credited this run.
            if (usedAccounts.has(account)) {
              if (!(await captureSafely())) {
                setRow(i, { status: "failed" });
                setNote(SAFE);
                return;
              }
              if (++blanksBad > 3) {
                setRow(i, { status: "failed" });
                setNote(`${t("gamezone.err.cleanRead")} ${SAFE}`);
                return;
              }
              i--;
              continue;
            }
            blanksBad = 0;
            usedAccounts.add(account);
            setRow(i, { accountNumber: account, status: "loading" });
            const { loaded, balanceTokens } = await loadCard(
              c.txnId,
              account,
              c.tokens,
              c.bonusTokens,
            );
            if (!loaded) {
              // Never hand over an unloaded blank — bin it; the row recovers forward.
              await captureSafely();
              setRow(i, { status: "failed" });
              setNote(`${t("gamezone.err.cardRetained")} ${SAFE}`);
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

  const statusLabel = (s: CardStatus): string => {
    switch (s) {
      case "waiting":
        return t("gamezone.status.waiting");
      case "dispensing":
        return t("gamezone.status.dispensing");
      case "swipe":
        return t("gamezone.fulfill.status.swipe");
      case "loading":
        return t("gamezone.status.loadingTokens");
      case "take":
        return t("gamezone.takeYourCard");
      case "done":
        return t("gamezone.status.loaded");
      case "pending":
        return t("gamezone.status.onTheWay");
      case "failed":
        return t("gamezone.status.seeAttendant");
    }
  };
  const swipeRowIdx = rows.findIndex((r) => r.status === "swipe");

  return (
    <div className="relative w-full max-w-[860px] rounded-[24px] border border-[#f800c6]/40 bg-white/[0.04] p-[32px] text-left">
      {/* Recoverable dispenser fault — full-screen hold (fixed: this card is not
          a full-screen ancestor) until staff fix it and Resume. */}
      {holdFault && (
        <div className="fixed inset-0 z-[90]">
          <KioskDispenserHold
            fault={holdFault}
            getStatusNow={dispenser.getStatusNow}
            onResume={() => void onHoldResume()}
            onSeeAttendant={onHoldAttendant}
          />
        </div>
      )}
      <div className="k-eyebrow text-[#f800c6]">
        {payload.mode === "new_card"
          ? t("gamezone.fulfill.title.new")
          : t("gamezone.fulfill.title.reload")}
      </div>
      {payload.mode === "new_card" && (
        <p className="mt-[6px] text-[24px] text-white/55">
          {swipeKiosk ? t("gamezone.fulfill.swipeEach") : t("gamezone.fulfill.takeEach")}
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
                {t("gamezone.cardN", { n: i + 1 })}
              </div>
              <div className="text-[28px] font-extrabold tabular-nums">
                {r.accountNumber ? `#${displayCardNumber(r.accountNumber)}` : "—"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[26px] font-extrabold tabular-nums text-[#00e2e5]">
                {r.tokens} {t("gamezone.tkAbbrev")}
              </div>
              <div
                className={`text-[20px] ${
                  r.status === "failed"
                    ? "text-red-300"
                    : r.status === "done"
                      ? "text-[#46d68c]"
                      : r.status === "take" || r.status === "swipe" || r.status === "pending"
                        ? "text-[#f0b341]"
                        : "text-white/50"
                }`}
              >
                {statusLabel(r.status)}
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* Swipe kiosk: the step guide for the card currently waiting on a swipe.
          No Cancel — these cards are paid for; the wait is bounded instead. */}
      {swipeRowIdx >= 0 && (
        <div className="mt-[20px]">
          <SwipeBlankGuide
            size="lg"
            step={swipeChecking ? "checking" : "wait"}
            label={
              rows.length > 1
                ? t("gamezone.swipe.legN", { n: swipeRowIdx + 1, total: rows.length })
                : t("gamezone.swipe.legOne")
            }
            listening={msrListening}
            note={swipeNote}
          />
        </div>
      )}
      {payload.mode === "new_card" && !ready && !started && (
        <p className="mt-[12px] text-[22px] text-amber-300/80">
          {swipeKiosk ? t("gamezone.fulfill.connectingReader") : t("gamezone.fulfill.connecting")}
        </p>
      )}
      {note && <p className="mt-[12px] text-[22px] text-amber-300/80">{note}</p>}
    </div>
  );
}
