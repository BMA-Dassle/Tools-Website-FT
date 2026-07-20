"use client";

/**
 * "Join from your phone" panel on the people step — QR code + the rules of
 * the road (adults 18+, no split payment) + a live "phone sign-in in
 * progress" line. Purely presentational; the session/poll lives in
 * useMobileJoin. Renders nothing while the feature flag is off (the parent
 * gates), and degrades to a muted card with a retry when the session
 * couldn't open (the kiosk's manual add flows are never blocked by this
 * feature).
 */
import type { MobileJoinSnapshot } from "../join/kiosk-client";

interface Props extends MobileJoinSnapshot {
  qrDataUrl: string | null;
  onReopen: () => void;
}

export function KioskMobileJoinPanel({
  status,
  code,
  qrDataUrl,
  inProgressClients,
  onReopen,
}: Props) {
  if (status === "idle") return null;

  const unavailable = status === "closed" || status === "error";

  return (
    <div className="k-glass p-[28px]">
      {unavailable ? (
        <div className="flex flex-wrap items-center justify-between gap-[20px]">
          <div>
            <div className="k-eyebrow text-white/40">Or join from your phone</div>
            <div className="mt-[6px] text-[26px] font-bold text-white/55">
              Phone sign-in isn&rsquo;t available right now — add players here at the kiosk.
            </div>
          </div>
          <button
            type="button"
            onClick={onReopen}
            className="k-tap rounded-2xl border-2 border-white/25 px-[28px] py-[16px] text-[24px] font-bold text-white/80"
          >
            Get a new code
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-[32px]">
          {/* QR — sized for an arm's-length scan from the podium. */}
          <div className="shrink-0">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="QR code — scan to sign in on your phone"
                className="h-[300px] w-[300px] rounded-2xl bg-white p-[10px]"
              />
            ) : (
              <div className="grid h-[300px] w-[300px] place-items-center rounded-2xl border-2 border-dashed border-white/20">
                <span className="h-[40px] w-[40px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
              </div>
            )}
            {code && (
              <div className="k-num mt-[10px] text-center text-[20px] tracking-widest text-white/45">
                {code}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-[16px]">
            <div>
              <div className="k-eyebrow text-[#00e2e5]">Or join from your phone</div>
              <div className="mt-[4px] text-[34px] font-bold text-white">
                Scan to sign in on your phone
              </div>
            </div>
            <p className="text-[24px] leading-snug text-white/65">
              Each adult can scan this code to sign in or register — waiver included — on their own
              phone. They&rsquo;ll appear in the list above automatically.
            </p>
            <p className="text-[22px] text-white/45">
              Phone sign-in is for adults (18+). Kids are added here at the kiosk.
            </p>

            {/* Split payment — one group, one payment (owner requirement:
                warned on BOTH the kiosk and the phone). */}
            <div className="flex items-start gap-[14px] rounded-2xl border-2 border-[#f0b341]/50 bg-[#f0b341]/10 px-[20px] py-[14px]">
              <span
                aria-hidden="true"
                className="mt-[2px] grid h-[28px] w-[28px] shrink-0 place-items-center rounded-full bg-[#f0b341] text-[20px] font-black text-[#2a1c00]"
              >
                !
              </span>
              <p className="text-[22px] font-semibold leading-snug text-[#f5d38a]">
                No split payments — the whole group pays together at this kiosk when you check out.
              </p>
            </div>

            {inProgressClients > 0 && (
              <div className="flex items-center gap-[14px] text-[24px] font-bold text-[#00e2e5]">
                <span className="relative flex h-[16px] w-[16px]">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00e2e5] opacity-60" />
                  <span className="relative inline-flex h-[16px] w-[16px] rounded-full bg-[#00e2e5]" />
                </span>
                {inProgressClients === 1
                  ? "1 phone signing in right now — they'll pop into the list above when they finish."
                  : `${inProgressClients} phones signing in right now — they'll pop into the list above when they finish.`}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
