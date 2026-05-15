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
  /** Called after waiver is successfully signed. */
  onComplete: (waiverID: string | undefined) => void;
  /** Optional heading override (default: "Sign Your Waiver"). */
  heading?: string;
  /** Optional subheading. */
  subheading?: string;
}

export default function WaiverSigning({
  personId,
  template,
  location,
  onComplete,
  heading = "Sign Your Waiver",
  subheading = "Required before participating in any activity.",
}: WaiverSigningProps) {
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
      });

      onComplete(result.waiverID);
    } catch (err) {
      console.error("[WaiverSigning] Sign failed:", err);
      setError(err instanceof Error ? err.message : "Signing failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [personId, template, location, onComplete]);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-display text-white uppercase tracking-widest mb-2">
          {heading}
        </h2>
        <p className="text-white/50 text-sm">{subheading}</p>
      </div>

      {/* Waiver text */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 max-h-64 overflow-y-auto">
        <div
          className="text-white/60 text-xs leading-relaxed prose prose-invert prose-xs max-w-none"
          dangerouslySetInnerHTML={{ __html: template.body }}
        />
      </div>

      {/* Signature pad */}
      <SignaturePadWithRef
        padRef={padRef}
        onSign={() => setHasSigned(true)}
        onClear={() => setHasSigned(false)}
      />

      {error && <p className="text-red-400 text-xs text-center">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!hasSigned || loading}
        className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
            Submitting...
          </span>
        ) : (
          "I Agree & Sign Waiver"
        )}
      </button>

      <p className="text-white/30 text-[11px] text-center">
        By signing, you agree to the terms of the waiver above.
      </p>
    </div>
  );
}
