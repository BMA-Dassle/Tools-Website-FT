"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { chromeFlagsForPath, type ChromeFlags } from "~/lib/constants/chrome-routes";

/**
 * Keeps a slot of site chrome honest across client-side navigations.
 *
 * `app/layout.tsx` decides the chrome from request headers set by middleware —
 * correct for the document the browser loads, and then frozen: a root layout
 * does not re-render when you navigate (Next.js partial rendering). So the nav
 * that was right on /pricing stayed on screen after clicking through to
 * /waiver, which renders its own header, and only a hard refresh cleared it.
 *
 * This gate re-asks the shared registry (~/lib/constants/chrome-routes) on
 * every navigation:
 *
 *   - First render (the entry path, server AND hydration) uses `entry`
 *     verbatim. The server's answer is the better one there — it saw the real
 *     host, the /hp rewrite and the dev-brand cookie — and using it guarantees
 *     the client's first paint matches the SSR markup.
 *   - Any later path is computed from the registry.
 *
 * Deliberate asymmetry: the server still decides whether a slot's component is
 * rendered into the tree at all, so this gate can HIDE chrome but never
 * conjure it. A document that starts chrome-free (/waiver, /join, /r/, /passes/
 * — dead-end screens with no internal links) stays chrome-free, and its bundle
 * stays free of nav/footer JS. If one of those screens ever grows a link INTO
 * the site, drop the `showChrome &&` guard around that slot in app/layout.tsx
 * and this gate will start showing it too.
 */
export default function ChromeGate({
  slot,
  entry,
  children,
}: {
  /** Which flag decides this slot. */
  slot: Exclude<keyof ChromeFlags, "brand">;
  /** The server's answer for the entry path. */
  entry: ChromeFlags;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Captured on the first render of each side — server and client each seed it
  // with their own pathname, so the comparison below is always true during
  // hydration and the two renders agree. That matters because middleware can
  // rewrite the path underneath us (headpinz.com/fort-myers → /hp/fort-myers).
  const [entryPath] = useState(pathname);
  const flags = pathname === entryPath ? entry : chromeFlagsForPath(pathname, entry.brand);
  return flags[slot] ? <>{children}</> : null;
}
