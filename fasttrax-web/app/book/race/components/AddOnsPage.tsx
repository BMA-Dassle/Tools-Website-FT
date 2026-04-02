"use client";

import { useState } from "react";
import Image from "next/image";

export interface AddOnItem {
  id: string;
  name: string;
  shortName: string;
  description: string;
  price: number;
  image: string;
  perPerson: boolean; // true = per racer, false = per group (up to X people)
  maxPerGroup?: number; // e.g. Shuffly up to 10, Duck Pin up to 6
  color: string;
  quantity: number; // selected quantity
}

interface AddOnsPageProps {
  racerCount: number;
  onContinue: (addOns: AddOnItem[]) => void;
  onBack: () => void;
}

const ADD_ONS: Omit<AddOnItem, "quantity">[] = [
  {
    id: "27488020",
    name: "FastTrax Shuffly 1 Hour Combo",
    shortName: "Shuffly",
    description: "A modern twist on classic shuffleboard with immersive AR effects, automatic scoring, and dynamic LED lighting. Up to 10 players per lane.",
    price: 10,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly.webp",
    perPerson: false,
    maxPerGroup: 10,
    color: "#E53935",
  },
  {
    id: "23345635",
    name: "Duck Pin - 1 Hour",
    shortName: "Duckpin Bowling",
    description: "Fast, fun bowling with smaller pins and lighter balls. No rental shoes required! Perfect for groups between races.",
    price: 35,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06561.webp",
    perPerson: false,
    maxPerGroup: 6,
    color: "#004AAD",
  },
  {
    id: "27488200",
    name: "HeadPinz Gel Blasters Combo",
    shortName: "Gel Blaster",
    description: "Step into a live-action video game! High-tech blasters, glowing environments, and fast-paced team battles using eco-friendly Gellets.",
    price: 10,
    image: "https://headpinz.com/wp-content/uploads/2025/05/fondo-1.png",
    perPerson: true,
    color: "#39FF14",
  },
  {
    id: "8976685",
    name: "HeadPinz Laser Tag",
    shortName: "Laser Tag",
    description: "Immersive team-based battles with advanced laser blasters and vests in a glowing arena filled with lights, fog, and music.",
    price: 10,
    image: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-1.webp",
    perPerson: true,
    color: "#E53935",
  },
  {
    id: "30084297",
    name: "POV Video Footage",
    shortName: "POV Camera",
    description: "Pre-pay online for your ViewPoint camera footage and save $2! Relive every turn and overtake from your kart's perspective.",
    price: 5,
    image: "",
    perPerson: true,
    color: "#00E2E5",
  },
];

export default function AddOnsPage({ racerCount, onContinue, onBack }: AddOnsPageProps) {
  const [selections, setSelections] = useState<Record<string, number>>({});

  function getQty(id: string) {
    return selections[id] || 0;
  }

  function setQty(id: string, qty: number) {
    setSelections(prev => ({ ...prev, [id]: Math.max(0, qty) }));
  }

  function handleContinue() {
    const addOns: AddOnItem[] = ADD_ONS
      .filter(a => getQty(a.id) > 0)
      .map(a => ({ ...a, quantity: getQty(a.id) }));
    onContinue(addOns);
  }

  const totalAddOns = Object.values(selections).reduce((s, q) => s + q, 0);
  const totalCost = ADD_ONS.reduce((sum, a) => sum + a.price * getQty(a.id), 0);

  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          Level Up Your Visit
        </h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          Add more fun to your race day. These combos are exclusive to online booking.
        </p>
      </div>

      <div className="grid gap-4">
        {ADD_ONS.map(addon => {
          const qty = getQty(addon.id);
          const isSelected = qty > 0;
          const priceLabel = addon.perPerson
            ? `$${addon.price}/person`
            : `$${addon.price}${addon.maxPerGroup ? ` (up to ${addon.maxPerGroup} players)` : ""}`;

          return (
            <div
              key={addon.id}
              className={`rounded-xl border overflow-hidden transition-all duration-200 ${
                isSelected
                  ? "border-[#00E2E5]/50 bg-[#00E2E5]/5 ring-1 ring-[#00E2E5]/20"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20"
              }`}
            >
              <div className="flex flex-col sm:flex-row">
                {/* Image */}
                {addon.image && (
                  <div className="relative w-full sm:w-40 h-32 sm:h-auto shrink-0">
                    <Image
                      src={addon.image}
                      alt={addon.shortName}
                      fill
                      className="object-cover"
                      sizes="(max-width: 640px) 100vw, 160px"
                    />
                    <div
                      className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: addon.color }}
                    >
                      {addon.shortName}
                    </div>
                  </div>
                )}

                {/* Content */}
                <div className="flex-1 p-4 flex flex-col justify-between gap-3">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-white font-bold text-sm">{addon.name}</h3>
                      <span className="text-[#00E2E5] font-bold text-sm shrink-0">{priceLabel}</span>
                    </div>
                    <p className="text-white/40 text-xs mt-1 leading-relaxed">{addon.description}</p>
                  </div>

                  {/* Quantity controls */}
                  <div className="flex items-center justify-between">
                    {addon.perPerson ? (
                      // Per person: show quantity picker (default to racer count)
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setQty(addon.id, qty - 1)}
                          disabled={qty === 0}
                          className="w-8 h-8 rounded-lg border border-white/20 text-white/60 hover:border-white/40 hover:text-white disabled:opacity-30 transition-colors flex items-center justify-center text-lg"
                        >
                          -
                        </button>
                        <span className="w-8 text-center text-white font-bold text-sm">{qty}</span>
                        <button
                          onClick={() => setQty(addon.id, qty + 1)}
                          className="w-8 h-8 rounded-lg border border-white/20 text-white/60 hover:border-white/40 hover:text-white transition-colors flex items-center justify-center text-lg"
                        >
                          +
                        </button>
                        {qty === 0 && (
                          <button
                            onClick={() => setQty(addon.id, racerCount)}
                            className="ml-2 text-[#00E2E5] text-xs font-semibold hover:underline"
                          >
                            Add for all {racerCount} racer{racerCount !== 1 ? "s" : ""}
                          </button>
                        )}
                      </div>
                    ) : (
                      // Per group: toggle on/off
                      <button
                        onClick={() => setQty(addon.id, qty > 0 ? 0 : 1)}
                        className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors ${
                          isSelected
                            ? "bg-[#00E2E5] text-[#000418]"
                            : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"
                        }`}
                      >
                        {isSelected ? "Added ✓" : "Add to Booking"}
                      </button>
                    )}

                    {qty > 0 && (
                      <span className="text-[#00E2E5] text-sm font-semibold">
                        ${(addon.price * qty).toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary + CTA */}
      <div className={`rounded-xl border p-5 transition-all duration-300 ${
        totalAddOns > 0 ? "border-[#00E2E5]/40 bg-[#00E2E5]/8" : "border-white/10 bg-white/3"
      }`}>
        {totalAddOns > 0 ? (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-white/50 text-xs mb-1">{totalAddOns} add-on{totalAddOns !== 1 ? "s" : ""} selected</p>
              <p className="text-[#00E2E5] font-bold text-lg">+${totalCost.toFixed(2)}</p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={handleContinue}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
              >
                Continue with Add-Ons →
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-white/30 text-sm">No add-ons selected</p>
            <button
              onClick={() => onContinue([])}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
            >
              Skip — Continue to Checkout →
            </button>
          </div>
        )}
      </div>

      <button onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Back to heat selection
      </button>
    </div>
  );
}
