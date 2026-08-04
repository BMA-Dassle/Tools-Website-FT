"use client";

import { useCallback, useEffect, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { INPUT_STYLE } from "~/components/features/reservations-admin/theme";
import type { RefundDestination, RefundPlan, RefundResult, SaleDetail } from "~/features/web-sales";
import { money } from "../format";

/**
 * Refund, in the shape CancelModal established.
 *
 * The server dry-run IS the modal body. The client computes NO money of its own
 * — per-unit cents cannot be summed here, because tax allocation makes that
 * wrong, and this repo hard-fails on displayed-versus-charged mismatches by
 * rule. Every figure on screen came from a plan the server built.
 */
type Phase = "loading" | "choose" | "quoting" | "busy" | "success" | "blocked" | "error";

export default function WebSaleRefundModal({
  detail,
  token,
  onClose,
  onRefunded,
}: {
  detail: SaleDetail;
  token: string;
  onClose: () => void;
  onRefunded: (note: string) => void;
}) {
  const row = detail.row;
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<RefundPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState<RefundDestination | null>(null);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [result, setResult] = useState<RefundResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ganCopied, setGanCopied] = useState(false);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/admin/web-sales?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, source: row.source, ref: row.ref, ...body }),
      });
      const data = await res.json();
      return { res, data };
    },
    [token, row.source, row.ref],
  );

  /** Re-plan for a selection. The server owns every number it returns. */
  const replan = useCallback(
    async (unitKeys: string[] | null, dest: RefundDestination | null) => {
      const { res, data } = await post({
        action: "refund_dryrun",
        unitKeys,
        destination: dest ?? "card",
      });
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Could not plan a refund.");
      return data.plan as RefundPlan;
    },
    [post],
  );

  // Authoritative dry-run on mount — the response is what staff read.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await replan(null, null);
        if (!alive) return;
        setPlan(p);
        setSelected(p.defaultUnitKeys);
        setDestination(p.destinations[0] ?? null);
        setPhase(p.blocked ? "blocked" : "choose");
      } catch (err) {
        if (!alive) return;
        setMessage(err instanceof Error ? err.message : "Could not plan a refund.");
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [replan]);

  // Re-quote whenever the selection or destination changes. Debounced, because
  // ticking three boxes should not fire three plans.
  useEffect(() => {
    if (phase !== "choose" && phase !== "quoting") return;
    if (!plan) return;
    const t = setTimeout(() => {
      void (async () => {
        setPhase("quoting");
        try {
          const p = await replan(selected, destination);
          setPlan(p);
          setPhase(p.blocked ? "blocked" : "choose");
        } catch (err) {
          setMessage(err instanceof Error ? err.message : "Could not re-price that selection.");
          setPhase("error");
        }
      })();
    }, 250);
    return () => clearTimeout(t);
    // `plan` is deliberately absent: including it would loop, since every
    // successful re-quote replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, destination, replan]);

  const spentIncluded = plan
    ? plan.units.filter((u) => selected.includes(u.key) && u.spentLegLabels.length > 0)
    : [];
  const needsOverride = spentIncluded.length > 0 && !override;
  const reasonTooShort = reason.trim().length < 3;
  const canExecute =
    phase === "choose" && !!destination && selected.length > 0 && !reasonTooShort && !needsOverride;

  async function execute() {
    if (!plan || !destination) return;
    setPhase("busy");
    setMessage(null);
    try {
      const { res, data } = await post({
        action: "refund_execute",
        unitKeys: selected,
        destination,
        reason: reason.trim(),
        planHash: plan.planHash,
      });
      if (!res.ok || !data.ok) {
        // The plan went stale — usually a guest redeemed a leg while the modal
        // was open. Refetch and show the new picture rather than executing
        // against a world that no longer exists.
        if (data.error === "plan_stale") {
          const fresh = await replan(selected, destination);
          setPlan(fresh);
          setSelected(fresh.defaultUnitKeys);
          setMessage("Something changed while you were deciding — here's the current picture.");
          setPhase("choose");
          return;
        }
        throw new Error(data.detail || data.error || "The refund did not go through.");
      }
      setResult(data.result as RefundResult);
      setPhase("success");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The refund did not go through.");
      setPhase("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,0.8)", height: "100dvh" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Refund"
        className="w-full max-w-xl rounded-xl"
        style={{
          background: PORTAL_DARK.card,
          border: `1px solid ${PORTAL_DARK.border}`,
          maxHeight: "calc(100dvh - 1.5rem)",
          overflowY: "auto",
          padding: 22,
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>
          Refund
        </h3>
        <p style={{ marginTop: 4, fontSize: 12, color: PORTAL_DARK.muted }}>
          {row.product.label}
          {row.product.qty > 1 && ` × ${row.product.qty}`} · {money(row.money.paidCents)} ·{" "}
          {row.buyer.email}
        </p>

        {phase === "loading" && <Info>Working out what can be refunded…</Info>}

        {phase === "blocked" && plan?.blocked && (
          <Banner tone="danger">{plan.blocked.message}</Banner>
        )}

        {phase === "error" && <Banner tone="danger">{message}</Banner>}

        {(phase === "choose" || phase === "quoting" || phase === "busy") && plan && (
          <>
            {message && <Banner tone="warn">{message}</Banner>}
            {plan.warnings.map((w) => (
              <Banner key={w} tone="warn">
                {w}
              </Banner>
            ))}

            <Section title="What to refund">
              {plan.units.map((u) => {
                const disabled = u.alreadyRefunded || u.refundableCents === 0;
                return (
                  <label
                    key={u.key}
                    style={{
                      display: "flex",
                      gap: 9,
                      alignItems: "flex-start",
                      padding: "7px 0",
                      opacity: disabled && !selected.includes(u.key) ? 0.55 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(u.key)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, u.key] : prev.filter((k) => k !== u.key),
                        )
                      }
                      disabled={u.alreadyRefunded || phase === "busy"}
                      style={{ marginTop: 3, accentColor: "#3b82f6" }}
                    />
                    <span style={{ fontSize: 13 }}>
                      <span style={{ color: PORTAL_DARK.fg }}>{u.label}</span>
                      <span style={{ color: PORTAL_DARK.muted }}> · {money(u.refundableCents)} left</span>
                      {u.alreadyRefunded && <Chip tone="muted">already refunded</Chip>}
                      {!u.alreadyRefunded && u.spentLegLabels.length > 0 && (
                        <Chip tone="warn">{u.spentLegLabels.length} item(s) used</Chip>
                      )}
                    </span>
                  </label>
                );
              })}
            </Section>

            {spentIncluded.length > 0 && (
              <label
                style={{
                  display: "flex",
                  gap: 9,
                  alignItems: "flex-start",
                  marginTop: 4,
                  padding: 10,
                  borderRadius: 8,
                  fontSize: 12,
                  color: "#fde68a",
                  background: "rgba(245,158,11,0.1)",
                  border: "1px solid rgba(245,158,11,0.35)",
                }}
              >
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                  style={{ marginTop: 2, accentColor: "#f59e0b" }}
                />
                <span>
                  I know I am refunding {spentIncluded.length} pack(s) the guest has already partly
                  used, and that value cannot be taken back.
                </span>
              </label>
            )}

            <Section title="Where the money goes">
              {plan.destinations.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDestination(d)}
                  disabled={phase === "busy"}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    marginBottom: 8,
                    padding: 12,
                    borderRadius: 10,
                    cursor: "pointer",
                    color: "inherit",
                    background: destination === d ? "rgba(255,255,255,0.05)" : "transparent",
                    border: `1px solid ${destination === d ? (d === "card" ? "#ef4444" : "#22c55e") : PORTAL_DARK.border}`,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, color: d === "card" ? "#ef4444" : "#22c55e" }}>
                    {d === "card" ? "Refund to card" : "HeadPinz FastTrax Gift Card"}
                  </div>
                  <div style={{ fontSize: 12, color: PORTAL_DARK.muted, marginTop: 3 }}>
                    {d === "card"
                      ? `${money(plan.selectedTotalCents)} back to the original card in 3-5 business days. Square records an itemized return, so it shows in item-level reporting and QBO.`
                      : `Issue a ${money(plan.selectedTotalCents)} gift card instead — the charge is reversed onto a new card the guest can spend online or in centre.`}
                  </div>
                </button>
              ))}
            </Section>

            <label style={{ display: "block", marginTop: 6 }}>
              <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                Why? (recorded on the refund, never sent to Square)
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="Guest bought twice by mistake"
                style={{ ...INPUT_STYLE, width: "100%", marginTop: 5, resize: "vertical" }}
              />
            </label>

            <div
              style={{
                display: "flex",
                flexDirection: "row-reverse",
                gap: 8,
                marginTop: 16,
                justifyContent: "flex-start",
                alignItems: "center",
              }}
            >
              <button
                type="button"
                onClick={() => void execute()}
                // `canExecute` already requires phase === "choose", so it covers
                // the busy and quoting states on its own.
                disabled={!canExecute}
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 20px",
                  borderRadius: 8,
                  cursor: canExecute ? "pointer" : "not-allowed",
                  opacity: canExecute ? 1 : 0.45,
                  color: "#fff",
                  background: destination === "gift_card" ? "#22c55e" : "#ef4444",
                  border: "none",
                }}
              >
                {phase === "busy"
                  ? "Refunding…"
                  : phase === "quoting"
                    ? "Pricing…"
                    : `Refund ${money(plan.selectedTotalCents)}`}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={phase === "busy"}
                style={{
                  fontSize: 13,
                  padding: "10px 18px",
                  borderRadius: 8,
                  cursor: "pointer",
                  color: PORTAL_DARK.muted,
                  background: "transparent",
                  border: `1px solid ${PORTAL_DARK.border}`,
                }}
              >
                Cancel
              </button>
              {/* Say why the button is dead rather than leaving staff guessing. */}
              {!canExecute && phase === "choose" && (
                <span style={{ fontSize: 11, color: PORTAL_DARK.muted, marginRight: "auto" }}>
                  {selected.length === 0
                    ? "Pick at least one pack."
                    : needsOverride
                      ? "Tick the box to confirm the used packs."
                      : reasonTooShort
                        ? "Add a reason."
                        : "Pick where the money goes."}
                </span>
              )}
            </div>
          </>
        )}

        {phase === "success" && result && (
          <>
            <Banner tone="ok">
              Refunded {money(result.refundedCents)}{" "}
              {result.destination === "card" ? "to the original card" : "onto a new gift card"}.
            </Banner>
            {result.giftCard && (
              <Section title="Gift card number">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <code style={{ fontSize: 15, letterSpacing: 1 }}>{result.giftCard.gan}</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(result.giftCard!.gan);
                      setGanCopied(true);
                      setTimeout(() => setGanCopied(false), 1500);
                    }}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 6,
                      cursor: "pointer",
                      color: PORTAL_DARK.fg,
                      background: "transparent",
                      border: `1px solid ${PORTAL_DARK.border}`,
                    }}
                  >
                    {ganCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p style={{ marginTop: 6, fontSize: 11, color: PORTAL_DARK.muted }}>
                  Nothing has been sent to the guest — give them this number.
                </p>
              </Section>
            )}
            {result.warnings.map((w) => (
              <Banner key={w} tone="warn">
                {w}
              </Banner>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  onRefunded(`Refunded ${money(result.refundedCents)}.`);
                  onClose();
                }}
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "10px 22px",
                  borderRadius: 8,
                  cursor: "pointer",
                  color: "#fff",
                  background: "#22c55e",
                  border: "none",
                }}
              >
                Done
              </button>
            </div>
          </>
        )}

        {(phase === "blocked" || phase === "error") && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontSize: 13,
                padding: "10px 18px",
                borderRadius: 8,
                cursor: "pointer",
                color: PORTAL_DARK.muted,
                background: "transparent",
                border: `1px solid ${PORTAL_DARK.border}`,
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h4
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: PORTAL_DARK.muted,
          marginBottom: 6,
        }}
      >
        {title}
      </h4>
      {children}
    </section>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const map = {
    ok: ["#bbf7d0", "rgba(34,197,94,0.1)", "rgba(34,197,94,0.35)"],
    warn: ["#fde68a", "rgba(245,158,11,0.1)", "rgba(245,158,11,0.35)"],
    danger: ["#fecaca", "rgba(239,68,68,0.1)", "rgba(239,68,68,0.35)"],
  }[tone];
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.55,
        color: map[0],
        background: map[1],
        border: `1px solid ${map[2]}`,
      }}
    >
      {children}
    </div>
  );
}

function Chip({ tone, children }: { tone: "muted" | "warn"; children: React.ReactNode }) {
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 999,
        color: tone === "warn" ? "#fde68a" : PORTAL_DARK.muted,
        background: tone === "warn" ? "rgba(245,158,11,0.12)" : "rgba(152,162,179,0.12)",
      }}
    >
      {children}
    </span>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <p style={{ marginTop: 16, fontSize: 13, color: PORTAL_DARK.muted }}>{children}</p>;
}
