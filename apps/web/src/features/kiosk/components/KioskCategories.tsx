"use client";

/**
 * Kiosk landing after the attract screen: category-first navigation
 * (owner decision 2026-07-17). Three category cards — Experiences /
 * Attractions / Game Zone — then a scoped shelf; guests never see one
 * giant list. Anything already in the cart shows as an itinerary strip
 * so multi-activity stacking is one tap per item.
 *
 * Catalog sources are the SAME ones the website uses (activities-catalog +
 * combo registry): anything enabled online is automatically on the kiosk.
 */
import { useState } from "react";
import {
  landingOfferingsFor,
  type ActivityOffering,
  type BookingSession,
  type Brand,
  type CenterCode,
} from "~/features/booking";
import { enabledCombos, type ComboSpecial } from "~/features/combos";
import { KIOSK_PHOTOS } from "../assets";

type CategoryKey = "exp" | "attr" | "gz";

export interface KioskCategoriesProps {
  brand: Brand;
  center: CenterCode;
  session: BookingSession;
  onPickOffering: (offering: ActivityOffering) => void;
  onPickCombo: (combo: ComboSpecial) => void;
  onOpenCart: () => void;
  onOpenGameZone: () => void;
}

export function KioskCategories({
  brand,
  center,
  session,
  onPickOffering,
  onPickCombo,
  onOpenCart,
  onOpenGameZone,
}: KioskCategoriesProps) {
  const [cat, setCat] = useState<CategoryKey | null>(null);
  const offerings = landingOfferingsFor(brand, center);
  const combos = enabledCombos().filter((c) => c.center === center);
  const hasCart = session.items.length > 0;

  const strip = hasCart ? (
    <button
      type="button"
      onClick={onOpenCart}
      className="mb-5 flex w-full items-center justify-between gap-4 rounded-2xl border border-[#00e2e5]/35 bg-white/[0.04] px-6 py-4 text-left backdrop-blur"
    >
      <div className="min-w-0">
        <div className="font-heading text-xs font-bold uppercase tracking-[0.24em] text-[#00e2e5]">
          Your visit so far
        </div>
        <div className="truncate text-lg text-white/70">
          {session.items.map((i) => labelForItem(i.kind)).join(" · ")}
        </div>
      </div>
      <span className="font-heading shrink-0 text-base font-bold text-[#00e2e5]">View cart ›</span>
    </button>
  ) : null;

  if (cat === null) {
    return (
      <div className="mx-auto flex h-full max-w-4xl flex-col px-6 pb-4 pt-8">
        <h1 className="font-heading mb-6 text-6xl font-extrabold italic leading-none">
          {hasCart ? "Add anything else?" : "What are we doing today?"}
        </h1>
        {strip}
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <CategoryCard
            photo={KIOSK_PHOTOS.vip}
            eyebrow={combos.map((c) => c.name).join(" · ") || "Bundled experiences"}
            eyebrowColor="#e8b14c"
            title="Experiences"
            blurb="Multiple attractions combined into one easy price"
            border="border-[#e8b14c]/50"
            onClick={() => setCat("exp")}
          />
          <CategoryCard
            photo={KIOSK_PHOTOS.race}
            eyebrow={`${offerings.length} attractions`}
            eyebrowColor="#00e2e5"
            title="Attractions"
            blurb="Racing, bowling, blasters & more — pick a time and go"
            border="border-white/10"
            onClick={() => setCat("attr")}
          />
          <CategoryCard
            photo={KIOSK_PHOTOS.arcade}
            eyebrow="Reload — 1 to 10 cards"
            eyebrowColor="#f800c6"
            title="Game Zone"
            blurb="Add arcade tokens to your cards — no waiting"
            border="border-white/10"
            onClick={onOpenGameZone}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6 pb-4 pt-8">
      <button
        type="button"
        onClick={() => setCat(null)}
        className="font-heading mb-4 self-start rounded-full border-2 border-white/15 px-6 py-3 text-sm font-bold uppercase tracking-widest text-white/60"
      >
        ‹ All categories
      </button>
      <h1 className="font-heading mb-6 text-5xl font-extrabold italic leading-none">
        {cat === "exp"
          ? "Pick your experience"
          : cat === "attr"
            ? "Pick an attraction"
            : "Game Zone"}
      </h1>
      {strip}
      <div className="kiosk-scroll min-h-0 flex-1 pb-24">
        {cat === "exp" && (
          <div className="flex flex-col gap-5">
            {combos.map((combo) => (
              <ShelfBanner
                key={combo.id}
                photo={combo.heroImage || KIOSK_PHOTOS.vip}
                eyebrow="Most popular"
                eyebrowColor="#e8b14c"
                title={combo.name}
                blurb={`From $${(combo.price.weekday / 100).toFixed(0)} per person`}
                onClick={() => onPickCombo(combo)}
              />
            ))}
            {combos.length === 0 && (
              <EmptyShelf note="No bundled experiences are running at this location today." />
            )}
          </div>
        )}
        {cat === "attr" && (
          <div className="grid grid-cols-2 gap-4">
            {offerings.map((o) => (
              <OfferingTile key={o.slug} offering={o} onClick={() => onPickOffering(o)} />
            ))}
          </div>
        )}
        {cat === "gz" && (
          <EmptyShelf note="Game Zone cards & token reloads are coming to this kiosk soon — the Game Zone kiosk by the arcade has you covered today." />
        )}
      </div>
    </div>
  );
}

function EmptyShelf({ note }: { note: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-8 py-12 text-center text-xl text-white/55">
      {note}
    </div>
  );
}

function labelForItem(kind: string): string {
  if (kind === "race") return "Racing";
  if (kind === "bowling") return "Bowling";
  if (kind === "kbf") return "Kids Bowl Free";
  return "Attraction";
}

function CategoryCard({
  photo,
  eyebrow,
  eyebrowColor,
  title,
  blurb,
  border,
  onClick,
}: {
  photo: string;
  eyebrow: string;
  eyebrowColor: string;
  title: string;
  blurb: string;
  border: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative min-h-0 flex-1 overflow-hidden rounded-3xl border ${border} text-left`}
    >
      <div
        className="absolute inset-0 bg-cover bg-center [filter:saturate(0.78)_brightness(0.82)]"
        style={{ backgroundImage: `url(${photo})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#040e2c]/60 to-[#071440]/45" />
      <div className="absolute bottom-6 left-8 right-24">
        <div
          className="font-heading text-sm font-bold uppercase tracking-[0.22em]"
          style={{ color: eyebrowColor }}
        >
          {eyebrow}
        </div>
        <div className="font-heading mt-1 text-5xl font-extrabold italic leading-none">{title}</div>
        <div className="mt-2 text-lg text-white/60">{blurb}</div>
      </div>
      <span
        className="absolute bottom-8 right-8 text-4xl font-bold"
        style={{ color: eyebrowColor }}
      >
        ›
      </span>
    </button>
  );
}

function ShelfBanner({
  photo,
  eyebrow,
  eyebrowColor,
  title,
  blurb,
  onClick,
}: {
  photo: string;
  eyebrow: string;
  eyebrowColor: string;
  title: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-44 overflow-hidden rounded-3xl border border-[#e8b14c]/45 text-left"
    >
      <div
        className="absolute inset-0 bg-cover bg-center [filter:saturate(0.78)_brightness(0.82)]"
        style={{ backgroundImage: `url(${photo})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#040e2c]/60 to-[#071440]/45" />
      <div className="absolute inset-y-0 left-8 flex flex-col justify-center">
        <div
          className="font-heading text-sm font-bold uppercase tracking-[0.22em]"
          style={{ color: eyebrowColor }}
        >
          {eyebrow}
        </div>
        <div className="font-heading mt-1 text-4xl font-extrabold italic">{title}</div>
        <div className="mt-1 text-lg text-white/60">{blurb}</div>
      </div>
      <span
        className="absolute right-8 top-1/2 -translate-y-1/2 text-4xl"
        style={{ color: eyebrowColor }}
      >
        ›
      </span>
    </button>
  );
}

function OfferingTile({ offering, onClick }: { offering: ActivityOffering; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative h-56 overflow-hidden rounded-3xl border border-white/10 text-left"
    >
      {offering.heroImage ? (
        <div
          className="absolute inset-0 bg-cover bg-center [filter:saturate(0.78)_brightness(0.82)]"
          style={{ backgroundImage: `url(${offering.heroImage})` }}
        />
      ) : (
        <div className="absolute inset-0 bg-[#071027]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-[#000418]/95 via-[#040e2c]/60 to-[#071440]/45" />
      <div className="absolute bottom-5 left-6 right-6">
        <div className="font-heading text-3xl font-extrabold italic leading-none">
          {offering.displayName}
        </div>
        <div className="mt-1 line-clamp-1 text-base text-white/60">{offering.blurb}</div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-1.5"
        style={{ background: offering.accentColor ?? "#00e2e5" }}
      />
    </button>
  );
}
