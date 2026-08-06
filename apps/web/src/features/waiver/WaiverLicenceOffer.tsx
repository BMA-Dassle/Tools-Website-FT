"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { useLicenceOffer } from "~/features/racing/components/useLicenceOffer";
import { GRANT_SEPARATOR } from "~/features/racing/wallet/licence-grant";
import { WALLET_BADGES, BADGE_HEIGHT } from "~/features/game-cards/wallet/badges";
import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";

/**
 * The racing licence on the "you're all set" waiver card.
 *
 * SAME FORMAT AS THE KIOSK (owner 2026-08-06), and for the same reason: named
 * rows, one per person, each opening a QR, with everything else collapsing while
 * one is open. A row of unlabelled codes is how a parent's licence ends up on a
 * child's phone, and a screen showing five QRs at once is how the wrong one gets
 * scanned.
 *
 * WHAT IS DIFFERENT FROM THE KIOSK, and it is not cosmetic. A kiosk is a shared
 * screen in the lobby, so a pass must never land on it — every row there is a
 * scan-with-your-own-phone bridge and nothing else. A waiver is signed ON the
 * guest's own phone, so each row ALSO gets a real Add-to-Wallet badge: a QR you
 * cannot scan because you are holding the screen it is on is not an affordance.
 * The QR stays for the people beside them — the other adult, the teenager with
 * their own phone — which is the case a family signing together actually has.
 *
 * ONE CARD FOR BOTH WAIVER SURFACES. The standalone waiver page and the
 * group-events participant waiver are the same flow — the short-link route
 * redirects organizer and participant codes alike to the identical
 * waiver page with its center and reservation params — so this renders on both
 * without either knowing about the other.
 *
 * NOTHING IS BILLED BY SHOWING THIS. A pass is created only when someone taps or
 * scans and the wallet route runs (owner rule 2026-08-05: "don't build it till
 * they scan"). A family of five costs nothing until they opt in.
 *
 * RENDERS NOTHING unless someone in the party actually resolves to a BMI racing
 * tag. A guest who signed a waiver for laser tag or bowling has no tag, so the
 * offer endpoint returns no QR for them and this disappears entirely rather than
 * advertising a racing licence to someone who has never raced.
 */
/**
 * Which wallet this phone has, read WITHOUT a setState-in-effect.
 *
 * `navigator` does not exist while rendering on the server, so this cannot be
 * computed during render — and doing it in an effect is a cascading render the
 * hooks lint (rightly) flags. `useSyncExternalStore` is the idiom for exactly
 * this: a server snapshot of `null`, a client snapshot read straight from the
 * UA, and a subscribe that never fires because a phone does not change platform
 * mid-visit. Same pattern the waiver flow already uses to read the viewport.
 */
const NEVER_CHANGES = () => () => {};
function useWalletPlatform(): WalletPlatform | null {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => walletPlatformFromUserAgent(navigator.userAgent),
    () => null,
  );
}

