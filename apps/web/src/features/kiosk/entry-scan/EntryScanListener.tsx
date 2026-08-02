"use client";

/**
 * Entry-screen scan listener — the null-rendering scan consumer for the four
 * screens a guest sees BEFORE they've chosen anything: the attract loop, the
 * "What are we doing today?" chooser, and the Attractions / Experiences
 * shelves. Clones the shape of `components/split/GiftCardScanListener.tsx`,
 * which is itself the sanctioned clone of `CheckinScanListener`.
 *
 * Transport only — it frames bursts and rejects licences. WHAT a payload means
 * is `classify-entry.ts`'s job and WHERE it goes is `useEntryScanRouter`'s, so
 * this file has no product knowledge at all.
 *
 * PORT EXCLUSIVITY. Serial opens are exclusive and three serial devices (the
 * CRT-591, the MSR and the scanner) share this origin's grants, so mount this
 * on ONE surface at a time. In practice: once in `AttractScreen` (its own
 * route) and once in the `KioskFlow` branch that renders `KioskCategories`.
 * Every deeper flow screen — code entry, Game Zone, the people steps — returns
 * earlier in `KioskFlow`'s chain and holds the port itself. Never mount this in
 * `KioskShell` or the shared flow `chrome`: it would fight all of them.
 *
 * BOTH TRANSPORTS. A kiosk may have a serial QR reader (`qrScannerEnabled`), a
 * keyboard-wedge scanner (`scannerEnabled`), or neither — they are separate
 * device concepts. A kiosk with neither mounts nothing and behaves exactly as
 * it does today, which is what makes this safe to ship without a feature flag.
 */
import { useEffect, useRef } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { useQrScanner } from "../qr-scanner";
import { useWedgeScan } from "../checkin/wedge-scan";

/** Quiet gap that ends one physical scan's line burst (mirrors useLicenseScan). */
const SCAN_BURST_QUIET_MS = 350;
/** The wedge capture self-disarms after 15s; re-arm well inside that. */
const WEDGE_REARM_MS = 8_000;

export function EntryScanListener(props: {
  /** Host's "should I hold the port" condition — false while a modal/overlay
   *  owns the screen, or once a scan is already being routed. */
  enabled?: boolean;
  /** One physical scan, framed. Raw payload — the caller classifies. */
  onScan: (raw: string) => void;
  /** A driver's licence went under the scanner (a ~35-line burst). Reported
   *  ONCE per scan, not once per line. */
  onLicense?: () => void;
  /** Serial port open/closed — drives any "ready to scan" hint. */
  onListeningChange?: (listening: boolean) => void;
}) {
  const { enabled = true } = props;
  const { config } = useKioskConfig();
  const linesRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  /** End of one physical scan. A multi-line burst is a licence (AAMVA splits
   *  elements with LF); nothing we route here ever spans lines. */
  const flush = () => {
    timerRef.current = null;
    const lines = linesRef.current;
    linesRef.current = [];
    if (lines.length > 1) {
      propsRef.current.onLicense?.();
      return;
    }
    const raw = lines[0]?.trim();
    if (raw) propsRef.current.onScan(raw);
  };

  const collect = (payload: string) => {
    linesRef.current.push(payload);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, SCAN_BURST_QUIET_MS);
  };

  // Serial QR scanner — same provisioning knobs as the licence scan.
  const scanner = useQrScanner({
    enabled: enabled && !!config?.qrScannerEnabled,
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    // Strict saved-ids matching only — the MSR + card reader share the grants.
    allowLoneGrantFallback: false,
    onScan: (scan) => collect(scan.payload),
  });

  // Keyboard wedge — the burst capture disarms itself after 15s (it shares the
  // keyboard with the OSK and IdleWatcher), so keep re-arming while we're up.
  //
  // KNOWN NUANCE, deliberately not worked around: useWedgeScan swallows keydown
  // on WINDOW capture, which runs before IdleWatcher's DOCUMENT capture — so on
  // a wedge kiosk a scan doesn't itself reset the idle timer. Harmless in
  // practice: a scan that routes navigates and remounts the watchdog with a
  // fresh timer, and one that doesn't leaves a guest who is standing right
  // there and about to touch something. The serial path never touches the
  // keyboard at all. Synthesising an activity event to paper over this would
  // re-enter the wedge's own window-capture listener — worse than the gap.
  const wedge = useWedgeScan((raw) => {
    // The wedge hands over a WHOLE burst already joined, not per-line, so it
    // bypasses the line regroup above and goes straight out.
    const trimmed = raw.trim();
    if (trimmed) propsRef.current.onScan(trimmed);
  });
  const wedgeArm = wedge.arm;
  useEffect(() => {
    if (!enabled || !config?.scannerEnabled) return;
    wedgeArm();
    const id = setInterval(wedgeArm, WEDGE_REARM_MS);
    return () => clearInterval(id);
  }, [enabled, config?.scannerEnabled, wedgeArm]);

  const listening = scanner.connection.state === "listening";
  useEffect(() => {
    propsRef.current.onListeningChange?.(listening);
  }, [listening]);

  // Leaving the screen: never fire a half-collected burst, and report the port
  // released so any scan hint stops saying "ready".
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      linesRef.current = [];
      propsRef.current.onListeningChange?.(false);
    };
  }, []);

  return null;
}
