import { redirect } from "next/navigation";
import type { Metadata } from "next";

/**
 * `/book/nfl` — the short, shareable way into NFL Ticket on NeoVerse.
 *
 * A redirect, not a second copy of the wizard. The real entry is
 * `/book/bowling/v2?experience=nfl`, and `app/book/[attraction]/v2/page.tsx`
 * carries metadata, promo resolution and brand/host handling that a duplicate
 * page would immediately start drifting from. This exists so marketing, the
 * front desk and a printed QR have something short to point at — the same job
 * `/book/nfl` does for a guest that `?experience=nfl` does for the code.
 *
 * Every other query param rides along, so `/book/nfl?promo=X&location=naples`
 * behaves exactly like the long form. `experience` itself is dropped from the
 * carried set and re-added, so a hand-edited `?experience=world-cup` on this
 * path cannot smuggle the guest into a different package.
 *
 * A static segment beats the sibling `[attraction]` dynamic segment in Next's
 * route matching, so this does not collide with `/book/gel-blaster` and friends.
 * It is a SECOND-level route under the existing `/book`, so the middleware
 * shared-top-level-route rule does not apply.
 */

export const metadata: Metadata = {
  title: "NFL Ticket on NeoVerse | HeadPinz",
  description:
    "Pick your game. VIP lanes on the NeoVerse LED walls open 15 minutes before kickoff — 3 hours of bowling, shoes, pizza, 10 wings and a soda pitcher.",
};

export default async function BookNflPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "experience") continue; // set below — never taken from the URL
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v) qs.append(key, v);
    }
  }
  qs.set("experience", "nfl");

  redirect(`/book/bowling/v2?${qs.toString()}`);
}
