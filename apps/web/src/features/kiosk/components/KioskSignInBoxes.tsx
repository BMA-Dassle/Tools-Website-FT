"use client";

/**
 * The "faster ways to sign in" boxes shown under the people-step entry buttons
 * (+ Add a new player / Sign in — find my people). Up to three equal, tappable
 * boxes, each shown only when its method is live:
 *
 *   1. Sign in from your phone — mobile-join QR, rendered INLINE and scannable;
 *      tapping enlarges it to a focused sheet (owner 2026-07-23). Wears the
 *      amber `k-join-signing` glow while a phone is mid sign-in.
 *   2. Scan your license — driver's license / state ID at the COM scanner.
 *   3. Scan your FastTrax license — the racer's FastTrax license at the same
 *      scanner.
 *
 * Once the roster has someone on it (`collapsed`), the three boxes fold into a
 * slim bar so the roster stays front-and-center; tapping it reopens them.
 *
 * PURELY PRESENTATIONAL. It renders whatever the caller says is live and taps
 * back through props — it owns no scanning, parsing, or account-resolution.
 * The phone box is driven by the caller's existing `useMobileJoin` snapshot;
 * both scan boxes are gated by the caller's existing scanner-live signal. The
 * scans themselves are handled by the consumers' `useLicenseScan` wiring,
 * untouched here.
 */
import { useState } from "react";
import { IconFlag, IconLicense } from "@tabler/icons-react";
import type { MobileJoinSnapshot } from "../join/kiosk-client";

/** The caller's `useMobileJoin` return — snapshot plus the derived QR + reopen. */
export interface SignInPhone extends MobileJoinSnapshot {
  qrDataUrl: string | null;
  reopen: () => void;
}

interface Props {
  /** Mobile-join state, or null to hide the phone box (flag off / mode with no
   *  sign-in). */
  phone: SignInPhone | null;
  /** COM scanner is open and listening — drives BOTH scan boxes (they share the
   *  one physical scanner). */
  scanListening: boolean;
  /** Fold to the slim bar — pass `party.length > 0`. */
  collapsed: boolean;
}

function AmberPulse() {
  return (
    <span className="relative flex h-[14px] w-[14px] shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f0b341] opacity-60" />
      <span className="relative inline-flex h-[14px] w-[14px] rounded-full bg-[#f0b341]" />
    </span>
  );
}

