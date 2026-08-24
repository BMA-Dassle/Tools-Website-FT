"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alarmKey, alarmMessage, type AlarmCue } from "~/features/signage/briefing/desk-alarm";

/**
 * THE BOARD SHOUTS, ONCE PER SLOT.
 *
 * The board says everything in colour and numbers, and on a Saturday night
 * nobody is reading it — staff are scanning wristbands with their heads down.
 * Two moments cost a race if they pass unnoticed, so they get a sound and, when
 * the browser has been given permission, a system notification:
 *
 *   CALL   a session's call time is 30 seconds from gone
 *   SEND   a called group's briefing window is 30 seconds from shut
 *
 * The cadence and the bounds are decided in desk-alarm.ts (pure, tested); this
 * is only the speaker and the notification, plus the play-once bookkeeping.
 *
 * WHY A SET OF KEYS AND NOT A TIMER. The board ticks every second, so a naive
 * "play while closing" would play ten times per slot. Every cue carries a key
 * (kind + session + slot) and a key plays exactly once, ever, in this tab. That
 * also means a re-render, a poll landing, or a clock correction cannot double a
 * play.
 *
 * NEVER THROWS INTO THE BOARD. Same posture as useScanSound: a blocked autoplay
 * policy, a missing file, a browser with no Audio or no Notification — every one
 * of them is swallowed. A silent alarm is a bad night; a board that white-screens
 * because a sound failed is a lost one.
 *
 * ⚠️ THIS ONLY REACHES A MACHINE WITH THE BOARD OPEN. It is the Notification
 * API from the page, not Web Push — nothing is delivered to a phone in a
 * pocket. See tasks/desk-push-notifications.md for what true push needs.
 */

const SOUND_URL = "/sounds/send-window-closing.mp3";
/** Per-station, like the scan sound and the baud rate — not a server setting. */
const STORAGE_KEY = "checkin-desk-alarm";

export interface DeskAlarm {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Fire a cue. Safe to call every tick — a key plays once. */
  fire: (cue: AlarmCue | null) => void;
  /** Hear it now, with no cue — the gear's test button. */
  preview: () => void;
  /** Browser notification permission, so the gear can offer to ask for it. */
  notifyPermission: NotificationPermission | "unsupported";
  requestNotify: () => void;
  /** Is THIS device registered for push alerts (a phone, or this PC)? */
  pushRegistered: boolean;
  pushBusy: boolean;
  /** Register or drop this device. Needs the server's VAPID public key. */
  registerPush: (publicKey: string) => Promise<void>;
  unregisterPush: () => Promise<void>;
}

/** Turns the base64url VAPID key into the byte view the subscribe call wants.
 *  Typed as ArrayBuffer-backed explicitly: the DOM signature rejects a
 *  possibly-shared buffer, which is what a bare Uint8Array widens to. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function readStored(): boolean {
  try {
    // ON by default: this is an alarm ops asked for, and a default-off alarm is
    // one nobody knows exists until the night it was needed.
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * `token` is the admin token already in the page's URL — the push endpoints sit
 * behind the same gate as every other board action, and a hook that cannot
 * authenticate would silently no-op.
 */
