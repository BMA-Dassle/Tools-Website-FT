"use client";

export interface SavedCard {
  id: string;
  brand: string;       // "VISA", "MASTERCARD", etc.
  last4: string;       // "4242"
  expMonth: number;
  expYear: number;
  expired: boolean;
}

interface SavedCardSelectorProps {
  cards: SavedCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string | null) => void;  // null = "use new card"
}

const BRAND_ICONS: Record<string, string> = {
  VISA: "💳",
  MASTERCARD: "💳",
  AMERICAN_EXPRESS: "💳",
  DISCOVER: "💳",
  JCB: "💳",
};

const BRAND_LABELS: Record<string, string> = {
  VISA: "Visa",
  MASTERCARD: "Mastercard",
  AMERICAN_EXPRESS: "Amex",
  DISCOVER: "Discover",
  JCB: "JCB",
};

export default function SavedCardSelector({ cards, selectedCardId, onSelect }: SavedCardSelectorProps) {
  const validCards = cards.filter(c => !c.expired);
  const expiredCards = cards.filter(c => c.expired);

  return (
    <div className="space-y-2">
      <p className="text-white/50 text-xs uppercase tracking-wider font-semibold mb-2">Saved Cards</p>

      {validCards.map(card => (
        <button
          key={card.id}
          onClick={() => onSelect(card.id)}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
            selectedCardId === card.id
              ? "border-[#00E2E5] bg-[#00E2E5]/10"
              : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/8"
          }`}
        >
          <span className="text-lg">{BRAND_ICONS[card.brand] || "💳"}</span>
          <div className="flex-1">
            <p className="text-white text-sm font-semibold">
              {BRAND_LABELS[card.brand] || card.brand} ending in {card.last4}
            </p>
            <p className="text-white/40 text-xs">
              Expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
            </p>
          </div>
          {selectedCardId === card.id && (
            <div className="w-5 h-5 rounded-full bg-[#00E2E5] flex items-center justify-center shrink-0">
              <svg className="w-3 h-3 text-[#000418]" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          )}
        </button>
      ))}

      {expiredCards.map(card => (
        <div
          key={card.id}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-white/5 bg-white/[0.02] opacity-50"
        >
          <span className="text-lg">💳</span>
          <div className="flex-1">
            <p className="text-white/50 text-sm">
              {BRAND_LABELS[card.brand] || card.brand} ending in {card.last4}
            </p>
            <p className="text-red-400 text-xs">Expired</p>
          </div>
        </div>
      ))}

      {/* Use a different card option */}
      <button
        onClick={() => onSelect(null)}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
          selectedCardId === null
            ? "border-[#00E2E5] bg-[#00E2E5]/10"
            : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/8"
        }`}
      >
        <span className="text-lg">+</span>
        <p className="text-white text-sm font-semibold">Use a different card</p>
        {selectedCardId === null && (
          <div className="ml-auto w-5 h-5 rounded-full bg-[#00E2E5] flex items-center justify-center shrink-0">
            <svg className="w-3 h-3 text-[#000418]" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </button>
    </div>
  );
}