export function KioskSignInBoxes({ phone, scanListening, collapsed }: Props) {
  // Tapping the phone box swaps the box row for a focused QR sheet (inline, not
  // a modal — matches the flow's existing expand pattern).
  const [sheetOpen, setSheetOpen] = useState(false);
  // While collapsed, a tap reopens the boxes. Sticky for the life of the step
  // (mounts fresh per step) — once a guest asks to see the methods, keep them
  // shown; `collapsed` alone re-hides them on the next fresh mount.
  const [reopened, setReopened] = useState(false);

  const phoneUnavailable =
    phone !== null && (phone.status === "closed" || phone.status === "error");
  const phoneVisible = phone !== null && phone.status !== "idle";
  const signing = (phone?.inProgressClients ?? 0) > 0;

  // Which boxes are live this render.
  const visible = [
    phoneVisible && "phone",
    scanListening && "license",
    scanListening && "fasttrax",
  ].filter(Boolean).length;

  if (visible === 0) return null;

  // ── Focused QR sheet (phone box tapped) ──
  if (sheetOpen && phone) {
    return (
      <div className="k-glass flex flex-col items-center gap-[24px] px-[48px] py-[44px] text-center">
        {phone.qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={phone.qrDataUrl}
            alt="QR code — scan to sign in on your phone"
            className="h-[400px] w-[400px] rounded-2xl bg-white p-[12px]"
          />
        ) : (
          <div className="grid h-[400px] w-[400px] place-items-center rounded-2xl border-2 border-dashed border-white/20">
            <span className="h-[40px] w-[40px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
          </div>
        )}
        <div>
          <div className="text-[34px] font-bold text-white">Scan with your phone camera</div>
          <p className="mt-[8px] text-[22px] text-white/45">
            Adults 18+ &middot; waiver signed on the phone &middot; kids are added here at the kiosk
          </p>
        </div>
        {signing && (
          <div className="flex items-center gap-[14px] text-[22px] font-bold text-[#f5d38a]">
            <AmberPulse />
            {phone.inProgressClients === 1
              ? "1 phone signing in right now"
              : `${phone.inProgressClients} phones signing in right now`}{" "}
            — they&rsquo;ll pop into the list above when they finish.
          </div>
        )}
        <button
          type="button"
          onClick={() => setSheetOpen(false)}
          className="k-tap rounded-2xl border-2 border-white/25 px-[44px] py-[14px] text-[24px] font-bold text-white/80"
        >
          Done
        </button>
      </div>
    );
  }

  // ── Collapsed bar (someone is already on the roster) ──
  if (collapsed && !reopened) {
    return (
      <button
        type="button"
        onClick={() => setReopened(true)}
        className={`k-tap flex w-full items-center gap-[20px] rounded-[24px] border-2 px-[26px] py-[20px] text-left ${
          signing ? "k-join-signing" : "border-white/15 bg-white/[0.02]"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[24px] font-bold text-white">More ways to add people</span>
          <span className="mt-[2px] block text-[19px] text-white/45">
            {[
              phoneVisible && "phone",
              scanListening && "driver’s license",
              scanListening && "FastTrax license",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {signing ? (
          <span className="flex items-center gap-[10px] text-[20px] font-semibold text-[#f5d38a]">
            <AmberPulse />
            {phone?.inProgressClients === 1
              ? "1 phone signing in"
              : `${phone?.inProgressClients} phones signing in`}
          </span>
        ) : (
          <span aria-hidden="true" className="text-[26px] font-bold text-white/40">
            +
          </span>
        )}
      </button>
    );
  }

  // ── Expanded: the box row ──
  const cols = visible === 1 ? "grid-cols-1" : visible === 2 ? "grid-cols-2" : "grid-cols-3";
  return (
    <div className={`grid gap-[16px] ${cols}`}>
      {/* Phone */}
      {phoneVisible &&
        (phoneUnavailable ? (
          <button
            type="button"
            onClick={() => phone!.reopen()}
            className="k-tap flex flex-col items-center justify-center gap-[12px] rounded-[26px] border-2 border-white/20 bg-white/[0.02] p-[24px] text-center"
          >
            <span className="text-[24px] font-bold text-white/60">Sign in from your phone</span>
            <span className="text-[19px] text-white/40">
              Phone sign-in dropped — tap for a new code.
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={`k-tap flex flex-col items-center gap-[14px] rounded-[26px] border-2 p-[24px] text-center ${
              signing ? "k-join-signing" : "border-[#00e2e5]/30 bg-[#00e2e5]/[0.04]"
            }`}
          >
            <span className="text-[18px] font-bold uppercase tracking-[0.16em] text-[#00e2e5]">
              Fastest
            </span>
            {phone!.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={phone!.qrDataUrl}
                alt=""
                aria-hidden="true"
                className="h-[150px] w-[150px] rounded-[14px] bg-white p-[8px]"
              />
            ) : (
              <span className="grid h-[150px] w-[150px] place-items-center rounded-[14px] border-2 border-dashed border-white/20">
                <span className="h-[30px] w-[30px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
              </span>
            )}
            <span>
              <span className="block text-[27px] font-bold text-white">
                Sign in from your phone
              </span>
              {signing ? (
                <span className="mt-[4px] flex items-center justify-center gap-[10px] text-[19px] font-semibold text-[#f5d38a]">
                  <AmberPulse />
                  {phone!.inProgressClients === 1
                    ? "1 phone signing in"
                    : `${phone!.inProgressClients} phones signing in`}
                </span>
              ) : (
                <span className="mt-[4px] block text-[19px] text-white/50">
                  Adults 18+ — scan &amp; sign in on your own phone.
                </span>
              )}
            </span>
          </button>
        ))}

      {/* Driver's license — presentational prompt; the scan itself is handled by
          the consumer's useLicenseScan. Not a button: the guest just scans. */}
      {scanListening && (
        <div className="flex flex-col items-center gap-[14px] rounded-[26px] border-2 border-[#f0b341]/35 bg-[#f0b341]/[0.05] p-[24px] text-center">
          <span className="text-[18px] font-bold uppercase tracking-[0.16em] text-[#f0b341]">
            No typing
          </span>
          <IconLicense size={72} stroke={1.5} className="text-[#f0b341]" aria-hidden="true" />
          <span>
            <span className="block text-[27px] font-bold text-white">Scan your license</span>
            <span className="mt-[4px] block text-[19px] text-white/50">
              Driver&rsquo;s license or state ID — we&rsquo;ll fill it in.
            </span>
          </span>
        </div>
      )}

      {/* FastTrax license — same scanner; handled by the consumer's scan wiring. */}
      {scanListening && (
        <div className="flex flex-col items-center gap-[14px] rounded-[26px] border-2 border-[#46d68c]/35 bg-[#46d68c]/[0.05] p-[24px] text-center">
          <span className="text-[18px] font-bold uppercase tracking-[0.16em] text-[#46d68c]">
            Members
          </span>
          <IconFlag size={72} stroke={1.5} className="text-[#46d68c]" aria-hidden="true" />
          <span>
            <span className="block text-[27px] font-bold text-white">
              Scan your FastTrax license
            </span>
            <span className="mt-[4px] block text-[19px] text-white/50">
              Racers — scan your FastTrax license.
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
