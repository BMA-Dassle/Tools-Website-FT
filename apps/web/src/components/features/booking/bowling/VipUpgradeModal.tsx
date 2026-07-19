"use client";

/**
 * VIP upgrade upsell modal — shown after a Regular hold on the v3 Time step
 * when the VIP counterpart is open at the same time (v1/classic parity;
 * content ported from BowlingOfferStep's inline modal, which is deleted with
 * the classic steps). Icons via @tabler/icons-react — no emoji/glyph
 * literals in product UI (repo rule).
 */

import { IconCheck } from "@tabler/icons-react";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";

const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

// VIP suite perks (owner 2026-07-19: "VIP needs some explanation — semi-
// private 8 lane suite, bar, pool table, NeoVerse etc"). Core amenities apply
// to every VIP lane; some experiences add their own inclusions (shoes, pizza)
// on top. Shared by the upsell modal AND the Experience step's VIP section.
export const VIP_CORE_PERKS = [
  "Semi-private 8-lane VIP suite",
  "Private bar",
  "Pool table",
  "NeoVerse video wall",
  "HyperBowling + premium glow lighting",
  "Complimentary chips & salsa",
];
export const VIP_EXTRA_PERKS: Record<string, string[]> = {
  "fun-4-all-vip": ["Bowling shoes included"],
  "pizza-bowl-vip": ["Large one-topping pizza", "Pitcher of soda", "Shoes for up to 6"],
};

export interface VipUpgradeModalProps {
  variant: "web" | "kiosk";
  exp: BowlingExperienceWithDetails;
  /** VIP price minus regular price, per lane/person. <= 0 hides the row. */
  deltaCents: number;
  perLane: boolean;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function VipUpgradeModal(props: VipUpgradeModalProps) {
  const { variant, exp, deltaCents, perLane, busy, onAccept, onDecline } = props;
  const kiosk = variant === "kiosk";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      style={{ backgroundColor: "rgba(0,0,0,0.78)" }}
    >
      <div
        className={`w-full overflow-hidden rounded-2xl ${kiosk ? "max-w-[860px]" : "max-w-md"}`}
        style={{ backgroundColor: "#0d1f3c", border: `2px solid ${GOLD}55` }}
      >
        <div className={`relative overflow-hidden ${kiosk ? "h-[220px]" : "h-36"}`}>
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
          >
            <source src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`} type="video/mp4" />
          </video>
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(to bottom, transparent 30%, #0d1f3c 100%)" }}
          />
          <span
            className={`absolute bottom-3 left-4 rounded-full font-bold uppercase tracking-widest ${
              kiosk ? "px-[18px] py-[8px] text-[20px]" : "px-2.5 py-1 text-[10px]"
            }`}
            style={{ backgroundColor: GOLD, color: "#0a1628" }}
          >
            VIP Upgrade
          </span>
        </div>

        <div className={kiosk ? "p-[32px]" : "p-5"}>
          <h3
            className={`mb-1 font-display uppercase tracking-wider text-white ${
              kiosk ? "text-[40px]" : "text-xl"
            }`}
            style={{ textShadow: `0 0 20px ${GOLD}40` }}
          >
            Upgrade to VIP?
          </h3>
          <p className={`mb-4 text-white/55 ${kiosk ? "text-[24px]" : "text-sm"}`}>
            {exp.description}
          </p>

          <ul className={`mb-5 ${kiosk ? "space-y-[12px]" : "space-y-2"}`}>
            {[...VIP_CORE_PERKS, ...(VIP_EXTRA_PERKS[exp.slug] ?? [])].map((perk) => (
              <li key={perk} className="flex items-center gap-2">
                <span
                  className={`flex shrink-0 items-center justify-center rounded-full ${
                    kiosk ? "h-[28px] w-[28px]" : "h-4 w-4"
                  }`}
                  style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                >
                  <IconCheck size={kiosk ? 20 : 11} stroke={3} aria-hidden />
                </span>
                <span className={`text-white/75 ${kiosk ? "text-[24px]" : "text-sm"}`}>{perk}</span>
              </li>
            ))}
          </ul>

          {deltaCents > 0 && (
            <div
              className={`mb-5 flex items-center justify-between rounded-xl ${
                kiosk ? "px-[24px] py-[18px]" : "px-4 py-3"
              }`}
              style={{ backgroundColor: `${GOLD}12`, border: `1px solid ${GOLD}30` }}
            >
              <span className={`text-white/55 ${kiosk ? "text-[24px]" : "text-sm"}`}>
                VIP upgrade
              </span>
              <span
                className={`font-display font-bold ${kiosk ? "text-[30px]" : "text-lg"}`}
                style={{ color: GOLD }}
              >
                +{centsToDollars(deltaCents)}
                <span className={`font-normal text-white/40 ${kiosk ? "text-[22px]" : "text-sm"}`}>
                  /{perLane ? "lane" : "person"}
                </span>
              </span>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onDecline}
              className={`flex-1 rounded-full border border-white/20 font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/40 hover:text-white ${
                kiosk ? "k-tap py-[18px] text-[24px]" : "py-3 text-sm"
              }`}
            >
              No Thanks
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              className={`flex-1 rounded-full font-bold uppercase tracking-wider text-[#0a1628] transition-all hover:scale-[1.02] disabled:opacity-60 ${
                kiosk ? "k-tap py-[18px] text-[24px]" : "py-3 text-sm"
              }`}
              style={{ backgroundColor: GOLD, boxShadow: `0 0 18px ${GOLD}40` }}
            >
              Upgrade
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
