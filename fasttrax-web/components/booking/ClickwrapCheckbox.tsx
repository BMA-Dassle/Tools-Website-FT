"use client";

import { useState } from "react";

interface ClickwrapCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Chargeback-prevention clickwrap checkbox.
 *
 * Renders a single checkbox the customer must check before completing
 * payment. Clicking "View full policy" opens an inline modal with the
 * complete cancellation & payment policy.
 *
 * The checkbox state lives in the parent (OrderSummary) so it can
 * gate the Pay/Confirm button and be passed into the acceptance log.
 */
export default function ClickwrapCheckbox({ checked, onChange }: ClickwrapCheckboxProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      {/* Checkbox row */}
      <label className="flex items-start gap-3 cursor-pointer group select-none">
        <div className="relative mt-0.5 shrink-0">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only"
          />
          {/* Custom checkbox */}
          <div
            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
              checked
                ? "bg-[#00E2E5] border-[#00E2E5]"
                : "bg-transparent border-white/30 group-hover:border-white/60"
            }`}
          >
            {checked && (
              <svg
                className="w-3 h-3 text-[#000418]"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </div>
        </div>
        <span className="text-xs text-white/50 leading-relaxed">
          I agree to FastTrax&apos;s{" "}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setModalOpen(true);
            }}
            className="text-[#00E2E5] underline hover:text-white transition-colors"
          >
            cancellation &amp; payment policy
          </button>
          . All race bookings are final and subject to this policy.
        </span>
      </label>

      {/* Policy modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Cancellation & Payment Policy"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => setModalOpen(false)}
          />

          {/* Sheet */}
          <div className="relative bg-[#060b1a] border border-white/10 rounded-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl">
            <div className="p-5">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-white font-bold text-base">
                  Cancellation &amp; Payment Policy
                </h2>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="text-white/40 hover:text-white transition-colors p-1"
                  aria-label="Close policy"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Policy body */}
              <div className="text-xs text-white/60 space-y-4 leading-relaxed">
                <p className="text-white/80">
                  Race reservations are confirmed immediately upon payment.
                  All sales are final.
                </p>

                <div>
                  <p className="text-white/80 font-semibold mb-1">Cancellations &amp; Reschedules</p>
                  <ul className="space-y-1 ml-3">
                    <li>
                      &middot; Cancellations requested at least{" "}
                      <strong className="text-white/80">24 hours</strong> before your
                      scheduled race may be eligible for a credit toward a future visit.
                    </li>
                    <li>
                      &middot; Reschedules require at least{" "}
                      <strong className="text-white/80">24 hours&apos; notice</strong>.
                      Call us at{" "}
                      <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">
                        (239) 481-9666
                      </a>{" "}
                      and we&apos;ll do our best to accommodate you.
                    </li>
                    <li>
                      &middot; No-shows and same-day cancellations are{" "}
                      <strong className="text-white/80">non-refundable</strong>.
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="text-white/80 font-semibold mb-1">Race Packs &amp; Credits</p>
                  <ul className="space-y-1 ml-3">
                    <li>
                      &middot; Race pack credits are added to your FastTrax account
                      immediately and are{" "}
                      <strong className="text-white/80">non-refundable</strong> once
                      applied.
                    </li>
                    <li>
                      &middot; Credits have no cash value and cannot be transferred to
                      another account.
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="text-white/80 font-semibold mb-1">Disputes &amp; Chargebacks</p>
                  <ul className="space-y-1 ml-3">
                    <li>
                      &middot; If you have a concern about a charge, please{" "}
                      <strong className="text-white/80">call us first</strong> at{" "}
                      <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">
                        (239) 481-9666
                      </a>{" "}
                      before contacting your bank. We can typically resolve issues within
                      one business day.
                    </li>
                    <li>
                      &middot; Initiating a chargeback without first contacting FastTrax
                      may result in suspension of booking privileges.
                    </li>
                  </ul>
                </div>

                <p className="text-white/40 pt-2 border-t border-white/[0.06]">
                  By checking the box and completing payment, you acknowledge that you
                  have read, understood, and agreed to this policy.
                </p>
              </div>

              {/* Close CTA */}
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  onChange(true);
                }}
                className="mt-5 w-full py-3 rounded-xl bg-[#00E2E5]/10 hover:bg-[#00E2E5]/20 border border-[#00E2E5]/30 text-[#00E2E5] text-sm font-semibold transition-colors"
              >
                I understand — close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
