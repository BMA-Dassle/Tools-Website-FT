"use client";

/**
 * Ambient gift-card scan listener — the null-rendering serial-QR consumer for
 * the ARMED PAY SCREEN (and, until PR-6, KioskGiftCardFlow's capture step).
 * Clones CheckinScanListener's shape in checkin/KioskCheckinFlow.tsx. The
 * kiosk's QR reader is a COM-port device driven over Web Serial (useQrScanner,
 * the same saved model/baud/port plumbing as the license scanner) — it never
 * types keystrokes.
 *
 * Mount this on ONE surface at a time: serial opens are exclusive, and every
 * other kiosk surface with a scan affordance holds the port with its own
 * listener (KioskFlow's early-return chain keeps checkout mutually exclusive
 * with entry-scan / code-entry / Game Zone). The pay screen OWNS the port for
 * the whole payment dwell — `enabled` gates listening without unmounting, so
 * arm/re-arm cycles never churn the port open/closed. Lines are regrouped
 * over a short quiet gap — a gift-card QR/barcode is ONE line; a driver's
 * license bursts ~35 lines and is rejected once instead of producing 35 bogus
 * lookups.
 *
 * PCI-adjacent (mirrors gift-card-qr.ts): never log the scan payload or the
 * extracted candidate — hand it to onCandidate and nowhere else.
 */
import { useEffect, useRef } from "react";
import { useKioskConfig } from "../../KioskConfigContext";
import { extractGanCandidate, useQrScanner } from "../../qr-scanner";

/** Quiet gap that ends one physical scan's line burst (mirrors useLicenseScan). */
const SCAN_BURST_QUIET_MS = 350;

export function GiftCardScanListener(props: {
  /** Listen only while true (default) — the pay screen disables during
   *  capture/done without releasing its claim on the surface. */
  enabled?: boolean;
  /** One plausible GAN scanned — caller runs the split-tender lookup. */
  onCandidate: (gan: string) => void;
  /** Wrong thing under the scanner — caller phrases the help copy. */
  onReject: (kind: "license" | "unrecognized") => void;
  /** Port open/closed — drives the "ready to scan" hint. */
  onListeningChange?: (listening: boolean) => void;
}) {
  const { config } = useKioskConfig();
  const linesRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  const scanner = useQrScanner({
    enabled: (props.enabled ?? true) && !!config?.qrScannerEnabled,
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    // Strict saved-ids matching only — the MSR + dispenser share this origin's grants.
    allowLoneGrantFallback: false,
    onScan: (scan) => {
      linesRef.current.push(scan.payload);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const lines = linesRef.current;
        linesRef.current = [];
        // A multi-line burst is a license (AAMVA separates elements with LF —
        // see aamva.ts); nothing gift-card-shaped ever spans lines.
        if (lines.length > 1) {
          propsRef.current.onReject("license");
          return;
        }
        if (lines.length !== 1) return;
        const result = extractGanCandidate(lines[0]);
        if (result.kind === "candidate") propsRef.current.onCandidate(result.gan);
        else if (result.kind === "license") propsRef.current.onReject("license");
        else propsRef.current.onReject("unrecognized");
      }, SCAN_BURST_QUIET_MS);
    },
  });

  const listening = scanner.connection.state === "listening";
  useEffect(() => {
    propsRef.current.onListeningChange?.(listening);
  }, [listening]);
  // Leaving the step: never fire a half-collected burst, and report the port
  // released so the scan hint stops showing "ready".
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
