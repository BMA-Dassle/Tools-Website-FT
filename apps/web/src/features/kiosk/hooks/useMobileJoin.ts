"use client";

/**
 * People-step hook for the mobile-join QR session.
 *
 * One effect keyed on [enabled, itemId, …] owns the session lifecycle: open on
 * mount, poll every 3s (house `alive`-flag pattern), close("done") on cleanup.
 * The two people StepDefs (race-party / kiosk-who) share ONE component, so an
 * item switch re-keys the effect — a bare mount/unmount would miss it.
 *
 * Delivery dedupe is by server joinId — the poll returns the CUMULATIVE guest
 * list, and each guest is handed to `onGuests` exactly once. Poll failures
 * never throw into render; the panel just goes muted after a streak.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import {
  closeMobileJoin,
  getMobileJoinSnapshot,
  openMobileJoin,
  pollMobileJoin,
  serverMobileJoinSnapshot,
  subscribeMobileJoin,
  type MobileJoinSnapshot,
} from "../join/kiosk-client";
import {
  KIOSK_POLL_MS,
  type JoinBrand,
  type JoinCenter,
  type JoinGuestPayload,
  type JoinStepKind,
} from "../join/types";

/** Live snapshot for components OUTSIDE the step (KioskFlow's confirm sheet
 *  + idle pause) — same store the step's hook drives. */
export function useMobileJoinStatus(): MobileJoinSnapshot {
  return useSyncExternalStore(subscribeMobileJoin, getMobileJoinSnapshot, serverMobileJoinSnapshot);
}

export function useMobileJoin(args: {
  enabled: boolean;
  itemId: string;
  kioskId: string | null;
  center: JoinCenter | null;
  brand: JoinBrand | null;
  stepKind: JoinStepKind;
  /** Called with NEW guests only (joinId-deduped). */
  onGuests: (guests: JoinGuestPayload[]) => void;
}): MobileJoinSnapshot & { qrDataUrl: string | null; reopen: () => void } {
  const snapshot = useMobileJoinStatus();
  // Keyed by the URL it was generated FROM — a stale QR for a previous code
  // derives to null instead of needing a synchronous reset in the effect.
  const [qr, setQr] = useState<{ forUrl: string; dataUrl: string } | null>(null);
  const [openNonce, setOpenNonce] = useState(0);

  const onGuestsRef = useRef(args.onGuests);
  useEffect(() => {
    onGuestsRef.current = args.onGuests;
  });
  const deliveredRef = useRef<Set<string>>(new Set());

  const { enabled, itemId, kioskId, center, brand, stepKind } = args;

  useEffect(() => {
    if (!enabled || !kioskId || !center || !brand) return;
    let alive = true;
    deliveredRef.current = new Set();
    void openMobileJoin({ kioskId, center, brand, stepKind });
    const tick = async () => {
      const guests = await pollMobileJoin(); // never throws
      if (!alive) return;
      const fresh = guests.filter((g) => !deliveredRef.current.has(g.joinId));
      if (fresh.length === 0) return;
      fresh.forEach((g) => deliveredRef.current.add(g.joinId));
      onGuestsRef.current(fresh.map((g) => g.guest));
    };
    const timer = setInterval(() => void tick(), KIOSK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      // Structural backstop — every unmount path closes the session. Explicit
      // closes elsewhere (continued / start-over / idle) already won; this
      // no-ops then (the funnel is idempotent).
      closeMobileJoin("done");
    };
  }, [enabled, itemId, kioskId, center, brand, stepKind, openNonce]);

  useEffect(() => {
    const joinUrl = snapshot.joinUrl;
    if (!joinUrl) return;
    let alive = true;
    QRCode.toDataURL(joinUrl, {
      width: 360,
      margin: 1,
      color: { dark: "#04252b", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (alive) setQr({ forUrl: joinUrl, dataUrl });
      })
      .catch(() => {
        // Panel falls back to showing the short code as text.
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [snapshot.joinUrl]);

  const qrDataUrl = qr && qr.forUrl === snapshot.joinUrl ? qr.dataUrl : null;
  return { ...snapshot, qrDataUrl, reopen: () => setOpenNonce((n) => n + 1) };
}
