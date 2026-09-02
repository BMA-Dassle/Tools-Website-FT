"use client";

/**
 * /kiosk/staff — Dispenser tab. A deliberately small, plain-English panel over
 * the CRT-591: status, push a card out, take it back, clear a jam, gate
 * control, reject-bin counter. No hex, no Mifare, no provisioning — that all
 * stays in Kiosk admin's Card reader tab.
 *
 * Uses the SAME `useCardReader` (module-scoped shared client), so it adopts a
 * connection the guest flow already holds instantly — and because Web Serial
 * is one-port-one-process, this page must be reached by client-side navigation
 * on the kiosk PC itself (the tap gesture does that; a second browser tab
 * cannot take the port).
 *
 * Destructive motions (jam clear, bin into the reject bin, counter reset) use
 * a two-tap inline confirm — no browser dialogs on a kiosk touchscreen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KioskConfig } from "../config";
import { useCardReader } from "../card-reader/useCardReader";
import { classifyFault } from "../card-reader/recovery";
import type { CrtErrorInfo } from "../card-reader/protocol/errors";

const CARD_LABEL: Record<string, string> = {
  none: "No card inside",
  atGate: "Card at the gate (guest side)",
  atRfIcPosition: "Card at the read station (inside)",
  unknown: "Card position unknown",
};
const STACKER_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" }> = {
  enough: { text: "Enough cards", tone: "good" },
  few: { text: "Running LOW — refill soon", tone: "warn" },
  empty: { text: "EMPTY — refill the stacker", tone: "bad" },
  unknown: { text: "Level unknown", tone: "warn" },
};
const BIN_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" }> = {
  ok: { text: "OK", tone: "good" },
  full: { text: "FULL — empty it, then reset the counter", tone: "bad" },
  unknown: { text: "Unknown", tone: "warn" },
};

const TONE_TEXT: Record<"good" | "warn" | "bad", string> = {
  good: "text-[#46d68c]",
  warn: "text-amber-300",
  bad: "text-red-300",
};

/** Plain-English fault rendering — classifyFault's title/hint, never a raw code. */
function faultText(info: CrtErrorInfo): { title: string; message: string; hint?: string } {
  const behavior = classifyFault(info);
  if (behavior.kind === "hold") {
    return { title: behavior.title, message: behavior.message, hint: behavior.hint };
  }
  return { title: "Reader problem", message: info.message, hint: info.hint };
}

