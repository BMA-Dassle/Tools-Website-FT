"use client";

/**
 * Shared device boot-check — the tests staff can run from the attract screen
 * AND the admin PIN gate (no auth needed; all client-side). Live-probes the
 * Game Zone reload path (LOCAL on-prem bridge vs CLOUD queue), the serial
 * grants (attributed to the CRT-591 and the COM QR scanner by saved VID/PID),
 * and cameras; the Square reader / USB swipe can't be live-probed here
 * (admin token / passive HID) so they show configured state.
 *
 * Renders the header + result grid only (no border/positioning) — the caller
 * supplies the container (the attract overlay wraps it with dismiss + auto-hide;
 * the admin PIN screen drops it in a plain panel). Runs once per mount, so a
 * fresh mount (new React key) re-runs the tests.
 */
import { useEffect, useState } from "react";
import { bridgeHealth } from "../service/game-card-bridge";
import { venueSlug, type KioskConfig } from "../config";
import { deriveScannerCheck, getScannerModel, type SerialGrantProbe } from "../qr-scanner";

type Tone = "ok" | "warn" | "dim" | "test";

export function DeviceCheckCard({ config }: { config: KioskConfig | null }) {
  const [gameZone, setGameZone] = useState<"testing" | "local" | "cloud">("testing");
  const [serialGrants, setSerialGrants] = useState<SerialGrantProbe>("testing");
  const [cams, setCams] = useState<"testing" | number>("testing");

  useEffect(() => {
    let alive = true;
    // Game Zone reload path: does the on-prem bridge answer on this PC? Right
    // after a reboot the bridge service is still starting, so a single early
    // probe falsely reads "cloud" — retry a few times before concluding.
    void (async () => {
      for (let i = 0; i < 6 && alive; i++) {
        if (await bridgeHealth()) {
          if (alive) setGameZone("local");
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (alive) setGameZone("cloud");
    })();
    // Serial grants: persisted grants need no prompt — presence = likely wired.
    // Store each port's getInfo() so the CRT-591 row AND the QR-scanner row
    // attribute grants at render time (config never enters this effect).
    void (async () => {
      const nav = navigator as Navigator & {
        serial?: { getPorts(): Promise<Array<{ getInfo(): SerialPortInfo }>> };
      };
      if (!nav.serial) return alive && setSerialGrants("unsupported");
      const ports = await nav.serial.getPorts().catch(() => []);
      if (alive) setSerialGrants(ports.map((p) => p.getInfo()));
    })();
    // Cameras: count video inputs (no permission needed to count).
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => alive && setCams(d.filter((x) => x.kind === "videoinput").length))
      .catch(() => alive && setCams(0));
    return () => {
      alive = false;
    };
  }, []);

  const venueName = !config
    ? "Unprovisioned device"
    : config.center === "naples"
      ? "HeadPinz — Naples"
      : config.brand === "headpinz"
        ? "HeadPinz — Fort Myers"
        : "FastTrax — Fort Myers";

  // "Configured" = a card device is actually ENABLED. A lingering dispenserId
  // (the CRT serial from a past connect) must NOT read as present after the CRT
  // toggle is turned off.
  const gzHardware = config?.cardReaderEnabled
    ? config.dispenserId
      ? `CRT-591 ${config.dispenserId}`
      : "CRT-591 serial"
    : config?.msrEnabled
      ? "MSR (reload only)"
      : "none";
  const gzConfigured = !!(config?.cardReaderEnabled || config?.msrEnabled);

  // Card-device flags, derived from the shared grant probe (any grant counts —
  // the CRT row predates per-device attribution and keeps its behavior).
  const serial =
    serialGrants === "testing"
      ? "testing"
      : serialGrants === "unsupported"
        ? "unsupported"
        : serialGrants.length > 0
          ? "granted"
          : "none";

  const scannerCheck = deriveScannerCheck(config, serialGrants);
  // Friendly model hint; an id saved by a newer build degrades to itself.
  const scannerModel =
    getScannerModel(config?.qrScannerModel)?.label ?? config?.qrScannerModel ?? "QR scanner";

  const rows: Array<{ label: string; value: string; tone: Tone }> = [
    {
      label: "Game Zone reload",
      value:
        gameZone === "testing"
          ? "checking…"
          : gameZone === "local"
            ? "LOCAL bridge — instant"
            : "CLOUD queue (slower to floor)",
      tone: gameZone === "testing" ? "test" : gameZone === "local" ? "ok" : "warn",
    },
    {
      label: "Card device",
      value:
        serial === "testing"
          ? "checking…"
          : !gzConfigured
            ? "none configured"
            : serial === "granted"
              ? // Show the saved hint so "did it load from cloud?" is visible at
                // a glance: a missing "port/baud" here means the row has no hint.
                `${gzHardware} — serial OK${
                  config?.cardReaderEnabled && config.cardReaderPortIndex != null
                    ? ` · saved port ${config.cardReaderPortIndex + 1} @ ${config.cardReaderBaud ?? "auto"}`
                    : config?.cardReaderEnabled
                      ? " · no saved port yet"
                      : ""
                }`
              : serial === "unsupported"
                ? `${gzHardware} — no Web Serial`
                : `${gzHardware} — no serial grant`,
      tone:
        serial === "testing"
          ? "test"
          : !gzConfigured
            ? "dim"
            : serial === "granted"
              ? "ok"
              : "warn",
    },
    {
      label: "Cameras",
      value: cams === "testing" ? "checking…" : cams > 0 ? `${cams} detected` : "none detected",
      tone: cams === "testing" ? "test" : cams > 0 ? "ok" : "dim",
    },
    {
      label: "Square reader",
      value: config?.readerId ?? "none",
      tone: config?.readerId ? "ok" : "dim",
    },
    {
      label: "QR scanner (COM)",
      value:
        scannerCheck === "off"
          ? "off"
          : scannerCheck === "testing"
            ? "checking…"
            : scannerCheck === "unsupported"
              ? `${scannerModel} — no Web Serial`
              : scannerCheck === "no-saved-port"
                ? `${scannerModel} — no saved port yet (set up in admin)`
                : scannerCheck === "no-match"
                  ? `${scannerModel} — granted port not found (replug / re-grant)`
                  : `${scannerModel} — port OK @ ${config?.qrScannerBaud ?? "default"}`,
      tone:
        scannerCheck === "off"
          ? "dim"
          : scannerCheck === "testing"
            ? "test"
            : scannerCheck === "matched"
              ? "ok"
              : "warn",
    },
    {
      label: "USB card swipe",
      value: config?.swipeEnabled ? "enabled" : "off",
      tone: config?.swipeEnabled ? "ok" : "dim",
    },
  ];

  const dot: Record<Tone, string> = {
    ok: "bg-[#46d68c]",
    warn: "bg-amber-400",
    dim: "bg-white/25",
    test: "bg-[#00e2e5] animate-pulse",
  };

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-lg font-extrabold text-white">
          {venueName}
          {config && <span className="text-[#00e2e5]"> #{config.kioskNumber ?? 1}</span>}
        </div>
        {config && (
          <div className="rounded-full bg-[#00e2e5]/15 px-2.5 py-0.5 font-mono text-xs font-bold text-[#00e2e5]">
            {venueSlug(config)}:{config.kioskNumber ?? 1}
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-sm"
          >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot[r.tone]}`} />
            <span className="shrink-0 text-white/45">{r.label}:</span>
            <span className="truncate font-medium text-white/85">{r.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}
