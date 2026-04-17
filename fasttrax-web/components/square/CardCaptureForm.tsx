"use client";

import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";

/**
 * Minimal Square card-capture form for subscription flows.
 *
 * Shows only the inline Card input. No "Pay $X" button, no wallets, no saved
 * cards — the parent renders its own submit button and calls `tokenize()`
 * via the forwarded ref when ready.
 */

// Window.Square type is already declared globally by PaymentForm.tsx — reuse at runtime.
interface SquareCard {
  attach: (selector: string) => Promise<void>;
  tokenize: () => Promise<{
    status: string;
    token?: string;
    errors?: { message: string }[];
    details?: { card?: { brand?: string; last4?: string } };
  }>;
  destroy: () => void;
}

export interface CardCaptureHandle {
  tokenize: () => Promise<{ token: string; brand?: string; last4?: string } | { error: string }>;
}

const SQUARE_APP_ID = process.env.NEXT_PUBLIC_SQUARE_APP_ID || "";
const SDK_URL = "https://web.squarecdn.com/v1/square.js";

const SQUARE_LOCATIONS: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

function resolveLocationId(override?: string): string {
  if (override && SQUARE_LOCATIONS[override]) return SQUARE_LOCATIONS[override];
  if (override && /^[A-Z0-9]{10,}$/.test(override)) return override; // raw Square ID
  if (typeof window === "undefined") return SQUARE_LOCATIONS.fasttrax;
  return window.location.hostname.includes("headpinz")
    ? SQUARE_LOCATIONS.headpinz
    : SQUARE_LOCATIONS.fasttrax;
}

interface Props {
  /** "fasttrax" | "headpinz" | "naples" or raw Square location ID */
  locationId?: string;
  /** Called once the card input is attached and ready for tokenize */
  onReady?: () => void;
}

const CardCaptureForm = forwardRef<CardCaptureHandle, Props>(function CardCaptureForm(
  { locationId, onReady },
  ref,
) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const cardRef = useRef<SquareCard | null>(null);

  useImperativeHandle(ref, () => ({
    async tokenize() {
      if (!cardRef.current) return { error: "Card form not ready" };
      try {
        const r = await cardRef.current.tokenize();
        if (r.status === "OK" && r.token) {
          return {
            token: r.token,
            brand: r.details?.card?.brand,
            last4: r.details?.card?.last4,
          };
        }
        return { error: r.errors?.[0]?.message || "Could not validate card" };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Tokenize failed" };
      }
    },
  }));

  useEffect(() => {
    let cancelled = false;
    let cardInstance: SquareCard | null = null;

    async function init() {
      try {
        // Load the SDK once
        if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement("script");
            s.src = SDK_URL;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("Square SDK failed to load"));
            document.head.appendChild(s);
          });
        }
        // Wait for Square global
        while (!window.Square && !cancelled) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (cancelled || !window.Square) return;

        const locId = resolveLocationId(locationId);
        const payments = await window.Square.payments(SQUARE_APP_ID, locId);
        cardInstance = await payments.card();
        await cardInstance.attach("#sq-card-capture");

        if (cancelled) {
          cardInstance.destroy();
          return;
        }
        cardRef.current = cardInstance;
        setReady(true);
        onReady?.();
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not load card form");
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      try {
        cardInstance?.destroy();
      } catch { /* ignore */ }
      cardRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  return (
    <div>
      {loadError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 mb-3 text-red-200 text-sm">
          {loadError}
        </div>
      )}
      <div
        id="sq-card-capture"
        className="rounded-lg border border-white/15 bg-white/5 p-3"
        style={{ minHeight: 56 }}
      />
      {!ready && !loadError && (
        <p className="text-white/40 text-xs mt-2">Loading secure card entry…</p>
      )}
    </div>
  );
});

export default CardCaptureForm;
