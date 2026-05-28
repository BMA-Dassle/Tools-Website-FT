"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession, LoyaltyState, SelectedRewardTier } from "~/features/booking";

const GOLD = "#FFD700";

interface RewardTier {
  id: string;
  name: string;
  points: number;
  discountCents: number;
}

interface LoyaltySectionProps {
  session: BookingSession;
  dispatch: Dispatch<Action>;
  phone: string;
}

export function LoyaltySection({ session, dispatch, phone }: LoyaltySectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewardTiers, setRewardTiers] = useState<RewardTier[]>([]);

  // Phone verification state
  const [verifyStep, setVerifyStep] = useState<"idle" | "sending" | "code" | "verified">("idle");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyError, setVerifyError] = useState("");

  // Enrollment
  const [enrolling, setEnrolling] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);

  const lookupDone = useRef(false);
  const loyalty = session.loyalty;
  const digits = phone.replace(/\D/g, "");

  // Auto-lookup when phone reaches 10 digits
  useEffect(() => {
    if (digits.length !== 10 || lookupDone.current) return;
    lookupDone.current = true;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await fetch("/api/square/loyalty/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: digits }),
        });
        const data = await res.json();

        if (data.account) {
          dispatch({
            type: "setLoyalty",
            loyalty: {
              accountId: data.account.id,
              customerId: data.account.customerId,
              balance: data.account.balance ?? 0,
              verified: false,
              isNewSignup: false,
              selectedRewardTier: null,
            },
          });
        } else {
          setShowEnroll(true);
        }
      } catch {
        // Non-fatal — loyalty is optional
      } finally {
        setLoading(false);
      }
    })();
  }, [digits, dispatch]);

  // Reset if phone changes
  useEffect(() => {
    if (digits.length < 10) {
      lookupDone.current = false;
      if (loyalty) dispatch({ type: "clearLoyalty" });
      setShowEnroll(false);
      setVerifyStep("idle");
      setRewardTiers([]);
    }
  }, [digits]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleEnroll() {
    setEnrolling(true);
    try {
      const res = await fetch("/api/square/loyalty/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.account) {
        dispatch({
          type: "setLoyalty",
          loyalty: {
            accountId: data.account.id ?? data.account.accountId,
            customerId: data.customer?.id ?? data.account.customerId ?? "",
            balance: data.account.balance ?? 0,
            verified: false,
            isNewSignup: true,
            selectedRewardTier: null,
          },
        });
        setShowEnroll(false);
      }
    } catch {
      setError("Couldn't create rewards account. You can sign up at the center.");
    } finally {
      setEnrolling(false);
    }
  }

  async function sendVerifyCode() {
    setVerifyStep("sending");
    setVerifyError("");
    try {
      const centerPhone = "+12393022155"; // Fort Myers default
      const res = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits, from: centerPhone }),
      });
      if (res.ok) {
        setVerifyStep("code");
      } else {
        setVerifyError("Couldn't send code. Try again.");
        setVerifyStep("idle");
      }
    } catch {
      setVerifyError("Couldn't send code. Try again.");
      setVerifyStep("idle");
    }
  }

  async function submitVerifyCode() {
    if (verifyCode.length !== 6) return;
    setVerifyStep("sending");
    setVerifyError("");
    try {
      const res = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: digits,
          code: verifyCode,
          squareCustomerId: loyalty?.customerId,
        }),
      });
      const data = await res.json();
      if (data.verified) {
        setVerifyStep("verified");
        if (loyalty) {
          dispatch({
            type: "setLoyalty",
            loyalty: { ...loyalty, verified: true },
          });
        }
        // Fetch reward tiers now that the phone is verified
        try {
          const tierRes = await fetch("/api/square/loyalty/program");
          const tierData = await tierRes.json();
          if (tierData.rewardTiers) {
            setRewardTiers(
              tierData.rewardTiers.map(
                (t: {
                  id: string;
                  name: string;
                  points: number;
                  definition?: { fixedDiscountCents?: number };
                }) => ({
                  id: t.id,
                  name: t.name,
                  points: t.points,
                  discountCents: t.definition?.fixedDiscountCents ?? 0,
                }),
              ),
            );
          }
        } catch {
          // Non-fatal
        }
      } else {
        setVerifyError(data.error ?? "Invalid code.");
        setVerifyStep("code");
      }
    } catch {
      setVerifyError("Verification failed.");
      setVerifyStep("code");
    }
  }

  function selectRewardTier(tier: SelectedRewardTier | null) {
    if (!loyalty) return;
    dispatch({
      type: "setLoyalty",
      loyalty: { ...loyalty, selectedRewardTier: tier },
    });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <div
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: GOLD }}
        />
        <span className="text-xs text-white/40">Checking rewards...</span>
      </div>
    );
  }

  // Not found — offer enrollment
  if (!loyalty && showEnroll) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">HeadPinz Rewards</p>
            <p className="text-xs text-white/40">Earn 10 Pinz per $1 spent. Sign up free!</p>
          </div>
          <button
            type="button"
            onClick={() => void handleEnroll()}
            disabled={enrolling}
            className="rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50"
            style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
          >
            {enrolling ? "Signing up..." : "Join Free"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // No loyalty account and no enrollment offer
  if (!loyalty) return null;

  // Found — show account info + verification + rewards
  return (
    <div className="space-y-3">
      {/* Account info */}
      <div className="rounded-xl border bg-white/[0.03] p-4" style={{ borderColor: `${GOLD}30` }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold" style={{ color: GOLD }}>
              HeadPinz Rewards
            </p>
            <p className="text-xs text-white/50">
              {loyalty.balance} Pinz available
              {loyalty.isNewSignup && " (includes 300 signup bonus)"}
            </p>
          </div>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ backgroundColor: `${GOLD}15`, color: GOLD }}
          >
            {loyalty.verified ? "Verified" : "Member"}
          </span>
        </div>
      </div>

      {/* Phone verification (needed to redeem rewards) */}
      {!loyalty.verified && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          {verifyStep === "idle" && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/50">Verify your phone to redeem rewards</p>
              <button
                type="button"
                onClick={() => void sendVerifyCode()}
                className="rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wider"
                style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
              >
                Verify
              </button>
            </div>
          )}
          {verifyStep === "sending" && (
            <p className="text-center text-xs text-white/40">Sending code...</p>
          )}
          {verifyStep === "code" && (
            <div className="space-y-2">
              <p className="text-xs text-white/50">Enter the 6-digit code sent to your phone</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && void submitVerifyCode()}
                  className="flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-center text-sm tracking-[0.3em] text-white placeholder:text-white/20 focus:outline-none"
                  placeholder="000000"
                />
                <button
                  type="button"
                  onClick={() => void submitVerifyCode()}
                  disabled={verifyCode.length !== 6}
                  className="rounded-lg px-3 py-2 text-xs font-bold uppercase disabled:opacity-40"
                  style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
                >
                  Submit
                </button>
              </div>
              {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
            </div>
          )}
        </div>
      )}

      {/* Reward tier selection (only after verification) */}
      {loyalty.verified && rewardTiers.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
          <p className="text-xs font-semibold text-white/60">
            Apply a reward to reduce your deposit
          </p>
          <div className="space-y-1.5">
            {rewardTiers
              .filter((t) => t.points <= loyalty.balance)
              .map((tier) => {
                const isSelected = loyalty.selectedRewardTier?.id === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => selectRewardTier(isSelected ? null : tier)}
                    className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-all"
                    style={{
                      borderColor: isSelected ? GOLD : "rgba(255,255,255,0.1)",
                      backgroundColor: isSelected ? `${GOLD}10` : "transparent",
                    }}
                  >
                    <div>
                      <span className="text-sm text-white">{tier.name}</span>
                      <span className="ml-2 text-xs text-white/40">{tier.points} Pinz</span>
                    </div>
                    <span className="text-sm font-bold" style={{ color: GOLD }}>
                      -${(tier.discountCents / 100).toFixed(2)}
                    </span>
                  </button>
                );
              })}
            {rewardTiers.every((t) => t.points > loyalty.balance) && (
              <p className="text-xs text-white/30">
                Not enough Pinz for any reward yet. Keep earning!
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
