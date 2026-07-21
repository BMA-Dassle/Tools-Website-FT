"use client";

/**
 * Public card-reload flow (cart of 1..10 cards, one payment) — kiosk parity.
 *
 * UX mirrors the kiosk Game Zone screens: a chooser (Reload / Check balance),
 * then for reloads a MULTI-CARD grid — one row per card, scan (camera QR /
 * barcode) or type each number, pick a token package per card inline — and one
 * payment (Apple/Google Pay, card, or gift card) covering them all. Balance
 * check keeps the single-card view with recent activity. The QR on a card
 * (`swflpassport.com/?id=<n>` → `/reload?id=<n>`) pre-fills + auto-verifies.
 * Payment is modeled on the booking checkout step: PaymentForm in onTokenize
 * mode (charge + Intercard load in one server round-trip). Full-bleed Game
 * Zone background.
 */

import { useEffect, useRef, useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Input from "~/components/ui/Input";
import Spinner from "~/components/ui/Spinner";
import ErrorBox from "~/components/ui/ErrorBox";
import Modal from "~/components/ui/Modal";
import { CENTER_LIST, type CenterConfig } from "~/config/intercard-centers";
import { TOKEN_PACKAGES, type TokenPackage } from "~/features/game-cards";
import { useCardBalance, usePurchase } from "~/features/game-cards";
import type { CardBalance, CardTxn, PurchaseResult, VerifyResult } from "~/features/game-cards";
import { apiPost } from "~/features/game-cards/api";
import { normalizeCard } from "~/features/game-cards/normalize";
import { useGameCardAccount } from "~/features/game-cards/account-hooks";
import AccountPanel from "./AccountPanel";
import CardScanner from "./CardScanner";

const GAME_ZONE_BG =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-arcade.webp";

type Phase = "lookup" | "location" | "cards" | "pay";

/** Chooser pick for the single-card lookup path (reload skips it entirely). */
type EntryIntent = "balance" | null;

/** One row in the multi-card reload grid (kiosk parity). `key` is a stable
 *  identity — rows can be removed while a verify round-trip is in flight. */
interface ReloadCardRow {
  key: number;
  accountNumber: string;
  pkgId: string;
  status: "unverified" | "verifying" | "ok" | "bad";
  balance?: CardBalance;
}

/** Kiosk default: pre-select the 100-token package; the guest can change it. */
const DEFAULT_PKG_ID = TOKEN_PACKAGES[1].id;

function pkgById(id: string): TokenPackage | undefined {
  return TOKEN_PACKAGES.find((p) => p.id === id);
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function GameZoneBackground() {
  return (
    <div className="fixed inset-0 -z-10" aria-hidden="true">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${GAME_ZONE_BG})` }}
      />
      <div className="absolute inset-0 bg-[#00041b]/85" />
    </div>
  );
}

function BalanceRow({ balance }: { balance: CardBalance }) {
  const cells = [
    { label: "Tokens", value: balance.tokens },
    { label: "Bonus", value: balance.bonusTokens },
    { label: "eTickets", value: balance.eTickets },
    { label: "Time (min)", value: balance.timeMinutes },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg bg-white/[0.04] px-3 py-2 text-center">
          <div className="text-lg font-semibold text-white">{c.value.toLocaleString()}</div>
          <div className="text-xs text-white/50">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

const SYNC_NOTE =
  "Balances sync from the game system and may take a few minutes to reflect recent play or reloads.";

function RecentActivity({ transactions }: { transactions: CardTxn[] }) {
  const [open, setOpen] = useState(false);
  if (!transactions.length) return null;
  return (
    <div className="border-t border-white/10 pt-3">
      <button
        className="flex w-full items-center justify-between text-sm text-white/70"
        onClick={() => setOpen(true)}
      >
        <span>Recent activity</span>
        <span className="text-white/40">View →</span>
      </button>
      {open && (
        <Modal title="Recent activity" onClose={() => setOpen(false)}>
          <ul className="space-y-1">
            {transactions.map((t, i) => {
              const tok = t.tokens || t.bonusTokens;
              const detail = tok
                ? `${tok > 0 ? "+" : ""}${tok} tokens`
                : t.points
                  ? `${t.points > 0 ? "+" : ""}${t.points} eTickets`
                  : "";
              const when = t.timeStamp ? t.timeStamp.slice(0, 16) : "";
              return (
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded bg-white/[0.03] px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="text-white/80">
                      {t.transType || "Activity"}
                      {t.device ? ` · ${t.device}` : ""}
                    </div>
                    <div className="text-xs text-white/40">
                      {t.location || "—"}
                      {when ? ` · ${when}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 text-white/60">{detail}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] leading-snug text-white/40">{SYNC_NOTE}</p>
        </Modal>
      )}
    </div>
  );
}

