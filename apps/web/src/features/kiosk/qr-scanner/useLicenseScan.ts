"use client";

/**
 * Guest-flow license listener — the "scan semantics" consumer the qr-scanner
 * README deferred. Wraps useQrScanner with the SAME option plumbing the admin
 * panel uses (saved model/baud/port from KioskConfig, strict port matching),
 * regroups the per-line burst one physical license scan produces (see
 * aamva.ts), and emits a parsed AamvaLicense after a quiet gap.
 *
 * Non-license scans (regular QR codes) flush to null and are dropped — this
 * hook is deliberately license-only; other scan meanings get their own
 * consumers.
 *
 * NOTE port exclusivity: serial opens are exclusive, so mount this on ONE
 * surface at a time (the kiosk shows one step/screen at once; /kiosk/admin is
 * a separate route). See docs/qr-scanner/README.md § Port independence.
 */
import { useCallback, useEffect, useRef } from "react";
import type { KioskConfig } from "../config";
import { AamvaBurst, type AamvaLicense } from "./aamva";
import { useQrScanner } from "./useQrScanner";

/** Quiet gap that ends a burst. A real burst lands in single-digit ms; 350 ms
 *  is generous headroom (slow trigger pulls, USB scheduling) yet invisible. */
const BURST_QUIET_MS = 350;

export interface UseLicenseScanOptions {
  /** The kiosk's saved device config (null while loading). */
  config: KioskConfig | null;
  /** Master switch — pass the surface's "should I hold the port" condition. */
  enabled: boolean;
  /** Fires once per physical license scan (held in a ref — inline closures fine). */
  onLicense: (license: AamvaLicense) => void;
}

export function useLicenseScan({ config, enabled, onLicense }: UseLicenseScanOptions) {
  const onLicenseRef = useRef(onLicense);
  useEffect(() => {
    onLicenseRef.current = onLicense;
  }, [onLicense]);

  const burstRef = useRef(new AamvaBurst());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    const license = burstRef.current.flush();
    if (license) onLicenseRef.current(license);
  }, []);

  const scanner = useQrScanner({
    enabled: enabled && !!config?.qrScannerEnabled,
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    // Strict matching only — the CRT-591 and MSR share this origin's grants.
    allowLoneGrantFallback: false,
    onScan: (scan) => {
      burstRef.current.push(scan.payload);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, BURST_QUIET_MS);
    },
  });

  // Drop any half-collected burst on unmount/disable — never fire late.
  useEffect(() => {
    const burst = burstRef.current;
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      burst.reset();
    };
  }, []);

  return {
    /** True when the port is open and scans will be heard — drives hint UI. */
    listening: scanner.connection.state === "listening",
  };
}

export type LicenseScan = ReturnType<typeof useLicenseScan>;
