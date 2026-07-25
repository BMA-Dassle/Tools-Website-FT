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
 * The boxes sit under an always-visible "More ways to add people" accordion
 * bar the guest can fold or unfold AT ANY TIME. The `collapsed` prop is only
 * the DEFAULT (empty roster → open, someone on the roster → folded so the
 * roster stays front-and-center); a tap on the bar overrides it either way
 * for the life of the mount. While folded, the bar keeps showing the amber
 * "N phones signing in" status so an in-flight sign-in is never hidden.
 *
 * PURELY PRESENTATIONAL. It renders whatever the caller says is live and taps
 * back through props — it owns no scanning, parsing, or account-resolution.
 * The phone box is driven by the caller's existing `useMobileJoin` snapshot;
 * both scan boxes are gated by the caller's existing scanner-live signal. The
 * scans themselves are handled by the consumers' `useLicenseScan` wiring,
 * untouched here.
 */
import { useState } from "react";
import { IconChevronDown, IconFlag, IconLicense } from "@tabler/icons-react";
import type { MobileJoinSnapshot } from "../join/kiosk-client";
import { useT } from "../i18n";

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
  /** DEFAULT fold state — pass `party.length > 0`. The guest's own taps on
   *  the accordion bar override it for the life of the mount. */
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
  const t = useT();
  // Tapping the phone box swaps the box row for a focused QR sheet (inline, not
  // a modal — matches the flow's existing expand pattern).
  const [sheetOpen, setSheetOpen] = useState(false);
  // The guest's fold override. null = follow the `collapsed` prop; a tap on
  // the accordion bar sets it and wins for the life of the step (mounts fresh
  // per step, so the prop's default comes back on the next mount).
  const [override, setOverride] = useState<"open" | "closed" | null>(null);
  const expanded = override !== null ? override === "open" : !collapsed;

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
            alt={t("signin.sheet.qrAlt")}
            className="h-[400px] w-[400px] rounded-2xl bg-white p-[12px]"
          />
        ) : (
          <div className="grid h-[400px] w-[400px] place-items-center rounded-2xl border-2 border-dashed border-white/20">
            <span className="h-[40px] w-[40px] animate-spin rounded-full border-4 border-white/15 border-t-[#00e2e5]" />
          </div>
        )}
        <div>
          <div className="text-[34px] font-bold text-white">{t("signin.sheet.title")}</div>
          <p className="mt-[8px] text-[22px] text-white/45">{t("signin.sheet.sub")}</p>
        </div>
        {signing && (
          <div className="flex items-center gap-[14px] text-[22px] font-bold text-[#f5d38a]">
            <AmberPulse />
            {t("signin.sheet.signing", { count: phone.inProgressClients })}
          </div>
        )}
        <button
          type="button"
          onClick={() => setSheetOpen(false)}
          className="k-tap rounded-2xl border-2 border-white/25 px-[44px] py-[14px] text-[24px] font-bold text-white/80"
        >
          {t("signin.sheet.done")}
        </button>
      </div>
    );
  }

  const cols = visible === 1 ? "grid-cols-1" : visible === 2 ? "grid-cols-2" : "grid-cols-3";
  return (
    <div className="flex flex-col gap-[16px]">
      {/* ── Accordion bar — always visible; a tap folds/unfolds the boxes.
          While folded it carries the signing status (glow + amber chip); while
          unfolded the phone tile below owns that signal, so the bar stays
          quiet — the amber cue lives in exactly one place per state. ── */}
      <button
        type="button"
        onClick={() => setOverride(expanded ? "closed" : "open")}
        aria-expanded={expanded}
        className={`k-tap flex w-full items-center gap-[20px] rounded-[24px] border-2 px-[26px] py-[20px] text-left ${
          signing && !expanded ? "k-join-signing" : "border-white/15 bg-white/[0.02]"
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[24px] font-bold text-white">{t("signin.moreWays")}</span>
          {!expanded && (
            <span className="mt-[2px] block text-[19px] text-white/45">
              {[
                phoneVisible && t("signin.method.phone"),
                scanListening && t("signin.method.driversLicense"),
                scanListening && t("signin.method.fasttraxLicense"),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
        {signing && !expanded && (
          <span className="flex items-center gap-[10px] text-[20px] font-semibold text-[#f5d38a]">
            <AmberPulse />
            {t("signin.signingShort", { count: phone?.inProgressClients ?? 0 })}
          </span>
        )}
        <IconChevronDown
          size={34}
          stroke={2.5}
          aria-hidden="true"
          className={`shrink-0 text-white/45 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className={`grid gap-[16px] ${cols}`}>
          {/* Phone */}
          {phoneVisible &&
            (phoneUnavailable ? (
              <button
                type="button"
                onClick={() => phone!.reopen()}
                className="k-tap flex flex-col items-center justify-center gap-[12px] rounded-[26px] border-2 border-white/20 bg-white/[0.02] p-[24px] text-center"
              >
                <span className="text-[24px] font-bold text-white/60">
                  {t("signin.phone.title")}
                </span>
                <span className="text-[19px] text-white/40">{t("signin.phone.dropped")}</span>
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
                  {t("signin.phone.fastest")}
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
                    {t("signin.phone.title")}
                  </span>
                  {signing ? (
                    <span className="mt-[4px] flex items-center justify-center gap-[10px] text-[19px] font-semibold text-[#f5d38a]">
                      <AmberPulse />
                      {t("signin.signingShort", { count: phone!.inProgressClients })}
                    </span>
                  ) : (
                    <span className="mt-[4px] block text-[19px] text-white/50">
                      {t("signin.phone.sub")}
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
                {t("signin.license.badge")}
              </span>
              <IconLicense size={72} stroke={1.5} className="text-[#f0b341]" aria-hidden="true" />
              <span>
                <span className="block text-[27px] font-bold text-white">
                  {t("signin.license.title")}
                </span>
                <span className="mt-[4px] block text-[19px] text-white/50">
                  {t("signin.license.sub")}
                </span>
              </span>
            </div>
          )}

          {/* FastTrax license — same scanner; handled by the consumer's scan wiring. */}
          {scanListening && (
            <div className="flex flex-col items-center gap-[14px] rounded-[26px] border-2 border-[#46d68c]/35 bg-[#46d68c]/[0.05] p-[24px] text-center">
              <span className="text-[18px] font-bold uppercase tracking-[0.16em] text-[#46d68c]">
                {t("signin.fasttrax.badge")}
              </span>
              <IconFlag size={72} stroke={1.5} className="text-[#46d68c]" aria-hidden="true" />
              <span>
                <span className="block text-[27px] font-bold text-white">
                  {t("signin.fasttrax.title")}
                </span>
                <span className="mt-[4px] block text-[19px] text-white/50">
                  {t("signin.fasttrax.sub")}
                </span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
