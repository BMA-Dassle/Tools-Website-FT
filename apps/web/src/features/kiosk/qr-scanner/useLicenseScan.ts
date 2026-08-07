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
import { AamvaBurst, parseAamvaLines, type AamvaLicense } from "./aamva";
import { parseMemberQr, type MemberQr } from "./member-qr";
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
  /** Fires when an SMS-Timing member QR is scanned (the app's personal QR,
   *  member-qr.ts) — omit on surfaces that only take licenses (bowling). */
  onMemberQr?: (qr: MemberQr) => void;
}

export type BurstVerdict =
  | { kind: "empty" }
  | { kind: "member"; qr: MemberQr }
  | { kind: "license"; license: AamvaLicense }
  /** Neither. `diagnostic` describes SHAPES ONLY and is safe to log. */
  | { kind: "unrecognised"; diagnostic: string };

/**
 * What did the guest just scan? Pure, so it can be tested without a serial port
 * — which matters, because the only way to exercise this used to be to stand at
 * a kiosk with a scanner.
 *
 * TWO FIXES LIVE HERE, both from "I scanned my licence and nothing happened"
 * (owner, 2026-08-07):
 *
 * 1. BLANKS DON'T COUNT. This used to demand the burst be EXACTLY one line
 *    before it would even attempt a member QR. That holds for the payload but
 *    not for the burst — a scanner emitting a trailing empty read, or any stray
 *    blank, made `lines.length === 1` false. The member-QR branch was skipped,
 *    AAMVA parsing then failed on a URL, and the scan vanished. An AAMVA
 *    licence is ~35 lines, so ignoring blanks can never make one look like a QR.
 *
 * 2. TRY EVERY LINE, NOT JUST A LONE ONE. `parseMemberQr` is strict — it
 *    demands the smstim.in host AND a shape-checked code — so sweeping the
 *    burst cannot yield a false positive, and it stops mattering how the
 *    scanner chunks a long URL.
 *
 * And the reason this was expensive to diagnose at all: an unrecognised scan
 * returned SILENTLY. No error, no toast, no log. Now it returns a verdict the
 * caller can log or surface.
 */
export function classifyBurst(lines: readonly string[]): BurstVerdict {
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return { kind: "empty" };

  for (const line of meaningful) {
    const qr = parseMemberQr(line);
    if (qr) return { kind: "member", qr };
  }

  const license = parseAamvaLines(lines as string[]);
  if (license) return { kind: "license", license };

  // SHAPES ONLY, NEVER CONTENT. A licence burst is PII and a member QR carries
  // a credential, so this reports how many lines and how long they were — never
  // what they said.
  return {
    kind: "unrecognised",
    diagnostic:
      `unrecognised scan dropped: ${meaningful.length} line(s), ` +
      `lengths [${meaningful.map((l) => l.length).join(",")}], ` +
      `first starts "${meaningful[0].slice(0, 12).replace(/[^\x20-\x7e]/g, "?")}"`,
  };
}

export function useLicenseScan({ config, enabled, onLicense, onMemberQr }: UseLicenseScanOptions) {
  const onLicenseRef = useRef(onLicense);
  useEffect(() => {
    onLicenseRef.current = onLicense;
  }, [onLicense]);
  const onMemberQrRef = useRef(onMemberQr);
  useEffect(() => {
    onMemberQrRef.current = onMemberQr;
  }, [onMemberQr]);

  const burstRef = useRef(new AamvaBurst());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    const verdict = classifyBurst(burstRef.current.flushLines());
    if (verdict.kind === "member") return void onMemberQrRef.current?.(verdict.qr);
    if (verdict.kind === "license") return void onLicenseRef.current(verdict.license);
    if (verdict.kind === "unrecognised") console.warn(`[license-scan] ${verdict.diagnostic}`);
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
