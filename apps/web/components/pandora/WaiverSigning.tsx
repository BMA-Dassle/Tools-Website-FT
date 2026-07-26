"use client";

import { useRef, useState, useCallback } from "react";
import { SignaturePadWithRef } from "@/components/pandora/SignaturePad";
import type { SignaturePadRef } from "@/components/pandora/SignaturePad";
import type { PandoraWaiverTemplate } from "@/lib/pandora";
import { pandoraSignWaiver, calculateWaiverExpiry } from "@/lib/pandora";

/**
 * Reusable waiver signing UI: scrollable waiver text + signature pad + submit.
 *
 * Handles the sign call internally; parent just provides personId + template
 * and receives an onComplete callback when signing succeeds.
 *
 * Used by: group event page, future express lane waiver, kiosk waiver.
 */

export interface WaiverSigningProps {
  personId: string;
  template: PandoraWaiverTemplate;
  location?: string;
  /** SHORT Pandora id of the person SIGNING when not personId themselves —
   *  a guardian signing a minor's waiver. Omitted = self-sign. */
  signerPersonId?: string;
  /** Called after waiver is successfully signed. */
  onComplete: (waiverID: string | undefined) => void;
  /** Optional heading override (default: "Sign Your Waiver"). */
  heading?: string;
  /** Optional subheading. */
  subheading?: string;
  /** "sm" = default (mobile/event page); "lg" = kiosk — bigger body area, larger
   *  text, more of the screen used (owner 2026-07-26). */
  size?: "sm" | "lg";
  /** Localized chrome — default English so non-kiosk callers are unaffected; the
   *  kiosk passes translated values (repo rule: all guest-facing copy is i18n). */
  submitLabel?: string;
  submittingLabel?: string;
  agreementNote?: string;
  signLabel?: string;
  clearLabel?: string;
}

export default function WaiverSigning({
  personId,
  template,
  location,
  signerPersonId,
  onComplete,
  heading = "Sign Your Waiver",
  subheading = "Required before participating in any activity.",
  size = "sm",
  submitLabel = "I Agree & Sign Waiver",
  submittingLabel = "Submitting...",
  agreementNote = "By signing, you agree to the terms of the waiver above.",
  signLabel = "Sign below",
  clearLabel = "Clear",
}: WaiverSigningProps) {
  const lg = size === "lg";
  const padRef = useRef<SignaturePadRef | null>(null);
  const [hasSigned, setHasSigned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!padRef.current || padRef.current.isEmpty()) return;
    setLoading(true);
    setError(null);

    try {
      const signatureDataUrl = padRef.current.toDataURL();
      const invalidationDate = calculateWaiverExpiry(template.duration);

      const result = await pandoraSignWaiver({
        personID: personId,
        waiverContentID: template.contentID,
        signature: signatureDataUrl,
        location,
        invalidationDate,
        ...(signerPersonId ? { sigPersonID: signerPersonId } : {}),
      });

      onComplete(result.waiverID);
    } catch (err) {
      console.error("[WaiverSigning] Sign failed:", err);
      setError(err instanceof Error ? err.message : "Signing failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [personId, template, location, signerPersonId, onComplete]);

  return (
    <div className={lg ? "space-y-8" : "space-y-6"}>
      <div className="text-center">
        <h2
          className={`font-display text-white uppercase tracking-widest mb-2 ${
            lg ? "text-[40px]" : "text-xl"
          }`}
        >
          {heading}
        </h2>
        <p className={`text-white/50 ${lg ? "text-[24px]" : "text-sm"}`}>{subheading}</p>
      </div>

      {/* Waiver text — kiosk uses far more of the tall portrait screen. */}
      <div
        className={`rounded-xl border border-white/10 bg-white/3 overflow-y-auto ${
          lg ? "p-8 max-h-[58vh]" : "p-4 max-h-64"
        }`}
      >
        <div
          className={`text-white/70 leading-relaxed prose prose-invert max-w-none ${
            lg ? "text-[22px]" : "text-xs prose-xs text-white/60"
          }`}
          dangerouslySetInnerHTML={{ __html: template.body }}
        />
      </div>

      {/* Signature pad */}
      <SignaturePadWithRef
        padRef={padRef}
        onSign={() => setHasSigned(true)}
        onClear={() => setHasSigned(false)}
        height={lg ? 200 : 140}
        signLabel={signLabel}
        clearLabel={clearLabel}
      />

      {error && (
        <p className={`text-red-400 text-center ${lg ? "text-[22px]" : "text-xs"}`}>{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!hasSigned || loading}
        className={`w-full rounded-xl font-bold bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          lg ? "py-6 text-[30px]" : "py-3.5 text-sm"
        }`}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
            {submittingLabel}
          </span>
        ) : (
          submitLabel
        )}
      </button>

      <p className={`text-white/30 text-center ${lg ? "text-[20px]" : "text-[11px]"}`}>
        {agreementNote}
      </p>
    </div>
  );
}