/** Compact token-package tile (kiosk TokenTileBody, sized for phones). */
function TokenTileBody({ p }: { p: TokenPackage }) {
  return (
    <>
      <div className="text-base font-bold text-white">
        {p.tokens} tk
        {p.bonusTokens > 0 && <span className="text-[#46d68c]"> +{p.bonusTokens}</span>}
      </div>
      <div className="text-xs text-white/50">{dollars(p.priceCents)}</div>
    </>
  );
}

export default function ReloadFlow({ initialCardId }: { initialCardId?: string }) {
  const initial = initialCardId ? normalizeCard(initialCardId) : "";
  const [phase, setPhase] = useState<Phase>("lookup");
  const [entryIntent, setEntryIntent] = useState<EntryIntent>(null);
  const [entry, setEntry] = useState(initial);
  const [lookupAccount, setLookupAccount] = useState(initial);
  const [center, setCenter] = useState<CenterConfig | null>(null);
  const [email, setEmail] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  // Multi-card reload grid (kiosk parity).
  const [cards, setCards] = useState<ReloadCardRow[]>([]);
  const [editKey, setEditKey] = useState<number | null>(null);
  const nextKeyRef = useRef(1);
  const nextKey = () => nextKeyRef.current++;

  // Camera scanner target: a grid row (by key) or the balance entry form.
  const [scanTarget, setScanTarget] = useState<
    { kind: "row"; key: number } | { kind: "entry" } | null
  >(null);

  const account = useGameCardAccount();
  const verify = useCardBalance(lookupAccount, center?.code, phase === "lookup" && !!lookupAccount);
  const purchase = usePurchase();

  // Per-center bridge liveness — drives the "instant loading" wording (and
  // doubles as the staff status readout). Refreshed on mount and every 30s.
  const [bridgeUp, setBridgeUp] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiPost<{ centers: Record<string, boolean> }>(
          "/api/game-cards/bridge-status",
          {},
        );
        if (!cancelled) setBridgeUp(data.centers ?? {});
      } catch {
        /* leave whatever we had */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  const bridgeAlive = center ? !!bridgeUp[String(center.code)] : false;

  // Success screen: keep polling until every card's credit actually lands
  // (bridge loads confirm in seconds; cron-recovered ones within minutes),
  // then pull a fresh balance for each landed card. Guests just see the row
  // flip from "Adding tokens…" to "+N tokens" — no pathway jargon.
  const [pollExpired, setPollExpired] = useState(false);
  const landedRef = useRef<Set<string>>(new Set());
  const pollGroupId = result?.anyPending && !pollExpired ? result.groupId : null;
  useEffect(() => {
    if (!pollGroupId) return;
    landedRef.current = new Set();
    let cancelled = false;
    const startedAt = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        clearInterval(id);
        setPollExpired(true);
        return;
      }
      try {
        const data = await apiPost<{
          rows: { txnId: string; accountNumber: string; loaded: boolean }[];
        }>("/api/game-cards/load-status", { groupId: pollGroupId });
        if (cancelled) return;
        const fresh = data.rows.filter((r) => r.loaded && !landedRef.current.has(r.txnId));
        if (fresh.length === 0) return;
        for (const f of fresh) landedRef.current.add(f.txnId);
        // Best-effort balance re-read per landed card (may lag the credit).
        const balances = new Map<string, VerifyResult>();
        for (const f of fresh) {
          try {
            balances.set(
              f.txnId,
              await apiPost<VerifyResult>("/api/game-cards/verify", {
                accountNumber: f.accountNumber,
              }),
            );
          } catch {
            /* balance is garnish — the load is what matters */
          }
        }
        if (cancelled) return;
        setResult((prev) => {
          if (!prev) return prev;
          const results = prev.results.map((r) => {
            if (r.loaded || !landedRef.current.has(r.txnId)) return r;
            const v = balances.get(r.txnId);
            return {
              ...r,
              loaded: true,
              creditPending: false,
              balance: v?.balance ?? r.balance,
              transactions: v?.transactions ?? r.transactions,
            };
          });
          return { ...prev, results, anyPending: results.some((x) => x.creditPending) };
        });
      } catch {
        /* transient — next tick retries */
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollGroupId]);

  // ── Grid row helpers ──────────────────────────────────────────────────────
  const setRow = (key: number, patch: Partial<ReloadCardRow>) =>
    setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const verifyRow = async (key: number, acctRaw: string) => {
    const acct = normalizeCard(acctRaw);
    if (!acct) return;
    setRow(key, { accountNumber: acct, status: "verifying", balance: undefined });
    try {
      const v = await apiPost<VerifyResult>("/api/game-cards/verify", {
        accountNumber: acct,
        locationCode: center?.code,
      });
      setRow(key, v.exists ? { status: "ok", balance: v.balance } : { status: "bad" });
    } catch {
      setRow(key, { status: "bad" });
    }
  };

  /** Enter the reload flow with these rows (center always re-confirmed). */
  const startReload = (rows: ReloadCardRow[], preselect: CenterConfig | null) => {
    setCards(rows);
    setEditKey(rows.length === 1 ? rows[0].key : null);
    setCenter(preselect);
    setPhase("location");
  };

  // Reload one or more saved game cards from the account panel. The saved
  // cards' home center pre-selects in the picker, but the guest ALWAYS
  // confirms — tokens load onto the chosen center's system right away, so
  // "where are you NOW" beats "where was this card used before".
  const reloadSavedCards = (accountNumbers: string[], locationCode: number | null) => {
    if (accountNumbers.length === 0) return;
    const rows = accountNumbers.slice(0, 10).map((acct) => ({
      key: nextKey(),
      accountNumber: normalizeCard(acct),
      pkgId: DEFAULT_PKG_ID,
      status: "verifying" as const,
    }));
    startReload(
      rows,
      locationCode != null ? (CENTER_LIST.find((x) => x.code === locationCode) ?? null) : null,
    );
    for (const r of rows) void verifyRow(r.key, r.accountNumber);
  };
  const accountPanel = <AccountPanel account={account} onReloadCards={reloadSavedCards} />;

  const verifiedCard = verify.data?.exists ? verify.data : null;
  const totalCents = cards.reduce((s, c) => s + (pkgById(c.pkgId)?.priceCents ?? 0), 0);
  const allReady =
    cards.length >= 1 &&
    cards.length <= 10 &&
    cards.every((c) => c.status === "ok" && normalizeCard(c.accountNumber).length > 0);

  const scanner =
    scanTarget !== null ? (
      <CardScanner
        onScan={(acct) => {
          if (scanTarget.kind === "row") {
            setRow(scanTarget.key, { accountNumber: acct });
            void verifyRow(scanTarget.key, acct);
          } else {
            setEntry(acct);
            setLookupAccount(acct);
          }
          setScanTarget(null);
        }}
        onClose={() => setScanTarget(null)}
      />
    ) : null;

  // ── Success ────────────────────────────────────────────────────────────
  if (result) {
    return (
      <>
        <GameZoneBackground />
        <Card className="mx-auto max-w-md space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <h1 className="text-xl font-semibold text-white">
            {result.anyPending ? "Payment received" : "Tokens added!"}
          </h1>
          {result.anyPending && !pollExpired && (
            <p className="text-sm text-white/60">
              Adding tokens to your card{bridgeAlive ? " — usually just a few seconds" : ""}. This
              screen updates automatically.
            </p>
          )}
          <div className="space-y-3">
            {result.results.map((r) => (
              <div key={r.txnId} className="space-y-2 rounded-lg bg-white/[0.04] px-3 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/70">Card {r.accountNumber}</span>
                  <span className={r.loaded ? "text-[#00E2E5]" : "text-amber-300"}>
                    {r.loaded
                      ? `+${r.tokens}${r.bonusTokens ? ` +${r.bonusTokens} bonus` : ""} tokens`
                      : pollExpired
                        ? "Credit pending"
                        : "Adding tokens…"}
                  </span>
                </div>
                {r.balance && (
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                      New balance
                    </div>
                    <BalanceRow balance={r.balance} />
                  </div>
                )}
                {r.transactions && r.transactions.length > 0 && (
                  <RecentActivity transactions={r.transactions} />
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-white/40">
            Card balances sync from the game system — a reload can take a few minutes to appear on
            your card and at the games.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setCards([]);
              setEditKey(null);
              setPayError(null);
              setEntryIntent(null);
              setPhase("lookup");
              setLookupAccount("");
              setEntry("");
            }}
          >
            Reload another card
          </Button>
        </Card>
      </>
    );
  }

  const shell = (children: React.ReactNode) => (
    <>
      <GameZoneBackground />
      <div className="mx-auto max-w-md space-y-4">{children}</div>
      {scanner}
    </>
  );

  // ── Lookup (chooser → balance entry/card view; reload skips to location) ──
  if (phase === "lookup") {
    if (verify.isFetching && !verify.data) {
      return shell(
        <div className="flex min-h-60 items-center justify-center">
          <Spinner />
        </div>,
      );
    }
    if (verifiedCard) {
      return shell(
        <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-white">Your Game Card</h1>
              <p className="text-sm text-white/60">
                Card {verifiedCard.accountNumber} · current balance
              </p>
            </div>
            <button
              onClick={() => verify.refetch()}
              disabled={verify.isFetching}
              className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-[#00E2E5] transition hover:border-white/30 disabled:opacity-50"
            >
              {verify.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {verifiedCard.balance && <BalanceRow balance={verifiedCard.balance} />}
          <p className="text-[11px] leading-snug text-white/40">{SYNC_NOTE}</p>
          {verifiedCard.transactions && <RecentActivity transactions={verifiedCard.transactions} />}
          <Button
            onClick={() => {
              // Hand-off to the reload grid with this card pre-verified.
              startReload(
                [
                  {
                    key: nextKey(),
                    accountNumber: normalizeCard(verifiedCard.accountNumber),
                    pkgId: DEFAULT_PKG_ID,
                    status: "ok",
                    balance: verifiedCard.balance,
                  },
                ],
                null,
              );
              setEntryIntent(null);
            }}
          >
            Reload Card
          </Button>
          <button
            className="w-full text-center text-xs text-white/40 underline"
            onClick={() => {
              setLookupAccount("");
              setEntry("");
            }}
          >
            Use a different card
          </button>
        </Card>,
      );
    }

    // Chooser (kiosk parity): nothing typed or scanned yet → two big tiles.
    if (entryIntent === null && !lookupAccount) {
      return shell(
        <>
          {accountPanel}
          <h1 className="font-heading text-3xl font-extrabold italic uppercase text-white">
            Game Zone cards
          </h1>
          <button
            type="button"
            onClick={() => {
              startReload(
                [
                  {
                    key: nextKey(),
                    accountNumber: "",
                    pkgId: DEFAULT_PKG_ID,
                    status: "unverified",
                  },
                ],
                null,
              );
            }}
            className="w-full rounded-2xl border border-white/10 !border-l-[6px] !border-l-[#00E2E5] bg-[rgba(7,11,28,0.92)] p-5 text-left backdrop-blur-md transition hover:border-white/30 active:scale-[0.98]"
          >
            <div className="font-heading text-xl font-extrabold italic uppercase text-white">
              Reload existing cards
            </div>
            <div className="mt-1 text-sm text-white/55">
              Add tokens to 1–10 cards you already have
            </div>
          </button>
          <button
            type="button"
            onClick={() => setEntryIntent("balance")}
            className="w-full rounded-2xl border border-white/10 !border-l-[6px] !border-l-[#46d68c] bg-[rgba(7,11,28,0.92)] p-5 text-left backdrop-blur-md transition hover:border-white/30 active:scale-[0.98]"
          >
            <div className="font-heading text-xl font-extrabold italic uppercase text-white">
              Check card balance
            </div>
            <div className="mt-1 text-sm text-white/55">
              See your tokens, bonus tokens &amp; eTickets
            </div>
          </button>
          <p className="text-center text-xs text-white/50">
            Tip: scan the QR code on your card with your phone for a faster reload.
          </p>
        </>,
      );
    }

    // Balance entry form (also the landing for a QR deep link that didn't match).
    return shell(
      <>
        {accountPanel}
        <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <h1 className="text-xl font-semibold text-white">
            {entryIntent === "balance" ? "Check card balance" : "Check Balance or Reload"}
          </h1>
          <p className="text-sm text-white/70">
            Scan the code on the back of your card, or enter the number printed{" "}
            <span className="text-white">under the barcode</span> — not the QR code. Leading zeros
            aren&apos;t needed.
          </p>
          <Button variant="secondary" onClick={() => setScanTarget({ kind: "entry" })}>
            Scan card with camera
          </Button>
          <Input
            label="Card number"
            inputMode="numeric"
            value={entry}
            onChange={(e) => setEntry(e.target.value.replace(/\D/g, ""))}
            error={verify.data && !verifiedCard ? "We couldn't find that card number." : undefined}
          />
          <Button
            onClick={() => setLookupAccount(normalizeCard(entry))}
            disabled={normalizeCard(entry).length === 0}
            loading={verify.isFetching}
          >
            Look up card
          </Button>
          <button
            className="w-full text-center text-xs text-white/40 underline"
            onClick={() => {
              setEntryIntent(null);
              setLookupAccount("");
              setEntry("");
            }}
          >
            ‹ Back
          </button>
        </Card>
      </>,
    );
  }

  // ── Location (always confirmed — tokens load onto that center's system) ──
  if (phase === "location") {
    return shell(
      <Card className="space-y-3 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
        <h2 className="text-lg font-semibold text-white">Which center are you at?</h2>
        <p className="text-sm text-white/60">
          Tokens load onto that center&apos;s system right away — confirm where you are.
        </p>
        <div className="grid gap-2">
          {CENTER_LIST.map((c) => (
            <Button
              key={c.code}
              variant={center?.code === c.code ? "primary" : "secondary"}
              onClick={() => {
                setCenter(c);
                setPhase("cards");
              }}
            >
              <span className="inline-flex items-center gap-2">
                {c.label}
                {bridgeUp[String(c.code)] && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#00E2E5]/15 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-[#00E2E5]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#00E2E5]" />
                    Instant loading
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
        <button
          className="w-full text-center text-xs text-white/40 underline"
          onClick={() => {
            setCards([]);
            setEditKey(null);
            setEntryIntent(null);
            setPhase("lookup");
            setLookupAccount("");
            setEntry("");
          }}
        >
          ‹ Back
        </button>
      </Card>,
    );
  }

  // ── Cards grid (kiosk reload parity: row per card, package each, one pay) ──
  if (phase === "cards") {
    return shell(
      <Card className="space-y-4 p-5 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-2xl font-extrabold italic uppercase text-white">
            Reload game cards
          </h2>
          <button
            className="rounded-full border border-white/15 px-4 py-1.5 text-xs text-white/60"
            onClick={() => {
              setCards([]);
              setEditKey(null);
              setEntryIntent(null);
              setPhase("lookup");
              setLookupAccount("");
              setEntry("");
            }}
          >
            Back
          </button>
        </div>
        <p className="text-sm text-white/55">
          Add each card and pick its token package — scan the code on the back or type the number.
          One payment covers them all.
        </p>

        <div className="space-y-3">
          {cards.map((c, i) => {
            const expanded = editKey === c.key;
            const pkg = pkgById(c.pkgId);
            return (
              <div key={c.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="font-heading text-base font-extrabold italic text-white">
                    Card {i + 1}
                  </span>
                  <div className="flex items-center gap-3">
                    {!expanded && (
                      <button
                        className="text-xs font-bold text-[#00E2E5]"
                        onClick={() => setEditKey(c.key)}
                      >
                        Edit
                      </button>
                    )}
                    {cards.length > 1 && (
                      <button
                        className="text-xs text-white/45"
                        onClick={() => {
                          setCards((cs) => cs.filter((x) => x.key !== c.key));
                          setEditKey(null);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {expanded ? (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setScanTarget({ kind: "row", key: c.key })}
                      >
                        Scan card
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void verifyRow(c.key, c.accountNumber)}
                        disabled={normalizeCard(c.accountNumber).length === 0}
                        loading={c.status === "verifying"}
                      >
                        Check
                      </Button>
                    </div>
                    <div className="mt-2">
                      <Input
                        label="Card number"
                        inputMode="numeric"
                        value={c.accountNumber}
                        onChange={(e) =>
                          setRow(c.key, {
                            accountNumber: e.target.value.replace(/\D/g, ""),
                            status: "unverified",
                          })
                        }
                        onBlur={() =>
                          c.status === "unverified" &&
                          normalizeCard(c.accountNumber).length > 0 &&
                          void verifyRow(c.key, c.accountNumber)
                        }
                      />
                    </div>
                    {c.status === "ok" && (
                      <div className="mt-2 text-sm text-[#46d68c]">
                        Balance {c.balance?.tokens ?? 0} tokens
                        {c.balance && c.balance.bonusTokens > 0
                          ? ` + ${c.balance.bonusTokens} bonus`
                          : ""}
                      </div>
                    )}
                    {c.status === "bad" && (
                      <div className="mt-2 text-sm text-red-300">
                        Card not found — check the number.
                      </div>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {/* Checkout-upsell specials never show on the public grid. */}
                      {TOKEN_PACKAGES.filter((p) => !p.upsell).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setRow(c.key, { pkgId: p.id });
                            // Collapse after picking IF the card is verified; keep
                            // it open when the number still needs checking.
                            if (c.status === "ok") setEditKey(null);
                          }}
                          className={`rounded-xl border-2 px-2 py-3 text-center ${
                            c.pkgId === p.id
                              ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                              : "border-white/10 bg-white/[0.02] text-white/60"
                          }`}
                        >
                          <TokenTileBody p={p} />
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-sm font-semibold text-white/80">
                    {normalizeCard(c.accountNumber).length > 0
                      ? `#${normalizeCard(c.accountNumber)}`
                      : "No card number"}{" "}
                    · {pkg?.label ?? "—"}
                    {c.status === "ok" ? (
                      <span className="text-[#46d68c]"> · ✓</span>
                    ) : c.status === "verifying" ? (
                      <span className="text-white/50"> · checking…</span>
                    ) : (
                      <span className="text-[#f0b341]"> · needs check</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {cards.length < 10 && (
          <button
            className="w-full rounded-2xl border-2 border-dashed border-[#00E2E5]/40 px-4 py-3 text-sm font-bold text-[#00E2E5]"
            onClick={() => {
              const k = nextKey();
              setCards((cs) => [
                ...cs,
                { key: k, accountNumber: "", pkgId: DEFAULT_PKG_ID, status: "unverified" },
              ]);
              setEditKey(k);
            }}
          >
            + Add another card
          </button>
        )}

        <div className="flex items-center justify-between rounded-2xl border border-[#00E2E5]/35 bg-white/[0.04] px-4 py-3">
          <div className="font-heading text-xl font-extrabold tabular-nums text-white">
            {dollars(totalCents)}
          </div>
          <Button onClick={() => setPhase("pay")} disabled={!allReady}>
            Pay &amp; load
          </Button>
        </div>
        {!allReady && (
          <p className="text-center text-xs text-white/40">Check each card number to continue.</p>
        )}
        <p className="text-xs text-white/50">{center?.label}</p>
      </Card>,
    );
  }

  // ── Pay ───────────────────────────────────────────────────────────────────
  const handleTokenize = async ({
    cardNonce,
    savedCardId,
    giftCardNonce,
    saveCardConsent,
  }: {
    cardNonce: string | null;
    savedCardId: string | null;
    giftCardNonce: string | null;
    saveCardConsent: boolean;
  }) => {
    setPayError(null);
    try {
      const r = await purchase.mutateAsync({
        kind: "reload",
        locationCode: center!.code,
        items: cards.map((c) => ({
          accountNumber: normalizeCard(c.accountNumber),
          packageId: c.pkgId,
        })),
        cardNonce: cardNonce ?? savedCardId ?? undefined,
        giftCardNonce: giftCardNonce ?? undefined,
        contact: email ? { email } : undefined,
        // Signed-in extras: attribute + optionally vault + auto-link. The server
        // ignores squareCustomerId unless it belongs to the session.
        squareCustomerId: account.selectedCustomerId ?? undefined,
        saveCard: saveCardConsent,
      });
      setResult(r);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment failed. Please try again.");
      throw err; // let PaymentForm reset its button
    }
  };

  return shell(
    <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">
          {cards.length === 1 ? "Reload" : `${cards.length} cards`}
        </h2>
        <button className="text-xs text-white/40 underline" onClick={() => setPhase("cards")}>
          Back
        </button>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-white/60">{center?.label}</span>
        <span className="text-lg font-semibold text-white">{dollars(totalCents)}</span>
      </div>
      <Input
        label="Email for receipt (optional)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {payError && <ErrorBox>{payError}</ErrorBox>}
      <PaymentForm
        amount={totalCents / 100}
        itemName={
          cards.length === 1
            ? (pkgById(cards[0].pkgId)?.label ?? "Reload")
            : `${cards.length}-card reload`
        }
        billId={normalizeCard(cards[0]?.accountNumber ?? "") || "reload"}
        contact={{ firstName: "", lastName: "", email, phone: "" }}
        locationId={center!.paymentFormKey}
        squareCustomerId={account.selectedCustomerId ?? undefined}
        savedCards={account.savedCards}
        allowSaveCard={!!account.selectedCustomerId}
        onTokenize={handleTokenize}
        onSuccess={() => {}}
        onError={(msg) => setPayError(msg)}
        onCancel={() => setPhase("cards")}
      />
    </Card>,
  );
}
