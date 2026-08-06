"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
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
export function KioskLicenceOffer({
  billId,
  brand,
}: {
  billId: string | null;
  brand?: string;
}) {
  const t = useT();
  const racers = useLicenceOffer(billId);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [allQr, setAllQr] = useState<string | null>(null);
  /** Per-racer QRs, generated here so they land on the same prepare-and-wait
   *  page as the bundle rather than redirecting into a not-yet-rendered pass. */
  const [oneQr, setOneQr] = useState<Record<string, string>>({});

  const eligible = racers?.filter((r) => r.qr) ?? [];

  // ADD EVERYONE, TO ONE PHONE. A kiosk is a shared screen so the bundle cannot
  // land here — this QR carries the whole party to whichever phone scans it,
  // which is the parent-with-three-kids case the bundle exists for.
  //
  // Points at /passes/{billId}, a page whose ONLY job is this — not the
  // confirmation page, where a guest who scanned to collect licences would land
  // on a long booking page and have to hunt for a card partway down it.
  //
  // Not the .pkpasses file directly either: we have no idea which platform is
  // about to scan a kiosk screen, and that page detects it — Apple starts the
  // one-tap bundle automatically, Android gets a badge per racer. A bundle URL
  // would hand an Android guest a file they cannot open.
  useEffect(() => {
    if (!billId || eligible.length < 2) return;
    const domain = brand === "headpinz" ? "https://headpinz.com" : "https://fasttraxent.com";
    let cancelled = false;
    QRCode.toDataURL(`${domain}/passes/${encodeURIComponent(billId)}`, {
      width: 360,
      margin: 1,
      color: { dark: "#04252b", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setAllQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [billId, brand, eligible.length]);

  // SAME DESTINATION FOR ONE RACER. These used to encode /r/{code}/wallet, which
  // redirects straight at the pass file — and a pass PassKit has not finished
  // rendering is served as an HTML page, so the guest got something
  // un-installable. /passes/{billId}?p={personId} runs the identical
  // prepare-poll-hand-off the bundle uses, with the kiosk loader while it works.
  const ids = eligible.map((r) => r.personId).join(",");
  useEffect(() => {
    if (!billId || !ids) return;
    const domain = brand === "headpinz" ? "https://headpinz.com" : "https://fasttraxent.com";
    let cancelled = false;
    Promise.all(
      ids.split(",").map(async (pid) => {
        const url = await QRCode.toDataURL(
          `${domain}/passes/${encodeURIComponent(billId)}?p=${encodeURIComponent(pid)}`,
          { width: 360, margin: 1, color: { dark: "#04252b", light: "#ffffff" } },
        ).catch(() => null);
        return [pid, url] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [pid, url] of pairs) if (url) next[pid] = url;
      setOneQr(next);
    });
    return () => {
      cancelled = true;
    };
  }, [billId, brand, ids]);

  if (!racers || eligible.length === 0) return null;

  return (
    // Matches every other panel on this screen exactly — w-full max-w-[860px],
    // rounded-[24px], p-[32px]. Without the width cap this card stretched past
    // the racing panel above it and the column stopped looking like a column.
    <div className="relative mt-[32px] w-full max-w-[860px] rounded-[24px] border border-[#00e2e5]/30 bg-[#00e2e5]/[0.06] p-[32px] text-left">
      <p className="k-display text-[28px] text-[#00e2e5]">{t("licence.kiosk.title")}</p>
      <p className="mt-[8px] text-[22px] leading-snug text-white/60">{t("licence.kiosk.body")}</p>

      {/* COLLAPSE WHILE ONE IS OPEN. A kiosk screen with a group QR and four
          per-racer QRs visible at once is exactly how a guest scans the wrong
          one — and the wrong one puts a parent's licence on a child's phone.
          Opening a racer hides the group code and every other row. */}
      {!openFor && eligible.length > 1 && allQr && (
        <div className="mt-[20px] flex items-center gap-[20px] rounded-[20px] border border-[#00e2e5]/25 bg-[#00e2e5]/[0.04] p-[18px]">
          <div className="shrink-0 rounded-2xl bg-white p-[10px]">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
            <img src={allQr} alt="" width={150} height={150} className="block" />
          </div>
          <div className="min-w-0">
            <p className="text-[24px] font-bold leading-tight text-white">
              {t("licence.kiosk.allTitle", { n: eligible.length })}
            </p>
            <p className="mt-[6px] text-[20px] leading-snug text-white/55">
              {t("licence.kiosk.allBody")}
            </p>
          </div>
        </div>
      )}

      <div className="mt-[20px] flex flex-col divide-y divide-white/10">
        {eligible
          .filter((r) => !openFor || openFor === r.personId)
          .map((r) => {
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

              {open && oneQr[r.personId] && (
                <div className="mt-[14px] flex items-center gap-[20px]">
                  {/* White plate: a QR needs a light quiet zone to scan off a
                      dark kiosk panel at arm's length. */}
                  <div className="shrink-0 rounded-2xl bg-white p-[10px]">
                    {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                    <img src={oneQr[r.personId]} alt="" width={200} height={200} className="block" />
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
