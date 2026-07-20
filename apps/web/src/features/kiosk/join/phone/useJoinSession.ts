"use client";

/**
 * Phone-side session hook: a visibility-aware ~5s meta poll that doubles as
 * the presence heartbeat once the guest ENGAGES (taps a choice) — someone who
 * scans and bails never shows as "in progress" on the kiosk.
 *
 * `ended` is cross-cutting and authoritative-only: a closed payload or a 404
 * sets it (and stops the poll for good); transient network failures never do
 * — they just surface `reconnecting` while the current screen stays put.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PHONE_POLL_MS, type ClientStage } from "../types";
import { endedFromMeta, type EndedReason, type JoinMeta } from "./join-helpers";

export interface JoinSessionState {
  meta: JoinMeta | null; // null = not resolved yet (first poll decides)
  ended: EndedReason | null;
  reconnecting: boolean;
  /** First meaningful tap: mints the clientId, marks this phone in-progress
   *  on the kiosk, and heartbeats immediately. Safe to call repeatedly. */
  engage: (stage?: ClientStage) => void;
  /** Update the stage the kiosk sees (signing-in → waiver → done). */
  setStage: (stage: ClientStage) => void;
  /** Success/ended: stop counting as in-progress (poll keeps running). */
  disengage: () => void;
  /** End the flow from outside the poll (e.g. submit returned 409/410). */
  end: (reason: EndedReason) => void;
  clientId: () => string;
}

export function useJoinSession(code: string, initialMeta: JoinMeta | null): JoinSessionState {
  const [meta, setMeta] = useState<JoinMeta | null>(initialMeta);
  const [ended, setEnded] = useState<EndedReason | null>(() =>
    initialMeta ? endedFromMeta(initialMeta) : null,
  );
  const [reconnecting, setReconnecting] = useState(false);

  const endedRef = useRef<EndedReason | null>(ended);
  const metaSeenRef = useRef(!!initialMeta);
  const engagedRef = useRef(false);
  const stageRef = useRef<ClientStage>("landing");
  const clientIdRef = useRef<string>("");
  const failsRef = useRef(0);

  const end = useCallback((reason: EndedReason) => {
    if (endedRef.current) return; // first end wins
    endedRef.current = reason;
    engagedRef.current = false;
    setEnded(reason);
  }, []);

  const clientId = useCallback(() => {
    if (!clientIdRef.current) clientIdRef.current = crypto.randomUUID();
    return clientIdRef.current;
  }, []);

  const engage = useCallback(
    (stage: ClientStage = "signing-in") => {
      if (endedRef.current) return;
      engagedRef.current = true;
      stageRef.current = stage;
      // Immediate heartbeat so the kiosk's warning appears within a beat.
      void fetch(`/api/kiosk/join/${code}/meta?clientId=${clientId()}&stage=${stage}`, {
        cache: "no-store",
      }).catch(() => {});
    },
    [code, clientId],
  );

  const setStage = useCallback((stage: ClientStage) => {
    stageRef.current = stage;
  }, []);

  const disengage = useCallback(() => {
    engagedRef.current = false;
  }, []);

  useEffect(() => {
    if (endedRef.current) return;
    let alive = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!alive || endedRef.current) return;
      timer = setTimeout(() => void check(), PHONE_POLL_MS);
    };

    const check = async () => {
      if (!alive || endedRef.current || running) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      running = true;
      try {
        const qs =
          engagedRef.current && clientIdRef.current
            ? `?clientId=${clientIdRef.current}&stage=${stageRef.current}`
            : "";
        const res = await fetch(`/api/kiosk/join/${code}/meta${qs}`, { cache: "no-store" });
        if (res.status === 404) {
          // Ever saw the session → it aged out; never saw it → bad link.
          end(metaSeenRef.current ? "expired" : "invalid");
          return;
        }
        if (!res.ok) throw new Error(`meta ${res.status}`);
        const data = (await res.json()) as JoinMeta;
        failsRef.current = 0;
        metaSeenRef.current = true;
        if (alive) {
          setReconnecting(false);
          setMeta(data);
        }
        const reason = endedFromMeta(data);
        if (reason) end(reason);
      } catch {
        failsRef.current += 1;
        if (alive && failsRef.current >= 4) setReconnecting(true);
      } finally {
        running = false;
        schedule();
      }
    };

    // Resume promptly when the phone comes back (lock screen, app switch,
    // iOS BFCache restore) — the pending timer may be throttled/stale.
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void check();
    };

    void check();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [code, end]);

  return { meta, ended, reconnecting, engage, setStage, disengage, end, clientId };
}
