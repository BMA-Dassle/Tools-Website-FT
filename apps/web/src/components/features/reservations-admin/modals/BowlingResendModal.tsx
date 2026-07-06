"use client";

/**
 * Resend-confirmation modal for the admin reservations board — thin wrapper
 * over the shared AdminResendModal. Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import AdminResendModal from "@/components/admin/AdminResendModal";
import { CENTERS, KIND_BADGE } from "~/features/reservations-admin/constants";
import { fmtTime } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";

export default function BowlingResendModal({
  reservation,
  token,
  onClose,
  onSent,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  return (
    <AdminResendModal
      title="Resend Confirmation"
      channels={["both", "email", "sms"]}
      defaultChannel="both"
      originalPhone={reservation.guestPhone}
      originalEmail={reservation.guestEmail}
      onClose={onClose}
      contextSection={
        <div className="text-xs text-white/50 mb-3 space-y-0.5">
          <div>
            Guest: <span className="text-white/80">{reservation.guestName || "Guest"}</span>
          </div>
          {reservation.guestPhone && <div>{reservation.guestPhone}</div>}
          {reservation.guestEmail && <div>{reservation.guestEmail}</div>}
          <div>
            {KIND_BADGE[reservation.productKind]?.label ?? reservation.productKind} &middot;{" "}
            {fmtTime(reservation.bookedAt)} &middot;{" "}
            {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
        </div>
      }
      onSend={async ({ channel, phone, email }) => {
        const body: Record<string, unknown> = {
          neonId: reservation.id,
          channel,
        };
        if (phone) body.overridePhone = phone;
        if (email) body.overrideEmail = email;

        const res = await fetch(
          `/api/admin/bowling/reservations/resend?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const parts: string[] = [];
        if (data.email) parts.push("Email sent");
        if (data.sms) parts.push("SMS sent");
        if (data.sms === false && (channel === "sms" || channel === "both"))
          parts.push("SMS failed");
        const msg = parts.join(", ") || "Sent";
        onSent(msg);
        return msg;
      }}
    />
  );
}
