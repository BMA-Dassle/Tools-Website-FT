"use client";

import { useCallback, useEffect, useState } from "react";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";

/**
 * Deal-pack sales board.
 *
 * Deliberately small. It answers the three questions ops will actually have —
 * how many sold, did anyone's voucher fail to send, and can you resend it — and
 * nothing else. Money movement is not a button here: a Square refund has to be
 * itemised through a return order, so voiding vouchers and refunding a card stay
 * two separate, deliberate acts.
 *
 * TWO LAYOUTS, ONE DATA SHAPE — the same split the reservations board uses:
 * a nine-column table from md up, stacked cards below it. A `min-w-[900px]`
 * table in an `overflow-x-auto` is not a mobile layout; it is a desktop layout
 * you have to drag sideways, and this board is opened from a sale alert on a
 * phone (owner 2026-08-03: "be mobile friendly … like the other admin pages").
 *
 * Colours come from the admin-skin portal tokens rather than a local hex, so
 * this looks like every other admin surface (owner directive 2026-07-13).
 */

interface Purchase {
  id: number;
  dealSlug: string;
  locationKey: string;
  qty: number;
  totalCents: number;
  buyerName: string | null;
  buyerEmail: string;
  buyerPhone: string | null;
  status: string;
  codes: string[];
  utm: Record<string, string> | null;
  lastError: string | null;
  refundedAt: string | null;
  createdAt: string;
}

