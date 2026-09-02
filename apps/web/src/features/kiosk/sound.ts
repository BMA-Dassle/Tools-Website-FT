/**
 * Kiosk scan feedback tones. CLIENT ONLY.
 *
 * A barcode scan has no visible cursor and no keypress — on a busy Saturday a
 * guest cannot tell whether the beam read their voucher, so they scan again,
 * and again. An audible accept/reject is the only immediate feedback the scan
 * path has. (Owner-supplied tones, 2026-08-20.)
 *
 * Three browser realities shape this:
 *
 *  1. AUTOPLAY IS BLOCKED until the page has seen a user gesture. A scan on the
 *     attract screen is exactly that case — nobody has touched anything. So
 *     playback failure is swallowed, never surfaced, and `unlockKioskSounds()`
 *     is called from the first touch to prime the elements.
 *  2. ELEMENTS ARE CACHED. Creating an Audio per scan means the first scan of
 *     each kind is silent while it fetches over venue wifi.
 *  3. `currentTime` MUST BE RESET. A second scan while the first tone is still
 *     playing is a no-op otherwise, which reads as "it didn't hear me" —
 *     precisely the confusion this exists to remove.
 */

export type KioskSound = "success" | "error";

const SRC: Record<KioskSound, string> = {
  success: "/sounds/scan-success.mp3",
  error: "/sounds/scan-error.mp3",
};

/**
 * Playback level for every kiosk tone, 0-1. Half volume (owner 2026-09-02:
 * "take the sound down by 50% without going into every kiosk") — so it lives
 * here, in the one module both tones come from, and ships with the deploy
 * rather than as a per-device setting somebody has to visit
 * eleven machines to change.
 *
 * NOTE this is amplitude, not loudness: 0.5 is about -6dB, which the ear reads
 * as roughly two-thirds as loud rather than half. If the floor still wants it
 * quieter, this is the one number to move.
 */
const SCAN_VOLUME = 0.5;

const cache = new Map<KioskSound, HTMLAudioElement>();

function element(name: KioskSound): HTMLAudioElement | null {
  // Guard for SSR and for the jsdom-less test environment.
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  let el = cache.get(name);
  if (!el) {
    el = new Audio(SRC[name]);
    el.preload = "auto";
    el.volume = SCAN_VOLUME;
    cache.set(name, el);
  }
  return el;
}

/** Set once the unlock has run, so repeat gestures are cheap no-ops. */
let unlocked = false;

/**
 * Prime both tones. Call from the first user gesture: browsers only grant an
 * audio element permission to play once it has been touched off a real event,
 * so this is what makes a later unattended scan audible.
 *
 * Safe to call on EVERY gesture (KioskShell does) — it returns immediately
 * after the first run. That guard is not just an optimisation: this muted the
 * element while priming it, and two overlapping runs could capture the muted
 * value as the "previous" volume and restore silence for the life of the page.
 * Restoring the CONSTANT rather than a captured value removes that race
 * outright; the flag then keeps the work to once.
 */
export function unlockKioskSounds(): void {
  if (unlocked) return;
  if (typeof window === "undefined" || typeof Audio === "undefined") return;
  unlocked = true;
  for (const name of Object.keys(SRC) as KioskSound[]) {
    const el = element(name);
    if (!el) continue;
    el.load();
    // Play-then-immediately-pause at zero volume is the standard unlock: it
    // consumes the gesture without the guest hearing anything.
    el.volume = 0;
    const restore = () => {
      el.volume = SCAN_VOLUME;
    };
    void el
      .play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        restore();
      })
      .catch(restore);
  }
}

/**
 * Sound one scan outcome. Fire-and-forget by design — a blocked or missing tone
 * must never interrupt the scan it is describing.
 */
export function playScanSound(name: KioskSound): void {
  const el = element(name);
  if (!el) return;
  // Re-asserted per play: the unlock mutes the element while priming it, and a
  // scan landing in that window would otherwise play at whatever it was left
  // at. Cheap, and it makes SCAN_VOLUME the single answer to "how loud".
  el.volume = SCAN_VOLUME;
  try {
    el.currentTime = 0;
  } catch {
    // Some browsers throw if the element has not loaded metadata yet; playing
    // from wherever it is beats not playing.
  }
  void el.play().catch(() => {});
}
