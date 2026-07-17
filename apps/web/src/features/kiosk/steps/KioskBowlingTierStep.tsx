"use client";

/**
 * Kiosk "Pick your lanes" — Classic vs VIP Suites (owner: the preview looks much
 * better than the reused web tier step). Kiosk-native Podium glass photo cards
 * at canvas scale. It writes ONLY item.tier ("regular"|"vip") — the exact same
 * contract as the web BowlingTierStep.selectTier — so the downstream offer step
 * (which filters experiences by item.tier and does the duration + slot + QAMF
 * hold) is unchanged and no pricing/reserve path is touched.
 *
 * Bowling-only: KBF keeps the web tier step (its regular=free / VIP=$2-per-person
 * pricing is not per-lane). Duration chips stay on the offer step.
 */
import { useEffect, useState } from "react";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { KIOSK_PHOTOS } from "../assets";
import { BrandedLoader } from "../components/BrandedLoader";

const CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  3148: "PPTR5G2N0QXF7", // HeadPinz Naples
};

/** Per-lane, per-hour base price = the primary (sortOrder 0) item of the tier's
 *  hourly experience — matches BowlingOfferStep's price source. */
function primaryPriceCents(exps: BowlingExperienceWithDetails[], vip: boolean): number | null {
  const e =
    exps.find((x) => x.isVip === vip && x.kind === "hourly") ?? exps.find((x) => x.isVip === vip);
  if (!e) return null;
  const primary = e.items?.find((i) => i.sortOrder === 0) ?? e.items?.[0];
  return primary?.priceCents ?? null;
}

const KioskBowlingTierStepComponent: StepDef<BowlingItem>["Component"] = ({ item, onChange }) => {
  const centerId = item.qamfCenterId ?? 9172;
  const centerCode = CENTER_CODES[centerId] ?? "TXBSQN0FEKQ11";
  const [exps, setExps] = useState<BowlingExperienceWithDetails[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
        const data = await res.json();
        const raw: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        setExps(raw.filter((e) => !e.slug.startsWith("world-cup-") && e.kind !== "kbf"));
      } catch {
        setExps([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [centerCode]);

  if (loading) {
    return (
      <div className="flex justify-center py-[48px]">
        <BrandedLoader brand="headpinz" size={160} label="Loading lanes…" />
      </div>
    );
  }

  const hasVip = exps.some((e) => e.isVip);
  const regularPrice = primaryPriceCents(exps, false);
  const vipPrice = primaryPriceCents(exps, true);

  const card = (
    vip: boolean,
    photo: string,
    title: string,
    sub: string,
    priceCents: number | null,
    accent: string,
  ) => {
    const selected = item.tier === (vip ? "vip" : "regular");
    return (
      <button
        type="button"
        onClick={() => onChange({ tier: vip ? "vip" : "regular" })}
        aria-label={title}
        className="k-ph k-tap relative h-[440px] overflow-hidden rounded-[28px] border-2 text-left"
        style={
          {
            ["--k-img"]: `url(${photo})`,
            borderColor: selected ? "#00e2e5" : "rgba(255,255,255,0.12)",
            boxShadow: selected ? "0 0 44px rgba(0,226,229,0.22)" : "none",
          } as React.CSSProperties
        }
      >
        {vip && (
          <div className="k-eyebrow absolute left-[32px] top-[32px]" style={{ color: accent }}>
            Upgrade
          </div>
        )}
        {selected && (
          <div className="absolute right-[28px] top-[28px] grid h-[56px] w-[56px] place-items-center rounded-full bg-[#00e2e5] text-[32px] font-bold text-[#04252b]">
            ✓
          </div>
        )}
        <div className="absolute inset-x-[32px] bottom-[32px]">
          <div className="k-display text-[52px] leading-none">{title}</div>
          <div className="mt-[10px] text-[26px] text-white/65">{sub}</div>
          {priceCents != null && (
            <div className="mt-[14px] text-[30px] font-extrabold tabular-nums">
              ${(priceCents / 100).toFixed(2)}
              <span className="text-[22px] font-semibold text-white/55"> /lane per hour</span>
            </div>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-[8px]" style={{ background: accent }} />
      </button>
    );
  };

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">
        Standard lanes or the VIP suite with lounge service — pick your time next.
      </p>
      <div className={`grid gap-[24px] ${hasVip ? "grid-cols-2" : "grid-cols-1"}`}>
        {card(
          false,
          KIOSK_PHOTOS.bowl,
          "Classic Lanes",
          "The house favorite — up to 8 per lane",
          regularPrice,
          "#fd5b56",
        )}
        {hasVip &&
          card(
            true,
            KIOSK_PHOTOS.vip,
            "VIP Suites",
            "Private suite seating, lounge service to your lane",
            vipPrice,
            "#e8b14c",
          )}
      </div>
    </div>
  );
};

export const KioskBowlingTierStep: StepDef<BowlingItem> = {
  id: "bowling-tier", // keep web id — offer step + cursors align
  title: "Lanes",
  Component: KioskBowlingTierStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.tier ? true : { reason: "Pick Classic or VIP." }),
};