interface Totals {
  slug: string;
  name: string;
  packsSold: number;
  grossCents: number;
  refunded: number;
  unfulfilled: number;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Rows needing attention get colour; everything else stays quiet. */
function statusTone(p: Purchase): string {
  if (p.refundedAt) return "text-white/35 line-through";
  if (p.status === "charge_failed") return "text-red-300";
  if (p.status === "charged" || p.status === "minted") return "text-amber-300";
  if (p.status === "sent") return "text-emerald-300";
  return "text-white/50";
}

/* Derived text shared by both layouts — one definition, so the phone and the
   desk never disagree about what a row says. */
const whenLabel = (p: Purchase) =>
  new Date(p.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" });
const dealLabel = (p: Purchase) => p.dealSlug.replace("-game-card-pack", "");
const statusLabel = (p: Purchase) => (p.refundedAt ? "voided" : p.status);
const sourceLabel = (p: Purchase) =>
  p.utm
    ? [p.utm.utm_source, p.utm.utm_campaign].filter(Boolean).join(" / ") ||
      (p.utm.gclid ? "google ads" : "—")
    : "direct";

export default function DealsAdminClient({ token }: { token: string }) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [totals, setTotals] = useState<Totals[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /**
   * Every state write happens AFTER the first await, so this is safe to call
   * straight from an effect — a synchronous setState in an effect body cascades a
   * render, which is what react-hooks/set-state-in-effect is warning about.
   * `loading` already starts true for the first fetch, and a refresh after
   * resend/void keeps the table on screen (that action has its own row spinner).
   */
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/deals?token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not load purchases.");
      setPurchases(data.purchases as Purchase[]);
      setTotals(data.totals as Totals[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load purchases.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Initial load. The rule flags any setState reachable from an effect, which
  // every data-fetching boundary trips — see the identical documented
  // suppression in DiscountCodesClient. Nothing here writes state before the
  // first await, so there is no cascading render to avoid; the rule is a
  // heuristic, not a correctness gate for this shape.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function act(purchaseId: number, action: "resend" | "void") {
    const reason =
      action === "void"
        ? window.prompt("Why are these vouchers being voided? (recorded on the purchase)")
        : null;
    if (action === "void" && (!reason || reason.trim().length < 3)) return;
    setBusyId(purchaseId);
    setNote(null);
    try {
      // `?token=` is REQUIRED even though the body carries it too. The
      // middleware admin gate runs before the route and cannot read a request
      // body, so it fails closed to 404 on a POST whose token is body-only —
      // Resend and Void both 404'd until this was added. The sibling
      // discount-codes client puts it on the URL for the same reason.
      const res = await fetch(`/api/admin/deals?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, token, purchaseId, reason: reason?.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "That didn't work.");
      setNote(data.note ?? (action === "resend" ? "Sent." : "Voided."));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusyId(null);
    }
  }

  /** Resend / Void — identical in both layouts, so they live in one place. */
  const actions = (p: Purchase, layout: "row" | "card") => (
    <div className={layout === "card" ? "mt-3 flex gap-5" : "whitespace-nowrap"}>
      <button
        type="button"
        disabled={busyId === p.id}
        onClick={() => void act(p.id, "resend")}
        className={`text-cyan-300 underline-offset-2 hover:underline disabled:opacity-40 ${
          layout === "card" ? "py-1 text-sm" : "mr-3 text-xs"
        }`}
      >
        Resend
      </button>
      {!p.refundedAt && (
        <button
          type="button"
          disabled={busyId === p.id}
          onClick={() => void act(p.id, "void")}
          className={`text-red-300 underline-offset-2 hover:underline disabled:opacity-40 ${
            layout === "card" ? "py-1 text-sm" : "text-xs"
          }`}
        >
          Void
        </button>
      )}
    </div>
  );

  return (
    <main
      className="min-h-screen px-4 py-8 font-[family-name:var(--font-admin-poppins)] text-white sm:px-8"
      style={{ background: PORTAL_DARK.bodyGradient }}
    >
      <h1 className="text-2xl font-bold">Deal packs</h1>
      <p className="mt-1 text-sm text-white/50">Prepaid voucher bundles sold on headpinz.com/deals</p>

      {/* Rollup */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {totals.map((t) => (
          <div
            key={t.slug}
            className="rounded-xl border p-5"
            style={{ background: PORTAL_DARK.card, borderColor: PORTAL_DARK.border }}
          >
            <h2 className="font-bold">{t.name}</h2>
            <p className="mt-2 text-3xl font-bold">{t.packsSold}</p>
            <p className="text-sm text-white/50">
              packs · {money(t.grossCents)} gross
              {t.refunded > 0 ? ` · ${t.refunded} refunded` : ""}
            </p>
            {t.unfulfilled > 0 && (
              <p className="mt-2 text-sm text-amber-300">
                {t.unfulfilled} awaiting codes or email — the reconcile cron retries every 30 min
              </p>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-6 rounded-lg border border-red-400/40 bg-red-400/10 p-4 text-sm text-red-200">
          {error}
        </div>
      )}
      {note && (
        <div className="mt-6 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-4 text-sm text-emerald-100">
          {note}
        </div>
      )}

      {/* Purchases — cards on a phone, the full table from md up */}
      <div className="mt-8 flex flex-col gap-3 md:hidden">
        {purchases.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border p-4"
            style={{ background: PORTAL_DARK.card, borderColor: PORTAL_DARK.border }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{p.buyerName ?? "—"}</div>
                <div className="truncate text-xs text-white/45">{p.buyerEmail}</div>
                {p.buyerPhone && <div className="text-xs text-white/45">{p.buyerPhone}</div>}
              </div>
              <div className="shrink-0 text-right">
                <div className="font-semibold whitespace-nowrap">{money(p.totalCents)}</div>
                <div className={`text-xs ${statusTone(p)}`}>{statusLabel(p)}</div>
              </div>
            </div>

            <div className="mt-3 text-sm text-white/70">
              {dealLabel(p)} × {p.qty}
              <span className="text-white/40"> · {p.locationKey}</span>
            </div>
            <div className="mt-1 text-xs text-white/45">
              {whenLabel(p)} · {sourceLabel(p)}
            </div>

            {p.codes.length > 0 && (
              <div className="mt-2 font-mono text-xs break-all text-white/60">
                {p.codes.join(", ")}
              </div>
            )}
            {p.lastError && <div className="mt-2 text-xs text-red-300/80">{p.lastError}</div>}

            {actions(p, "card")}
          </div>
        ))}
      </div>

      <div className="mt-8 hidden overflow-x-auto md:block">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-white/15 text-left text-xs tracking-widest text-white/40 uppercase">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Buyer</th>
              <th className="py-2 pr-4">Deal</th>
              <th className="py-2 pr-4">Qty</th>
              <th className="py-2 pr-4">Paid</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Codes</th>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} className="border-b border-white/8 align-top">
                <td className="py-3 pr-4 whitespace-nowrap text-white/55">{whenLabel(p)}</td>
                <td className="py-3 pr-4">
                  <div className="text-white">{p.buyerName ?? "—"}</div>
                  <div className="text-xs text-white/45">{p.buyerEmail}</div>
                  {p.buyerPhone && <div className="text-xs text-white/45">{p.buyerPhone}</div>}
                </td>
                <td className="py-3 pr-4 text-white/70">
                  {dealLabel(p)}
                  <div className="text-xs text-white/40">{p.locationKey}</div>
                </td>
                <td className="py-3 pr-4 text-white/70">{p.qty}</td>
                <td className="py-3 pr-4 whitespace-nowrap text-white/70">
                  {money(p.totalCents)}
                </td>
                <td className={`py-3 pr-4 whitespace-nowrap ${statusTone(p)}`}>
                  {statusLabel(p)}
                  {p.lastError && (
                    <div className="mt-1 max-w-[220px] text-xs text-red-300/80">{p.lastError}</div>
                  )}
                </td>
                <td className="py-3 pr-4 font-mono text-xs text-white/60">
                  {p.codes.length === 0 ? "—" : p.codes.join(", ")}
                </td>
                <td className="py-3 pr-4 text-xs text-white/45">{sourceLabel(p)}</td>
                <td className="py-3">{actions(p, "row")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && purchases.length === 0 && (
        <p className="py-10 text-center text-white/40">No deal packs sold yet.</p>
      )}
      {loading && <p className="py-10 text-center text-white/40">Loading…</p>}
    </main>
  );
}
