"use client";

import { IconPhone } from "@tabler/icons-react";

/**
 * VIP combos are staff-only for changes/cancellation (owner policy
 * 2026-07-03) — both legs span two systems and one shared payment, so the
 * confirmation page routes the guest to the center instead of self-serve.
 */
export default function ComboManageNote({ phone }: { phone: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <h2 className="font-display text-lg uppercase tracking-widest text-white">
        Need to change or cancel this combo?
      </h2>
      <p className="text-white/60 text-sm leading-relaxed mt-1 flex items-start gap-1.5">
        <IconPhone className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Ultimate VIP combos are handled by our team — call {phone} and we&apos;ll take care of
          both parts of your booking.
        </span>
      </p>
    </div>
  );
}
