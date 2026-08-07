"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { GRANT_SEPARATOR } from "~/features/racing/wallet/licence-grant";
import { useLicencePack } from "~/features/racing/licence/useLicencePack";
import { usePassQrs } from "~/features/racing/licence/usePassQrs";
import { WALLET_BADGES, BADGE_HEIGHT } from "~/features/game-cards/wallet/badges";
import {
  walletPlatformFromUserAgent,
  type WalletPlatform,
} from "~/features/game-cards/wallet/platform";

/**
 * The racing licence on the waiver's "you're all set" card.
 *
 * SAME FORMAT AS THE KIOSK (owner 2026-08-06): named rows, one per person, each
 * opening a QR, everything else collapsing while one is open. A row of
 * unlabelled codes is how a parent's licence ends up on a child's phone, and
 * five QRs at once is how the wrong one gets scanned.
 *
 * WHAT DIFFERS FROM THE KIOSK, and it is not cosmetic. A kiosk is a shared
 * lobby screen, so a pass must never land on it — every row there is a
 * scan-with-your-own-phone bridge. A waiver is signed ON the guest's phone, so
 * each row also gets a real Add-to-Wallet badge; a QR you cannot scan because
 * you are holding the screen it is on is not an affordance. The QR stays for
 * the people beside them, which is the case a family signing together has.
 *
 * ── IT WAITS FOR THE CODE ───────────────────────────────────────────────────
 * A login code lands in BMI's on-prem Firebird seconds after the person is
 * created, but we read it from the Office CLOUD api, which trails behind. So at
 * the exact moment a waiver finishes, the code reliably does NOT exist yet.
 * This card used to ask once and render nothing forever. `useLicencePack` polls
 * until every signer has one, and the card says it is working rather than
 * pretending there is nothing to offer.
 *
 * ONE CARD FOR BOTH WAIVER SURFACES. The standalone waiver and the group-events
 * participant waiver are the same flow — the short-link route redirects
 * organizer and participant codes alike to the identical waiver page — so this
 * renders on both without either knowing about the other.
 *
 * NOTHING IS BILLED BY SHOWING THIS. A pass is created only when someone taps or
 * scans (owner rule 2026-08-05: "don't build it till they scan").
 */

/**
 * Which wallet this phone has, without a setState-in-effect.
 *
 * `navigator` does not exist while rendering on the server, so this cannot be
 * computed during render — and doing it in an effect is a cascading render the
 * hooks lint rightly flags. `useSyncExternalStore` is the idiom: a server
 * snapshot of `null`, a client snapshot read from the UA, and a subscribe that
 * never fires because a phone does not change platform mid-visit.
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
  const packKey = useMemo(
    () => (grants.length ? `g=${grants.join(GRANT_SEPARATOR)}` : null),
    [grants],
  );
  // We know how many people this device filed for, so the poll can tell
  // "everyone who can have a code, has one" from "Office is still catching up".
  const { eligible, waiting, racers } = useLicencePack(packKey, {
    poll: true,
    expected: grants.length,
  });
  const platform = useWalletPlatform();
  const [openFor, setOpenFor] = useState<string | null>(null);

  const passBase = packKey ? `/passes/w?${packKey}` : null;
  const qr = usePassQrs(
    passBase,
    useMemo(() => eligible.map((r) => r.personId), [eligible]),
  );

  // Nothing to say yet and nothing on the way — a bowling or laser-tag waiver
  // ends on a bare confirmation, exactly as before.
  if (eligible.length === 0 && !waiting) return null;

  // Still waiting on the vendor sync. Say so: a guest who signed ten seconds ago
  // has their phone out, and an empty space reads as "nothing for me".
  if (eligible.length === 0) {
    return (
      <div className="mt-4 rounded-[18px] border border-[#00E2E5]/25 bg-[#00E2E5]/[0.05] p-4 text-left">
        <p className="k-display text-base text-[#00E2E5]">Setting up your racing licence…</p>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--k-dim)]">
          {racers === null
            ? "One moment."
            : "Your licence number is being created — this takes a few seconds."}
        </p>
      </div>
    );
  }

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
        Add it to your phone and it checks you in at the race desk, signs you in at the kiosk,
        and logs you in at the counter — no code to remember.
      </p>

      {/* Someone in the party is still waiting on their number. Better to name
          it than to show a short list the guest has to notice is short. */}
      {waiting && (
        <p className="mt-2 text-[13px] leading-snug text-[var(--k-dim)]">
          Still setting up {grants.length - eligible.length} more…
        </p>
      )}

      {/* ADD ALL, when there is more than one. Apple only: the `.pkpasses`
          bundle is a ZIP of signed passes we can assemble, while Google's
          multi-save needs several objects inside ONE issuer-signed JWT that
          only the issuer can mint. Android guests add each racer from their row. */}
      {!openFor && eligible.length > 1 && platform === "apple" && passBase && (
        <a href={passBase} className="k-btn-primary k-tap mt-3.5 block w-full text-center">
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
                        <img
                          src={qr[r.personId]}
                          alt=""
                          width={104}
                          height={104}
                          className="block"
                        />
                      </div>
                      <p className="text-[13px] leading-snug text-[var(--k-dim)]">
                        On {r.name}&apos;s own phone? Point their camera at this instead.
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
