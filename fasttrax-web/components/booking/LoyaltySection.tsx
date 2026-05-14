"use client";

import type { UseLoyaltyReturn } from "@/hooks/useLoyalty";

/**
 * HeadPinz Rewards loyalty UI section for any booking wizard.
 *
 * Renders: member badge, SMS verify flow, reward tier selection,
 * or enrollment pitch — depending on the loyalty state.
 *
 * Drop this anywhere between a phone field and the form's submit
 * button. Requires a `useLoyalty()` return and the guest phone number.
 */

interface LoyaltySectionProps {
  loyalty: UseLoyaltyReturn;
  /** Raw phone input from the contact form (formatted or digits). */
  phone: string;
  /** Deposit amount in cents (for showing "new deposit" after reward). 0 = hide reward selection. */
  depositCents: number;
  /** Accent color for the attraction (hex). Falls back to cyan. */
  accentColor?: string;
}

function formatPhoneDisplay(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

export default function LoyaltySection({ loyalty, phone, depositCents, accentColor }: LoyaltySectionProps) {
  const {
    account,
    phoneLookedUp,
    phoneLookupLoading,
    phoneVerified,
    verifyStep,
    verifyCode,
    verifyError,
    rewardsSignup,
    isNewSignup,
    enrolling,
    rewardTiers,
    selectedRewardTier,
    sendVerifyCode,
    handleCodeInput,
    handleCodeKeyDown,
    handleCodePaste,
    codeInputRefs,
    setRewardsSignup,
    setSelectedRewardTier,
  } = loyalty;

  const _color = accentColor || "#00E2E5";

  // Nothing to show until phone lookup has happened
  if (!phoneLookedUp && !phoneLookupLoading) return null;

  // Loading spinner while looking up
  if (phoneLookupLoading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-white/15 border-t-[#22c55e] rounded-full animate-spin" />
        <span className="text-white/50 text-sm">Checking rewards...</span>
      </div>
    );
  }

  const effectiveDepositCents = Math.max(0, depositCents - (selectedRewardTier?.discountCents ?? 0));

  return (
    <div className="space-y-3">
      {/* ── Rewards Member Found (unverified) ─────────────── */}
      {phoneLookedUp && account && !phoneVerified && verifyStep === "idle" && (
        <div className="rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <span className="font-bold text-[#22c55e] text-sm">HeadPinz Rewards Member</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-white/55 text-xs">
              {account.balance.toLocaleString()} Pinz available
            </span>
            <button
              type="button"
              onClick={() => sendVerifyCode(phone)}
              className="rounded-full px-4 py-1.5 font-bold text-xs uppercase tracking-wider bg-[#22c55e] text-white"
            >
              Verify
            </button>
          </div>
          <p className="text-white/35 text-xs">
            We&apos;ll text you a code to confirm your identity and prefill your info.
          </p>
        </div>
      )}

      {/* ── SMS Verification Code ────────────────────────── */}
      {(verifyStep === "code" || verifyStep === "sending") && !phoneVerified && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <p className="text-white/70 text-sm text-center">
            Enter the 6-digit code sent to {formatPhoneDisplay(phone)}
          </p>
          <div className="flex justify-center gap-2">
            {verifyCode.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { codeInputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleCodeInput(i, e.target.value)}
                onKeyDown={(e) => handleCodeKeyDown(i, e)}
                onPaste={i === 0 ? handleCodePaste : undefined}
                className="w-10 h-12 text-center bg-white/5 border border-white/15 rounded-lg text-white text-lg focus:outline-none focus:border-[#22c55e]/50"
              />
            ))}
          </div>
          {verifyError && (
            <p className="text-xs text-center text-red-400">{verifyError}</p>
          )}
          <button
            type="button"
            onClick={() => sendVerifyCode(phone)}
            className="block mx-auto text-xs text-white/35 hover:text-white/55 transition-colors"
          >
            Resend code
          </button>
        </div>
      )}

      {/* ── Verified Badge ───────────────────────────────── */}
      {phoneVerified && account && (
        <div className="rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5 p-3 flex items-center gap-3">
          <span className="text-[#22c55e] text-lg">✓</span>
          <div className="flex-1">
            <span className="font-bold text-[#22c55e] text-sm">HeadPinz Rewards Verified</span>
            <span className="text-white/45 text-xs block">
              {account.balance.toLocaleString()} Pinz · Member since {new Date(account.enrolledAt ?? "").getFullYear() || ""}
            </span>
          </div>
        </div>
      )}

      {/* ── Use Your Pinz (reward redemption) ────────────── */}
      {phoneVerified && account && rewardTiers.length > 0 && depositCents > 0 && (
        <div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⭐</span>
            <span className="font-bold text-[#FFD700] text-sm">Use Your Pinz</span>
          </div>
          <p className="text-white/50 text-xs">
            Apply a reward to reduce your deposit. Points are deducted when you book.
          </p>
          <div className="space-y-2">
            {rewardTiers.map((tier) => {
              const canAfford = account.balance >= tier.points;
              const isSelected = selectedRewardTier?.id === tier.id;
              const exceedsDeposit = tier.discountCents > depositCents;
              return (
                <button
                  key={tier.id}
                  type="button"
                  disabled={!canAfford}
                  onClick={() => setSelectedRewardTier(isSelected ? null : tier)}
                  className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 border transition-all text-left ${
                    isSelected
                      ? "border-[#FFD700]/50 bg-[#FFD700]/10"
                      : canAfford
                        ? "border-white/10 bg-white/[0.03] hover:border-[#FFD700]/30"
                        : "border-white/5 bg-white/[0.01] opacity-40 cursor-not-allowed"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                        isSelected ? "border-[#FFD700] bg-[#FFD700]" : "border-white/25"
                      }`}
                    >
                      {isSelected && (
                        <div className="w-1.5 h-1.5 rounded-full bg-[#0a1628]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <span className="font-semibold text-white text-sm block truncate">
                        ${(tier.discountCents / 100).toFixed(0)} off{exceedsDeposit ? " (covers full deposit)" : ""}
                      </span>
                      <span className="text-white/40 text-xs">
                        {tier.points.toLocaleString()} Pinz
                      </span>
                    </div>
                  </div>
                  {isSelected && (
                    <span className="text-[#FFD700] text-xs font-bold uppercase tracking-wider flex-shrink-0">Applied</span>
                  )}
                </button>
              );
            })}
          </div>
          {selectedRewardTier && (
            <div className="flex items-center justify-between pt-1 border-t border-[#FFD700]/10">
              <span className="text-white/50 text-xs">New deposit</span>
              <span className="font-bold text-[#FFD700] text-sm">
                ${(effectiveDepositCents / 100).toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Not a Member — Rewards Pitch ─────────────────── */}
      {phoneLookedUp && !account && !isNewSignup && (
        <div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="text-xl mt-0.5">⭐</span>
            <div className="flex-1 space-y-1">
              <span className="font-bold text-[#FFD700] text-sm block">Join HeadPinz Rewards!</span>
              <p className="text-white/55 text-xs leading-relaxed">
                Earn 10% back in Pinz on every visit. Pinz = free money for bowling, food, and a whole lot of fun at both HeadPinz and FastTrax Entertainment.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={rewardsSignup}
              onChange={(e) => setRewardsSignup(e.target.checked)}
              className="w-4 h-4 rounded border-[#FFD700]/30 bg-white/5 focus:ring-[#FFD700]/50 focus:ring-offset-0 cursor-pointer accent-[#FFD700]"
            />
            <span className="text-sm text-white/70 group-hover:text-white transition-colors">
              Sign me up for free
            </span>
          </label>
        </div>
      )}

      {/* ── New Signup Confirmation ──────────────────────── */}
      {isNewSignup && account && !phoneVerified && (
        <div className="rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5 p-3 flex items-center gap-3">
          <span className="text-[#22c55e] text-lg">✓</span>
          <div className="flex-1">
            <span className="font-bold text-[#22c55e] text-sm">Welcome to HeadPinz Rewards!</span>
            <span className="text-white/45 text-xs block">
              {account.balance.toLocaleString()} Pinz starting balance
            </span>
          </div>
        </div>
      )}

      {/* ── Enrolling spinner ────────────────────────────── */}
      {enrolling && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-white/15 border-t-[#FFD700] rounded-full animate-spin" />
          <span className="text-white/50 text-sm">Signing you up...</span>
        </div>
      )}
    </div>
  );
}
