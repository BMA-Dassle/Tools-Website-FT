"use client";

import { useEffect, useState } from "react";
import AdminResendModal from "@/components/admin/AdminResendModal";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { SaleDetail } from "~/features/web-sales";
import { money, whenLabelLong } from "../format";

/**
 * Resend, with a modal that asks WHERE — the thing the single-product deals
 * board never had.
 *
 * A thin wrapper around the shared `AdminResendModal` the videos, e-ticket and
 * bowling boards already use, so staff meet the same control everywhere: same
 * channel chips, same "same address / different address" radios, same E.164
 * normalisation. All this file decides is what the sale-specific context and
 * warnings say.
 */
export default function WebSaleResendModal({
  detail,
  token,
  channels,
  onClose,
  onSent,
}: {
  detail: SaleDetail;
  token: string;
  channels: ReadonlyArray<"sms" | "email" | "both">;
  onClose: () => void;
  onSent: (note: string) => void;
}) {
  const row = detail.row;
  const isGift = !!row.buyer.recipientEmail || !!row.buyer.recipientName;

  // A gift's codes belong to the RECIPIENT. Defaulting to the buyer would hand a
  // bearer instrument to the wrong person — and the buyer already has their own
  // receipt.
  const toEmail = isGift ? row.buyer.recipientEmail : row.buyer.email;
  const toPhone = isGift ? row.buyer.recipientPhone : row.buyer.phone;

  const [preview, setPreview] = useState<string | null>(null);

  // The preview comes from the server, rendered by the REAL send path in preview
  // mode. Rebuilding the copy here would drift from what actually goes out the
  // first time anyone edits the template.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/web-sales?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "preview_resend",
            token,
            source: row.source,
            ref: row.ref,
            channel: channels.includes("email") ? "email" : channels[0],
          }),
        });
        const data = await res.json();
        if (!alive) return;
        setPreview(res.ok && data.ok ? (data.preview?.text ?? null) : null);
      } catch {
        if (alive) setPreview(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, row.source, row.ref, channels]);

  const spentLegs = detail.legs.filter((l) => l.spent).length;

  const banner =
    row.refund.kind === "voided" ? (
      <Alert tone="danger">
        These vouchers were voided{row.refund.at ? ` on ${whenLabelLong(row.refund.at)}` : ""}. Resending
        delivers dead codes — the redemption page refuses them at tap time.
      </Alert>
    ) : row.status.code === "scheduled" ? (
      <Alert tone="warn">
        This gift is scheduled and the recipient has not been told yet. Sending now delivers it early.
      </Alert>
    ) : row.status.problem ? (
      <Alert tone="warn">
        {row.status.problem} Resending re-runs mint and delivery; it is idempotent and will not cut new
        codes for a purchase that already has them.
      </Alert>
    ) : null;

  const context = (
    <div style={{ fontSize: 12, color: PORTAL_DARK.muted, marginBottom: 14, lineHeight: 1.6 }}>
      <div style={{ color: PORTAL_DARK.fg, fontWeight: 600 }}>
        {row.product.label}
        {row.product.qty > 1 && ` × ${row.product.qty}`} · {money(row.money.paidCents)}
      </div>
      {row.product.sublabel && <div>{row.product.sublabel}</div>}
      <div>Sold {whenLabelLong(row.soldAt)}</div>

      {isGift && (
        <div style={{ marginTop: 6 }}>
          Bought by {row.buyer.name ?? row.buyer.email} · going to{" "}
          <strong style={{ color: PORTAL_DARK.fg }}>
            {row.buyer.recipientName ?? row.buyer.recipientEmail}
          </strong>
        </div>
      )}

      {detail.legs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 3 }}>
            {detail.legs.length - spentLegs} of {detail.legs.length} items still unredeemed
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {detail.legs.map((leg) => (
              <span
                key={leg.key}
                title={leg.unitLabel}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 999,
                  color: leg.spent ? PORTAL_DARK.muted : "#22c55e",
                  background: leg.spent ? "rgba(152,162,179,0.12)" : "rgba(34,197,94,0.12)",
                  textDecoration: leg.spent ? "line-through" : undefined,
                }}
              >
                {leg.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <AdminResendModal
      title={`Resend ${row.product.label}`}
      channels={[...channels]}
      defaultChannel={channels.includes("email") ? "email" : channels[0]}
      originalEmail={toEmail}
      originalPhone={toPhone}
      alertBanner={banner}
      contextSection={context}
      bodyPreview={preview}
      onClose={onClose}
      onSend={async ({ channel, phone, email }) => {
        const res = await fetch(`/api/admin/web-sales?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "resend",
            token,
            source: row.source,
            ref: row.ref,
            channel,
            // null means "the address on file" — only send an override when the
            // operator actually changed it, so the audit trail can tell a
            // redirect from an ordinary resend.
            overrideEmail: email && email !== toEmail ? email : null,
            overridePhone: phone && phone !== toPhone ? phone : null,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.detail || data.error || "That didn't work.");
        const note = data.result?.note ?? "Sent.";
        onSent(note);
        return note;
      }}
    />
  );
}

function Alert({ tone, children }: { tone: "warn" | "danger"; children: React.ReactNode }) {
  const color = tone === "danger" ? "#fecaca" : "#fde68a";
  const bg = tone === "danger" ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)";
  const border = tone === "danger" ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.35)";
  return (
    <div
      style={{
        marginBottom: 12,
        padding: 10,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
        color,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      {children}
    </div>
  );
}
