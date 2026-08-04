"use client";

import { useEffect, useState } from "react";
import { IconExternalLink, IconX } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";
import { ADMIN_MONO, PORTAL_BLUE, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { SaleCapability, SaleDetail } from "~/features/web-sales";
import StatusPill from "./StatusPill";
import { TONE_COLOR, buyerLabel, money, visibleCapabilities, whenLabelLong } from "./format";

/**
 * Everything about one sale.
 *
 * A right-hand DRAWER rather than a centred modal: staff work down a list of
 * problem rows, and keeping the list visible while inspecting one is the
 * difference between "check these six" and "check one, find your place again,
 * check the next". Full-screen below the md breakpoint, where there is no list
 * to keep visible anyway.
 */
export default function SaleDetailDrawer({
  saleId,
  token,
  supportedActions,
  onClose,
  onAction,
  refreshKey,
}: {
  /** `${source}:${ref}` */
  saleId: string;
  token: string;
  supportedActions: readonly string[];
  onClose: () => void;
  onAction: (action: string, detail: SaleDetail) => void;
  /** Bump to force a refetch after an action changed the sale. */
  refreshKey: number;
}) {
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No synchronous reset here: the board mounts this keyed on `saleId` and
  // `refreshKey`, so switching sales or forcing a refetch remounts the component
  // and state starts clean. Clearing it in the effect body instead would be a
  // cascading render for no benefit.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/web-sales?token=${encodeURIComponent(token)}&detail=${encodeURIComponent(saleId)}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!alive) return;
        if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "Could not load this sale.");
        setDetail(data.detail as SaleDetail);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Could not load this sale.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [saleId, token, refreshKey]);

  const row = detail?.row;
  const caps: SaleCapability[] = row ? visibleCapabilities(row, supportedActions) : [];

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      style={{ background: "rgba(0,0,0,0.6)" }}
      {...modalBackdropProps(onClose)}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Sale detail"
        className="w-full md:max-w-[560px]"
        style={{
          background: PORTAL_DARK.card,
          borderLeft: `1px solid ${PORTAL_DARK.border}`,
          height: "100dvh",
          overflowY: "auto",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>{row?.product.label ?? "Sale"}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 999,
              flexShrink: 0,
              cursor: "pointer",
              color: PORTAL_DARK.fg,
              background: "rgba(255,255,255,0.08)",
              border: "none",
            }}
          >
            <IconX size={16} aria-hidden />
          </button>
        </div>

        {error && (
          <p role="alert" style={{ marginTop: 16, fontSize: 13, color: "#fca5a5" }}>
            {error}
          </p>
        )}
        {!detail && !error && (
          <p style={{ marginTop: 16, fontSize: 13, color: PORTAL_DARK.muted }}>Loading…</p>
        )}

        {detail && row && (
          <>
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <StatusPill
                label={row.status.label}
                tone={row.status.tone}
                strikeThrough={row.refund.kind === "voided"}
              />
              <span style={{ fontWeight: 700 }}>{money(row.money.paidCents)}</span>
              <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{whenLabelLong(row.soldAt)}</span>
            </div>

            {row.status.problem && (
              <p style={{ marginTop: 10, fontSize: 12, color: "#fca5a5" }}>{row.status.problem}</p>
            )}

            {caps.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {caps.map((c) => (
                  <button
                    key={c.action}
                    type="button"
                    disabled={!!c.blockedReason}
                    title={c.blockedReason}
                    onClick={() => onAction(c.action, detail)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "7px 14px",
                      borderRadius: 8,
                      cursor: c.blockedReason ? "not-allowed" : "pointer",
                      opacity: c.blockedReason ? 0.4 : 1,
                      color: c.action === "void" ? "#fca5a5" : "#fff",
                      background: c.action === "void" ? "transparent" : PORTAL_BLUE,
                      border: c.action === "void" ? "1px solid rgba(239,68,68,0.5)" : "none",
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}

            <Section title="Guest">
              <Line label="Buyer" value={buyerLabel(row)} />
              <Line label="Email" value={row.buyer.email} />
              <Line label="Phone" value={row.buyer.phone} />
              {row.buyer.recipientEmail && (
                <>
                  <Line label="Recipient" value={row.buyer.recipientName} />
                  <Line label="Recipient email" value={row.buyer.recipientEmail} />
                  <Line label="Recipient phone" value={row.buyer.recipientPhone} />
                </>
              )}
              <Line label="Venue" value={row.venue.label} />
              <Line label="Attribution" value={row.attribution.label} />
            </Section>

            {detail.legs.length > 0 && (
              <Section title={`What's left (${detail.legs.filter((l) => !l.spent).length} of ${detail.legs.length})`}>
                {groupByUnit(detail.legs).map(([unitLabel, legs]) => (
                  <div key={unitLabel} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: PORTAL_DARK.muted, marginBottom: 4 }}>
                      {unitLabel}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {legs.map((leg) => (
                        <span
                          key={leg.key}
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            borderRadius: 999,
                            color: leg.spent ? PORTAL_DARK.muted : TONE_COLOR.ok,
                            background: leg.spent ? "rgba(152,162,179,0.12)" : "rgba(34,197,94,0.12)",
                            textDecoration: leg.spent ? "line-through" : undefined,
                          }}
                        >
                          {leg.label}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {detail.timeline.length > 0 && (
              <Section title="History">
                {detail.timeline.map((t, i) => (
                  <div key={`${t.at}-${i}`} style={{ display: "flex", gap: 10, marginBottom: 7 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        marginTop: 5,
                        flexShrink: 0,
                        background: TONE_COLOR[t.tone ?? "muted"],
                      }}
                    />
                    <div style={{ fontSize: 12 }}>
                      <div style={{ color: PORTAL_DARK.fg }}>{t.label}</div>
                      <div style={{ color: PORTAL_DARK.muted, fontSize: 11 }}>
                        {whenLabelLong(t.at)}
                        {t.detail ? ` · ${t.detail}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {detail.facts.length > 0 && (
              <Section title="Reference">
                {detail.facts.map((f) => (
                  <div key={`${f.label}-${f.value}`} style={{ display: "flex", gap: 10, marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: PORTAL_DARK.muted, minWidth: 118 }}>{f.label}</span>
                    {f.href ? (
                      <a
                        href={f.href}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 11,
                          color: PORTAL_BLUE,
                          fontFamily: f.mono ? ADMIN_MONO : undefined,
                          overflowWrap: "anywhere",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        {f.value}
                        <IconExternalLink size={12} aria-hidden />
                      </a>
                    ) : (
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: f.mono ? ADMIN_MONO : undefined,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {f.value}
                      </span>
                    )}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/** Legs share a unit when they refund together — see `SaleLeg.unitKey`. */
function groupByUnit(legs: SaleDetail["legs"]): Array<[string, SaleDetail["legs"]]> {
  const map = new Map<string, SaleDetail["legs"]>();
  for (const leg of legs) {
    const list = map.get(leg.unitLabel) ?? [];
    list.push(leg);
    map.set(leg.unitLabel, list);
  }
  return [...map.entries()];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h3
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: PORTAL_DARK.muted,
          marginBottom: 8,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: PORTAL_DARK.muted, minWidth: 118 }}>{label}</span>
      <span style={{ fontSize: 12, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}
