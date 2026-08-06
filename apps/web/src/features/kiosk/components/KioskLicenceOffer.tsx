"use client";

import { useState } from "react";
import { useLicenceOffer } from "~/features/racing/components/useLicenceOffer";
import { useT } from "../i18n";

/**
 * The racing licence on the kiosk "you're booked" screen.
 *
 * A KIOSK IS A SHARED SCREEN, so unlike the web confirmation there is no direct
 * "Add to Wallet" here — the pass must never land on the machine in the lobby.
 * Every row is a QR the racer scans with their OWN phone, which is the same
 * bridge the sign-in roster chip uses.
 *
 * Per-racer and named for the same reason as everywhere else: a row of
 * unlabelled codes is how a parent's licence ends up on a child's phone.
 *
 * Shares `useLicenceOffer` with the web confirmation, so the booking is fetched
 * and the party's login codes are warmed by exactly one code path — and a racer
 * who has never been swept still resolves here rather than looking like a
 * first-timer.
 *
 * Nothing is billed by showing this: a licence is created only when a racer
 * scans and the wallet route runs on their phone.
 */
export function KioskLicenceOffer({ billId }: { billId: string | null }) {
  const t = useT();
  const racers = useLicenceOffer(billId);
  const [openFor, setOpenFor] = useState<string | null>(null);

  const eligible = racers?.filter((r) => r.qr) ?? [];
  if (!racers || eligible.length === 0) return null;

  return (
    <div className="mt-[32px] rounded-[28px] border border-[#00e2e5]/30 bg-[#00e2e5]/[0.06] p-[28px]">
      <p className="k-display text-[28px] text-[#00e2e5]">{t("licence.kiosk.title")}</p>
      <p className="mt-[8px] text-[22px] leading-snug text-white/60">{t("licence.kiosk.body")}</p>

      <div className="mt-[20px] flex flex-col divide-y divide-white/10">
        {eligible.map((r) => {
          const open = openFor === r.personId;
          return (
            <div key={r.personId} className="py-[16px]">
              <div className="flex items-center justify-between gap-[16px]">
                <span className="truncate text-[26px] font-bold text-white">{r.name}</span>
                <button
                  type="button"
                  onClick={() => setOpenFor(open ? null : r.personId)}
                  aria-expanded={open}
                  className="shrink-0 rounded-full border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-[20px] py-[10px] text-[20px] font-semibold text-[#00e2e5]"
                >
                  {open ? t("licence.kiosk.hide") : t("licence.kiosk.show")}
                </button>
              </div>

              {open && r.qr && (
                <div className="mt-[14px] flex items-center gap-[20px]">
                  {/* White plate: a QR needs a light quiet zone to scan off a
                      dark kiosk panel at arm's length. */}
                  <div className="shrink-0 rounded-2xl bg-white p-[10px]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                    <img src={r.qr} alt="" width={160} height={160} className="block" />
                  </div>
                  <p className="text-[22px] leading-snug text-white/60">
                    {t("licence.kiosk.scan")}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
