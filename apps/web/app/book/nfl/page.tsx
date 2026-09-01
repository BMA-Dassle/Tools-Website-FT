import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { qamfCenterIdForCode } from "~/features/booking/types";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { nflTileData } from "~/features/nfl/landing.server";
import { normalizeLocationSlug } from "@/lib/attractions-data";

/**
 * `/book/nfl` — the short, shareable way into NFL Ticket on NeoVerse.
 *
 * TWO STATES, ONE SWITCH. While the package is bookable this is a redirect to
 * `/book/bowling/v2?experience=nfl`; while it is not, it is a Coming Soon page.
 * Both read `nflTileData`, which is the same thing the /book landing tile reads,
 * so the tile and the link can never disagree — flipping the two nfl-vip-*
 * experience rows moves both at once, with no deploy.
 *
 * The redirect is deliberately not a second copy of the wizard:
 * `app/book/[attraction]/v2/page.tsx` carries metadata, promo resolution and
 * brand/host handling that a duplicate would immediately start drifting from.
 * Other query params ride along, so `/book/nfl?promo=X&location=naples` behaves
 * exactly like the long form; `experience` itself is dropped from the carried
 * set and re-added, so a hand-edited `?experience=world-cup` on this path cannot
 * smuggle the guest into a different package.
 *
 * Why a page and not a 404 while it is dark: this link goes on printed QR codes
 * and in the front desk's mouth. It has to say something useful the day before
 * launch, not fall over.
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

const VIOLET = "#A78BFA";

export default async function BookNflPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const first = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v.find((x) => x?.trim()) : (v?.trim() ?? undefined);

  // Fort Myers is the only centre with a block model, so a link that names no
  // location still resolves — mirroring what BookingFlow seeds.
  const locationParam = normalizeLocationSlug(first(sp.location)) ?? null;
  const centerCodeV2 = locationParam === "naples" ? "naples" : "fort-myers";
  const qamfCenterId = qamfCenterIdForCode(centerCodeV2);
  const squareCenterCode =
    qamfCenterId != null ? (QAMF_TO_CENTER_CODE[qamfCenterId] ?? null) : null;

  const tile = await nflTileData({
    centerCode: squareCenterCode,
    qamfCenterId,
    locationParam,
  });

  if (tile && !tile.comingSoon) {
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

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center px-5 py-16 text-center">
      <span
        className="mx-auto mb-4 inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider"
        style={{ backgroundColor: VIOLET, color: "#1b1033" }}
      >
        Coming Soon
      </span>

      <h1 className="font-display text-3xl font-black uppercase tracking-wider text-white sm:text-4xl">
        NFL Ticket on NeoVerse
      </h1>

      <p className="font-body mt-4 text-sm leading-relaxed text-white/65">
        Pick your game, not a time. Your VIP lane opens 15 minutes before kickoff and is yours for
        three hours, with the game on the NeoVerse LED walls — shoes, a one-topping pizza, 10 wings
        and a soda pitcher included.
      </p>

      {tile?.nextGame && (
        <p className="mt-5 text-sm font-semibold" style={{ color: VIOLET }}>
          {tile.nextGame}
        </p>
      )}

      <p className="font-body mt-6 text-xs text-white/45">
        Booking isn&apos;t open here yet. Check back soon, or call the centre and we&apos;ll set
        your group up.
      </p>

      <div className="mt-8 flex flex-col items-center gap-3">
        <Link
          href="/book/v2"
          className="rounded-xl border border-white/15 bg-white/[0.04] px-5 py-3 text-sm font-bold text-white/80"
        >
          See everything else to book
        </Link>
      </div>
    </main>
  );
}
