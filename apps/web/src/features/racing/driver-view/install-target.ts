/**
 * Which "add to home screen" instructions to show, if any.
 *
 * PURE, so the branch that decides what a guest is told can be tested without a
 * browser — every one of these cases is a real device we cannot hold.
 *
 * WHY THE PAGE OFFERS THIS AT ALL: installed, the tracker runs with no address
 * bar, which is most of the screen back on a phone held sideways at arm's
 * length. It is also one tap next time instead of typing a URL at the counter.
 */

export type InstallTarget =
  /** Already running from the home screen — say nothing. */
  | "installed"
  /** iOS Safari: no install API exists, so it has to be instructions. */
  | "ios"
  /** Android: instructions, and usually a real Install button as well. */
  | "android"
  /** A desktop or an unknown agent — not worth the space. */
  | "none";

export interface InstallProbe {
  userAgent: string;
  /** `display-mode: standalone` — true once installed, on both platforms. */
  standalone: boolean;
  /** iOS Safari's own flag, which predates the media query. */
  iosStandalone?: boolean;
  /** iPadOS 13+ reports a Mac user-agent; touch points are what give it away. */
  maxTouchPoints?: number;
}

export function detectInstallTarget(p: InstallProbe): InstallTarget {
  if (p.standalone || p.iosStandalone) return "installed";

  const ua = (p.userAgent || "").toLowerCase();

  // Android first: some Android browsers put "like Mac OS X" in the string, and
  // an iPhone never says "android".
  if (ua.includes("android")) return "android";

  if (/iphone|ipod/.test(ua)) return "ios";
  if (ua.includes("ipad")) return "ios";
  // iPadOS 13+ masquerades as desktop Safari. A Mac with a touchscreen does not
  // exist, so touch points on a "macintosh" is an iPad.
  if (ua.includes("macintosh") && (p.maxTouchPoints ?? 0) > 1) return "ios";

  return "none";
}

/**
 * Whether to expect Chrome's `beforeinstallprompt`.
 *
 * Only Chromium offers it, and only on Android in practice. Never on iOS, where
 * Apple has never shipped it — which is exactly why the iOS path has to be
 * words rather than a button. Firefox on Android does not fire it either, so
 * the instructions must stand on their own and the button is a bonus.
 */
export function mayPromptToInstall(target: InstallTarget, userAgent: string): boolean {
  if (target !== "android") return false;
  const ua = (userAgent || "").toLowerCase();
  return ua.includes("chrome") || ua.includes("chromium") || ua.includes("edg");
}
