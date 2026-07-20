"use client";

/**
 * Game Zone MSR (serial swipe reader) setup — lives under the Device tab's
 * MSR toggle. The MSR is a raw COM swipe reader (`;6283=<account>?` per
 * swipe, see useSerialMsr.ts), NOT the CRT-591 — it gets its own port grant,
 * saved to msrPortInfo/msrBaud so provisioned kiosks reconnect silently.
 *
 * The grant flow mirrors the CRT-591 tab: requestPort() must be the FIRST
 * await after the tap (transient activation), pointerdown is stopped so
 * KioskShell's fullscreen handler can't spend the gesture, and a blocked
 * chooser names the blocking layer via serialBlockedMessage.
 */
import { useState } from "react";
import { gestureIsActive, serialBlockedMessage, useSerialMsr } from "../card-reader";
import type { KioskConfig } from "../config";

export function KioskAdminMsr({
  draft,
  persist,
}: {
  draft: Partial<KioskConfig>;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<void>;
}) {
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [badSwipe, setBadSwipe] = useState(false);

  const msr = useSerialMsr({
    // Silent grant-reuse (a fresh kiosk with no grant settles to DISCONNECTED).
    enabled: !!draft.msrEnabled,
    portInfo: draft.msrPortInfo ?? null,
    baud: draft.msrBaud ?? null,
    onSwipe: () => setBadSwipe(false),
    onBadSwipe: () => setBadSwipe(true),
    onConnected: (info, baudRate) => {
      void persist({
        msrEnabled: true,
        msrBaud: baudRate,
        msrPortInfo:
          info.usbVendorId != null
            ? { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId }
            : null,
      });
    },
  });

  const grantAndListen = async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setPermMsg("Web Serial isn't available here — it needs desktop Chrome/Edge on HTTPS.");
      return;
    }
    setPermMsg(null);
    const gestureActive = gestureIsActive();
    let port: SerialPort;
    try {
      // FIRST await after the tap — see the header comment.
      port = await navigator.serial.requestPort();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setPermMsg(
        name === "SecurityError"
          ? serialBlockedMessage(err, { gestureActive })
          : name === "NotFoundError"
            ? "No port was picked — or none exist. Check the MSR's USB lead and that a COM port shows in Device Manager → Ports (COM & LPT)."
            : `Permission request failed${err instanceof Error && err.message ? ` — ${err.message}` : ""}`,
      );
      return;
    }
    const ok = await msr.connectPort(port);
    if (ok) setPermMsg(null);
  };

  const c = msr.connection;
  const stateChip =
    c.state === "listening"
      ? { text: "LISTENING", cls: "bg-[#46d68c]/20 text-[#46d68c]" }
      : c.state === "connecting"
        ? { text: "CONNECTING…", cls: "bg-amber-400/20 text-amber-200" }
        : c.state === "error"
          ? { text: "ERROR", cls: "bg-red-400/20 text-red-300" }
          : c.state === "unsupported"
            ? { text: "UNSUPPORTED", cls: "bg-white/10 text-white/50" }
            : { text: "DISCONNECTED", cls: "bg-white/10 text-white/50" };

  const saved = draft.msrPortInfo;
  const savedLine = saved
    ? `baud ${draft.msrBaud ?? 9600} · ${
        saved.usbVendorId != null
          ? `USB ${saved.usbVendorId.toString(16).padStart(4, "0")}:${(saved.usbProductId ?? 0)
              .toString(16)
              .padStart(4, "0")}`
          : "native COM (no USB id — reconnects only if it's the one granted port)"
      }`
    : null;

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">MSR COM port (serial swipe)</div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${stateChip.cls}`}>
          {stateChip.text}
        </span>
      </div>

      {savedLine && c.state !== "listening" && (
        <p className="text-xs text-white/50">Saved for reconnect: {savedLine}</p>
      )}
      {c.state === "error" && <p className="text-sm text-red-300">{c.message}</p>}

      {c.state === "listening" ? (
        <div className="space-y-2">
          <p className="text-sm text-white/70">
            Swipe a Game Zone card to test —{" "}
            {msr.lastSwipe ? (
              <span className="font-mono font-bold text-[#46d68c]">{msr.lastSwipe}</span>
            ) : (
              <span className="text-white/40">no swipe read yet</span>
            )}
          </p>
          {badSwipe && (
            <p className="text-sm text-amber-300">
              That swipe wasn’t a Game Zone card (no ;6283= track) — flip the card and try again,
              slow and steady.
            </p>
          )}
          <button
            type="button"
            className="rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold text-white/70"
            onClick={() => void msr.disconnect()}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b] disabled:opacity-40"
          disabled={c.state === "unsupported" || c.state === "connecting"}
          // Keep KioskShell's document-level fullscreen handler from spending
          // this tap's transient activation before requestPort() runs.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void grantAndListen()}
        >
          Grant COM port &amp; listen…
        </button>
      )}
      {permMsg && <p className="text-sm text-white/60">{permMsg}</p>}
      <p className="text-xs text-white/40">
        Pick the MSR’s COM port in the chooser — choosing it IS the permission grant, and it saves
        to this kiosk’s setup automatically. A swipe reads track 2 (starts with ;6283=); the kiosk
        reconnects silently on every boot after this one-time grant.
      </p>
    </div>
  );
}