export function WaiverLicenceOffer({ grants }: { grants: ReadonlyArray<string> }) {
  // Stable across renders so the shared fetch cache in `useLicenceOffer` gets a
  // hit rather than re-warming the whole party's login codes on every keystroke
  // elsewhere in the flow.
  const packKey = useMemo(
    () => (grants.length ? `g=${grants.join(GRANT_SEPARATOR)}` : null),
    [grants],
  );
  const racers = useLicenceOffer(packKey);
  const platform = useWalletPlatform();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});

  const eligible = useMemo(() => racers?.filter((r) => r.qr) ?? [], [racers]);
  const ids = eligible.map((r) => r.personId).join(",");

  // Per-racer QRs, generated here rather than taken from the endpoint's `qr`
  // field. The endpoint renders a code pointing at `/r/{code}/wallet`, which
  // redirects straight at the pass file — and a pass PassKit has not finished
  // rendering is served as an HTML page, so the guest gets something they cannot
  // install. `/passes/w` runs the prepare-poll-hand-off behind the kiosk loader,
  // which is the fix the kiosk already had to make.
  useEffect(() => {
    if (!packKey || !ids) return;
    let cancelled = false;
    Promise.all(
      ids.split(",").map(async (pid) => {
        const url = `${window.location.origin}/passes/w?${packKey}&p=${encodeURIComponent(pid)}`;
        const img = await QRCode.toDataURL(url, {
          width: 320,
          margin: 1,
          color: { dark: "#04252b", light: "#ffffff" },
        }).catch(() => null);
        return [pid, img] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [pid, img] of pairs) if (img) next[pid] = img;
      setQr(next);
    });
    return () => {
      cancelled = true;
    };
  }, [packKey, ids]);

  if (!racers || eligible.length === 0) return null;

  const shown = eligible.filter((r) => !openFor || openFor === r.personId);
  const badges = WALLET_BADGES.filter((b) => !platform || b.platform === platform);

  return (
    <div className="mt-4 rounded-[18px] border border-[#00E2E5]/30 bg-[#00E2E5]/[0.06] p-4 text-left">
      <p className="k-display text-base text-[#00E2E5]">
        {eligible.length === 1 ? "Your FastTrax racing licence" : "FastTrax racing licences"}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--k-dim)]">
        {/* Says what it DOES, not what it is. "Racing licence" alone reads like a
            souvenir; these three jobs are why it is worth a tap. */}
        Add it to your phone and it checks you in at the race desk, signs you in
        at the kiosk, and logs you in at the counter — no code to remember.
      </p>

      {/* ADD ALL, when there is more than one. Apple only: the `.pkpasses`
          bundle is a ZIP of signed passes we can assemble, while Google's
          multi-save needs several objects inside ONE issuer-signed JWT that only
          the issuer can mint. Android guests add each racer from their row. */}
      {!openFor && eligible.length > 1 && platform === "apple" && (
        <a
          href={`/passes/w?${packKey}`}
          className="k-btn-primary k-tap mt-3.5 block w-full text-center"
        >
          Add all {eligible.length} to Apple Wallet
        </a>
      )}

      <div className="mt-3 flex flex-col divide-y divide-white/10">
        {shown.map((r) => {
          const open = openFor === r.personId;
          return (
            <div key={r.personId} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[15px] font-semibold text-white">
                  {r.name}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenFor(open ? null : r.personId)}
                  aria-expanded={open}
                  className="k-tap shrink-0 rounded-full border border-[#00E2E5]/40 bg-[#00E2E5]/10 px-4 py-1.5 text-[13px] font-semibold text-[#00E2E5]"
                >
                  {open ? "Hide" : "Add"}
                </button>
              </div>

              {open && (
                <div className="mt-3">
                  {/* THIS PHONE. The waiver was signed here, so the person
                      standing here gets a real one-tap add. */}
                  {r.addUrl && (
                    <div className="flex flex-wrap gap-3">
                      {badges.map((b) => (
                        <a
                          key={b.platform}
                          href={`${r.addUrl}&platform=${b.platform}`}
                          aria-label={`${b.label} — ${r.name}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- vendor artwork, byte-for-byte */}
                          <img
                            src={b.svg}
                            alt={b.label}
                            width={b.width}
                            height={BADGE_HEIGHT}
                            style={{ width: b.width, height: BADGE_HEIGHT, display: "block" }}
                          />
                        </a>
                      ))}
                    </div>
                  )}

                  {/* THEIR phone. You cannot scan the screen you are holding, so
                      this is for the person beside you — spelled out, because an
                      unexplained QR next to a wallet badge reads as a duplicate. */}
                  {qr[r.personId] && (
                    <div className="mt-3.5 flex items-center gap-3.5 rounded-[14px] border border-white/10 bg-white/[0.03] p-3">
                      <div className="shrink-0 rounded-xl bg-white p-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no loader */}
                        <img src={qr[r.personId]} alt="" width={104} height={104} className="block" />
                      </div>
                      <p className="text-[13px] leading-snug text-[var(--k-dim)]">
                        On {r.name}&apos;s own phone? Point their camera at this
                        instead.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