export function useDeskAlarm(token: string): DeskAlarm {
  // Lazy initialisers, the same shape the baud rate uses: read the station's
  // own settings once, on the client, with no state-set inside an effect.
  const [enabled, setEnabledState] = useState<boolean>(() =>
    typeof window === "undefined" ? true : readStored(),
  );
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">(
    () => {
      try {
        return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
      } catch {
        return "unsupported";
      }
    },
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playedRef = useRef<Set<string>>(new Set());
  const enabledRef = useRef(enabled);

  /** Preload the clip once, so the first alarm of the night is not the one that
   *  waits on the network. Audio is client-only, hence the effect. */
  useEffect(() => {
    try {
      const el = new Audio(SOUND_URL);
      el.preload = "auto";
      audioRef.current = el;
    } catch {
      audioRef.current = null;
    }
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    enabledRef.current = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      // A station in private mode still gets the setting for this shift.
    }
  }, []);

  /** RESTART, NEVER STACK — the same rule the scan sounds run. Two alarms
   *  overlapping is worse than either alone. */
  const play = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
      void el.play().catch(() => {});
    } catch {
      // Autoplay policy, a decoding failure, a muted device — none of them are
      // the board's problem.
    }
  }, []);

  const preview = useCallback(() => play(), [play]);

  const requestNotify = useCallback(() => {
    try {
      if (typeof Notification === "undefined") return;
      void Notification.requestPermission().then((p) => setNotifyPermission(p));
    } catch {
      // Some embedded browsers throw rather than resolve. Nothing to do.
    }
  }, []);

  /* ── push: this device, and the fan-out to every other one ───────────── */

  const [pushRegistered, setPushRegistered] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  /** Ask the browser whether this device already holds a subscription, so the
   *  gear opens showing the truth rather than "off" on a registered phone. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
        const sub = await reg?.pushManager.getSubscription();
        if (!cancelled) setPushRegistered(!!sub);
      } catch {
        // No service-worker support, or a browser that refuses the query.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const postAction = useCallback(
    async (payload: Record<string, unknown>) => {
      await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    [token],
  );

  const registerPush = useCallback(
    async (publicKey: string) => {
      setPushBusy(true);
      try {
        if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return;
        // Permission first: subscribing without it throws on some browsers and
        // silently yields a useless subscription on others.
        const perm = await Notification.requestPermission();
        setNotifyPermission(perm);
        if (perm !== "granted") return;
        const reg = await navigator.serviceWorker.register("/sw-push.js");
        await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            // Required true by every browser that implements this — a
            // non-visible push is not allowed on the web.
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          }));
        await postAction({ action: "push-subscribe", subscription: sub.toJSON() });
        setPushRegistered(true);
      } catch {
        setPushRegistered(false);
      } finally {
        setPushBusy(false);
      }
    },
    [postAction],
  );

  const unregisterPush = useCallback(async () => {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration("/sw-push.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Tell the server BEFORE dropping the local subscription: once the
        // endpoint is gone from this device we can no longer name it.
        await postAction({ action: "push-unsubscribe", endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => {});
      }
      setPushRegistered(false);
    } catch {
      // Leave the flag alone — the next open re-reads the real state.
    } finally {
      setPushBusy(false);
    }
  }, [postAction]);

  const fire = useCallback(
    (cue: AlarmCue | null) => {
      if (!cue || !enabledRef.current) return;
      const key = alarmKey(cue);
      if (playedRef.current.has(key)) return;
      playedRef.current.add(key);
      // A night's worth of keys is a few hundred strings, but a board left open
      // for a week is not — so the set is trimmed rather than grown forever.
      if (playedRef.current.size > 500) playedRef.current.clear();
      play();
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          const { title, body } = alarmMessage(cue);
          // `tag` collapses the three slots of one event into one notification
          // that updates, rather than three stacking up on the desktop.
          new Notification(title, { body, tag: `${cue.kind}:${cue.sessionId}` });
        }
      } catch {
        // Notification constructors throw in a few embedded webviews.
      }
      /**
       * AND OUT TO EVERY REGISTERED DEVICE. Fired even when this station is not
       * itself subscribed — the board is the TRIGGER for the estate, not a
       * participant in it, which is what lets a manager's phone buzz while the
       * desk PC is the only thing with the board open. The server claims each
       * (kind, session, slot) so two open boards cannot double a buzz, and it
       * no-ops entirely when the VAPID keys are unset.
       *
       * Deliberately not awaited and never surfaced: a failed fan-out must not
       * delay or break the local sound, which is the primary alarm.
       */
      void postAction({ action: "push-fire", cue }).catch(() => {});
    },
    [play, postAction],
  );

  return {
    enabled,
    setEnabled,
    fire,
    preview,
    notifyPermission,
    requestNotify,
    pushRegistered,
    pushBusy,
    registerPush,
    unregisterPush,
  };
}
