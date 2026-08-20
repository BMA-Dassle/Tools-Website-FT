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

const cache = new Map<KioskSound, HTMLAudioElement>();

function element(name: KioskSound): HTMLAudioElement | null {
  // Guard for SSR and for the jsdom-less test environment.
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  let el = cache.get(name);
  if (!el) {
    el = new Audio(SRC[name]);
    el.preload = "auto";
    cache.set(name, el);
  }
  return el;
}

/**
 * Prime both tones. Call from the first user gesture: browsers only grant an
 * audio element permission to play once it has been touched off a real event,
 * so this is what makes a later unattended scan audible.
 */
export function unlockKioskSounds(): void {
  for (const name of Object.keys(SRC) as KioskSound[]) {
    const el = element(name);
    if (!el) continue;
    el.load();
    // Play-then-immediately-pause at zero volume is the standard unlock: it
    // consumes the gesture without the guest hearing anything.
    const prevVolume = el.volume;
    el.volume = 0;
    void el
      .play()
      .then(() => {
        el.pause();
        el.currentTime = 0;
        el.volume = prevVolume;
      })
      .catch(() => {
        el.volume = prevVolume;
      });
  }
}

/**
 * Sound one scan outcome. Fire-and-forget by design — a blocked or missing tone
 * must never interrupt the scan it is describing.
 */
export function playScanSound(name: KioskSound): void {
  const el = element(name);
  if (!el) return;
  try {
    el.currentTime = 0;
  } catch {
    // Some browsers throw if the element has not loaded metadata yet; playing
    // from wherever it is beats not playing.
  }
  void el.play().catch(() => {});
}
