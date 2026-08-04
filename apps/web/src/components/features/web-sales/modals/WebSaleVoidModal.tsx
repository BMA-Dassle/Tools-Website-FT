"use client";

import { useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { INPUT_STYLE } from "~/components/features/reservations-admin/theme";
import type { SaleDetail } from "~/features/web-sales";
import { money } from "../format";

/**
 * Void, with a real dialog instead of `window.prompt`.
 *
 * The single-product board asked for the reason through a browser prompt, which
 * cannot be styled, cannot show what is about to be destroyed, cannot warn that
 * some of the value has already been used, and — because the check lived only in
 * the client — could be skipped entirely. All four are fixed here; the length
 * floor is also enforced by the route's schema now, not just by this form.
 *
 * The copy leads with what this is NOT. Voiding and refunding are two separate,
 * deliberate acts, and the failure mode worth designing against is a staff
 * member clicking this believing the guest gets their money back.
 */
export default function WebSaleVoidModal({
  detail,
  token,
  onClose,
  onVoided,
}: {
  detail: SaleDetail;
  token: string;
  onClose: () => void;
  onVoided: (note: string) => void;
}) {
  const row = detail.row;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spent = detail.legs.filter((l) => l.spent).length;
  const live = detail.legs.length - spent;
  const tooShort = reason.trim().length < 3;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/web-sales?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "void",
          token,
          source: row.source,
          ref: row.ref,
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "That didn't work.");
      onVoided(data.result?.note ?? "Voided.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
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
        aria-label="Void vouchers"
        className="w-full max-w-lg rounded-xl"
        style={{
          background: PORTAL_DARK.card,
          border: `1px solid ${PORTAL_DARK.border}`,
          maxHeight: "calc(100dvh - 1.5rem)",
          overflowY: "auto",
          padding: 22,
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>
          Void vouchers
        </h3>

        <div
          style={{
            marginTop: 12,
            padding: 11,
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.55,
            color: "#fecaca",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.35)",
          }}
        >
          <strong>This does not refund anything.</strong> It kills the remaining voucher value and
          leaves the {money(row.money.paidCents)} charge exactly where it is. If the guest should get
          their money back, close this and use Refund instead.
        </div>

        <div style={{ marginTop: 14, fontSize: 12, color: PORTAL_DARK.muted, lineHeight: 1.6 }}>
          <div style={{ color: PORTAL_DARK.fg, fontWeight: 600 }}>
            {row.product.label}
            {row.product.qty > 1 && ` × ${row.product.qty}`}
          </div>
          <div>{row.buyer.email}</div>
          {detail.legs.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <strong style={{ color: PORTAL_DARK.fg }}>{live}</strong> unredeemed item
              {live === 1 ? "" : "s"} will be killed.
              {spent > 0 && (
                // Says the quiet part out loud: voiding cannot claw back value a
                // guest already took, and pretending otherwise leads staff to
                // think a fraud case is closed when it is not.
                <>
                  {" "}
                  <span style={{ color: "#fde68a" }}>
                    {spent} already redeemed and cannot be taken back.
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <label style={{ display: "block", marginTop: 16 }}>
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
            Why? (recorded on the purchase)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="Bought twice by mistake — refunding the duplicate in Square"
            style={{ ...INPUT_STYLE, width: "100%", marginTop: 5, resize: "vertical" }}
          />
        </label>

        {error && (
          <p role="alert" style={{ marginTop: 10, fontSize: 12, color: "#fca5a5" }}>
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "row-reverse",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-start",
          }}
        >
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || tooShort}
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: "10px 20px",
              borderRadius: 8,
              cursor: busy || tooShort ? "not-allowed" : "pointer",
              opacity: busy || tooShort ? 0.45 : 1,
              color: "#fff",
              background: "#ef4444",
              border: "none",
            }}
          >
            {busy ? "Voiding…" : "Void vouchers"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
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
        </div>
      </div>
    </div>
  );
}
