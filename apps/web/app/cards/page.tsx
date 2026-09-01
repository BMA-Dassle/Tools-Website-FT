import type { Metadata } from "next";
import Link from "next/link";

/**
 * Public "Gift & Game Cards" hub. A small router, not a new product surface:
 *   - Game Zone Card  → our own /reload flow (check balance / add tokens)
 *   - Gift Card       → Square (the existing order link the nav already used)
 *
 * It exists so the game-card balance/reload flow is DISCOVERABLE — it was only
 * reachable via a card's printed QR before. The nav/footer "Gift Cards" slot on
 * both brands now points here instead of straight to Square, so nothing new was
 * added to the (full) top nav. Shared top-level route: registered in
 * middleware.ts (isSharedTopLevelRoute) so headpinz.com/cards isn't /hp-rewritten
 * to a 404, and it keeps brand chrome (not in isChromeFreePath).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gift & Game Cards",
  description: "Check your Game Zone card balance, reload it, or buy a gift card.",
  robots: { index: false, follow: false },
};

/** The Square gift-card order link — the same URL the nav/footer used before. */
const GIFT_CARD_URL = "https://squareup.com/gift/2Z728TECCNWSE/order";

export default function CardsPage() {
  return (
    <main className="relative min-h-[70vh] bg-[#00041b] px-5 py-14 text-white">
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-2 text-center">
          <h1 className="font-heading text-3xl font-extrabold italic uppercase sm:text-4xl">
            Gift &amp; Game Cards
          </h1>
          <p className="text-sm text-white/60">
            Check your Game Zone balance, add tokens, or send a gift card.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Game Zone card — our own flow */}
          <Link
            href="/reload"
            className="group flex flex-col rounded-2xl border border-white/10 !border-l-[6px] !border-l-[#00E2E5] bg-[rgba(7,11,28,0.92)] p-6 transition hover:border-white/30 active:scale-[0.99]"
          >
            <div className="font-heading text-xl font-extrabold italic uppercase">
              Game Zone Card
            </div>
            <p className="mt-2 text-sm text-white/60">
              Check your balance — tokens, bonus tokens &amp; eTickets — or add more to a card you
              already have.
            </p>
            <span className="mt-4 text-sm font-semibold text-[#00E2E5]">
              Check balance or reload →
            </span>
          </Link>

          {/* Gift card — Square-hosted, external */}
          <a
            href={GIFT_CARD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col rounded-2xl border border-white/10 !border-l-[6px] !border-l-[#e8b14c] bg-[rgba(7,11,28,0.92)] p-6 transition hover:border-white/30 active:scale-[0.99]"
          >
            <div className="font-heading text-xl font-extrabold italic uppercase">Gift Card</div>
            <p className="mt-2 text-sm text-white/60">
              Give the gift of play — redeemable for bowling, racing, and the Game Zone at HeadPinz
              &amp; FastTrax.
            </p>
            <span className="mt-4 text-sm font-semibold text-[#e8b14c]">Buy a gift card →</span>
          </a>
        </div>

        <p className="text-center text-xs text-white/40">
          Tip: scan the QR on your Game Zone card with your phone to jump straight to it.
        </p>
      </div>
    </main>
  );
}