export function KioskStaffDispenser({ config }: { config: KioskConfig | null }) {
  const reader = useCardReader({
    preferredBaud: config?.cardReaderBaud ?? null,
    portInfo: config?.cardReaderPortInfo ?? null,
    portIndex: config?.cardReaderPortIndex ?? null,
    // Provisioned kiosk → adopt/reconnect silently; unprovisioned → staff tap Connect.
    trustSingleGrant: !!config?.cardReaderEnabled,
  });
  const { connection, status, busy, lastError, clearError, run, connect } = reader;
  const ready = connection.state === "connected";

  const [note, setNote] = useState<string | null>(null);
  const [binCount, setBinCount] = useState<number | null>(null);
  // Which destructive button is one tap in ("armed"); cleared on any other tap.
  const [armed, setArmed] = useState<"jam" | "bin" | "counter" | null>(null);

  // Status on open (and on reconnect) — every action response also refreshes
  // it via the client's own status push.
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (!ready || refreshedRef.current) return;
    refreshedRef.current = true;
    void run("reading status", (c) => c.getStatus());
  }, [ready, run]);

  const act = useCallback(
    async (label: string, fn: Parameters<typeof run>[1], done?: (v: unknown) => string | null) => {
      setNote(null);
      setArmed(null);
      clearError();
      const v = await run(label, fn);
      // run() returns undefined exactly when the op faulted (lastError is set
      // and the fault panel renders); every action here resolves to a value.
      if (v !== undefined) setNote(done ? done(v) : null);
      return v;
    },
    [run, clearError],
  );

  const pushOut = () =>
    act(
      "pushing out a card",
      async (c) => {
        // The guest buy's proven feed (stacker → read station, with its own
        // fallback), then hand it out at the gate. The read is a bonus — it
        // tells staff WHICH account just left the machine.
        let account: string | null = null;
        try {
          const mag = await c.issueAndReadCard();
          account = mag.cardNumber ?? null;
        } catch (err) {
          // Unreadable card can still be handed out; NO card at all cannot.
          const s = await c.getStatus().catch(() => null);
          if (!s || s.status.card === "none") throw err;
        }
        await c.presentCard();
        return account;
      },
      (v) =>
        v
          ? `Card ${String(v)} is out at the gate — take it before the next action.`
          : "Card is out at the gate (couldn't read its number).",
    );

  const takeBack = () =>
    act(
      "taking the card back",
      async (c) => {
        // HARD RULE: never bin into a full reject bin (it jams the transport).
        const s = await c.getStatus();
        if (s.status.errorBin === "full") {
          throw new Error("Reject bin is FULL — empty it first, then try again.");
        }
        await c.captureCard();
      },
      () => "Card sent to the reject bin.",
    );

  const clearJam = () =>
    act(
      "clearing the jam",
      (c) => c.init("capture"),
      () => "Reader re-initialized — any card inside went to the reject bin.",
    );

  const resetReader = () =>
    act(
      "resetting the reader",
      (c) => c.init("leaveCard"),
      () => "Reader re-initialized. A card inside stayed where it was.",
    );

  const gate = (enabled: boolean) =>
    act(
      enabled ? "opening the gate" : "closing the gate",
      (c) => c.setEntry(enabled),
      () =>
        enabled ? "Gate open — the reader will accept a card." : "Gate closed — cards are refused.",
    );

  const readBin = () =>
    act(
      "reading the bin counter",
      (c) => c.readBinCounter(),
      (v) => {
        const r = v as { value: number | null } | undefined;
        setBinCount(r?.value ?? null);
        return r?.value == null ? "Counter not reported by this unit." : null;
      },
    );

  const resetBin = () =>
    act(
      "resetting the bin counter",
      (c) => c.resetBinCounter(),
      () => {
        setBinCount(0);
        return "Bin counter reset to 0.";
      },
    );

  /** Two-tap confirm wrapper for the destructive actions. */
  const confirmThen = (key: "jam" | "bin" | "counter", fn: () => void) => {
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    fn();
  };

  const stacker = STACKER_LABEL[status?.stacker ?? "unknown"];
  const bin = BIN_LABEL[status?.errorBin ?? "unknown"];
  const fault = lastError ? faultText(lastError) : null;

  const btn =
    "rounded-xl border border-white/15 px-4 py-3 text-sm font-bold text-white/80 disabled:opacity-40";
  const dangerBtn =
    "rounded-xl border border-red-400/40 px-4 py-3 text-sm font-bold text-red-200 disabled:opacity-40";

  return (
    <div className="space-y-4">
      {/* Connection */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold uppercase tracking-widest text-white/40">
              Card dispenser
            </div>
            <div className="mt-1 text-lg font-semibold">
              {connection.state === "connected" && (
                <span className="text-[#46d68c]">Connected</span>
              )}
              {connection.state === "connecting" && (
                <span className="text-amber-300">{connection.detail}</span>
              )}
              {connection.state === "disconnected" && (
                <span className="text-white/60">Not connected</span>
              )}
              {connection.state === "error" && <span className="text-red-300">Not connected</span>}
              {connection.state === "unsupported" && (
                <span className="text-red-300">
                  This browser can&apos;t do Web Serial — open the kiosk in Edge/Chrome on the kiosk
                  PC.
                </span>
              )}
            </div>
          </div>
          {connection.state !== "connected" && connection.state !== "unsupported" && (
            <button
              type="button"
              onClick={() => void connect()}
              className="rounded-xl bg-[#46d68c] px-5 py-3 text-sm font-bold text-[#04250f]"
            >
              Connect
            </button>
          )}
        </div>
        {connection.state === "error" && (
          <p className="mt-3 text-sm text-red-200/90">{connection.message}</p>
        )}
      </div>

      {/* Status */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold uppercase tracking-widest text-white/40">Status</div>
          <button
            type="button"
            disabled={!ready || !!busy}
            onClick={() => void act("reading status", (c) => c.getStatus())}
            className="rounded-full border border-white/15 px-4 py-1.5 text-xs font-bold text-white/60 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
        <div className="mt-3 space-y-2 text-base">
          <div className="flex justify-between gap-4">
            <span className="text-white/55">Card in machine</span>
            <span className="font-semibold">{CARD_LABEL[status?.card ?? "unknown"]}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-white/55">Cards remaining</span>
            <span className={`font-semibold ${TONE_TEXT[stacker.tone]}`}>{stacker.text}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-white/55">Reject bin</span>
            <span className={`font-semibold ${TONE_TEXT[bin.tone]}`}>{bin.text}</span>
          </div>
          {binCount != null && (
            <div className="flex justify-between gap-4">
              <span className="text-white/55">Cards binned since last reset</span>
              <span className="font-semibold">{binCount}</span>
            </div>
          )}
        </div>
      </div>

      {busy && <div className="text-sm font-semibold text-amber-300">Working — {busy}…</div>}

      {fault && (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 p-5">
          <div className="font-bold text-red-200">{fault.title}</div>
          <p className="mt-1 text-sm text-red-100/90">{fault.message}</p>
          {fault.hint && <p className="mt-1 text-sm text-red-100/60">{fault.hint}</p>}
        </div>
      )}
      {note && !fault && (
        <div className="rounded-2xl border border-[#46d68c]/40 bg-[#46d68c]/10 px-5 py-4 text-sm text-[#c6f3dd]">
          {note}
        </div>
      )}

      {/* Everyday actions */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
        <div className="text-sm font-bold uppercase tracking-widest text-white/40">Actions</div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void pushOut()}
          >
            Push out a card
          </button>
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void takeBack()}
          >
            Take the card back
          </button>
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void resetReader()}
          >
            Reset the reader
          </button>
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void readBin()}
          >
            Read bin counter
          </button>
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void gate(true)}
          >
            Allow cards in
          </button>
          <button
            type="button"
            className={btn}
            disabled={!ready || !!busy}
            onClick={() => void gate(false)}
          >
            Stop cards in
          </button>
        </div>
      </div>

      {/* Careful actions — two-tap confirm, consequences spelled out */}
      <div className="rounded-2xl border border-red-400/20 bg-[#0d1a36] p-5">
        <div className="text-sm font-bold uppercase tracking-widest text-red-300/60">
          Careful — these move cards to the reject bin
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            className={dangerBtn}
            disabled={!ready || !!busy}
            onClick={() => confirmThen("jam", () => void clearJam())}
          >
            {armed === "jam" ? "Tap again — card inside goes to the bin" : "Clear a jam"}
          </button>
          <button
            type="button"
            className={dangerBtn}
            disabled={!ready || !!busy}
            onClick={() => confirmThen("counter", () => void resetBin())}
          >
            {armed === "counter" ? "Tap again — counter back to 0" : "Reset bin counter"}
          </button>
        </div>
        <p className="mt-3 text-xs text-white/40">
          Emptied the reject bin? Read the counter first if you want the count, then reset it.
        </p>
      </div>
    </div>
  );
}
