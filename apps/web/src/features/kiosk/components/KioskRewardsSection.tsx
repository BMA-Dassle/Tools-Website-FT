"use client";

/**
 * HeadPinz / FastTrax Rewards on the kiosk merged checkout (owner 2026-07-21)
 * — the kiosk-native sibling of the web checkout's LoyaltySection: same
 * endpoints, same tier filter, same setLoyalty/clearLoyalty dispatch
 * contract, canvas-px touch targets.
 *
 * Rewards were hidden on the kiosk 2026-07-17 (`hideRewards`, "loyalty at
 * the reader"); this brings them back on the merged screen. Differences from
 * the web widget:
 *   - Auto-lookup runs off session.contact.phone (captured at player-add) —
 *     the guest types nothing.
 *   - SMS verify is SKIPPED when the contact's phone is already OTP-proven
 *     this session (`contact.phoneVerified` — returning-racer phone lookup /
 *     mobile-join sign-in). Owner 2026-07-21: "you don't need OTP if the
 *     main contact was already verified in racers sign up". Redemption
 *     spends real points, so unproven phones still verify here.
 *   - The SMS sender is the VENUE's number (the web widget hardcoded Fort
 *     Myers; Naples guests got a code from the wrong venue).
 *
 * Redemption plumbing is untouched: the selected tier rides
 * session.loyalty.selectedRewardTier into CheckoutStep's review totals and
 * both reserve rails (Square Loyalty reward object, fail-closed).
 */

import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession, SelectedRewardTier } from "~/features/booking";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import { useT } from "../i18n";

const GOLD = "#FFD700";

/** Which brand the verify code should be worded for. Used to be a
 *  per-center DID; the sender is now always the single A2P number, so
 *  only the wording varies. Naples is a HeadPinz venue. */
function verifyBrand(
  center: "fort-myers" | "naples",
  brand: "fasttrax" | "headpinz",
): "fasttrax" | "headpinz" {
  if (center === "naples") return "headpinz";
  return brand;
}

/** 10-digit US phone from whatever formatting the contact carries. */
function tenDigits(phone: string | undefined): string {
  let d = (phone ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : "";
}

interface RewardTier {
  id: string;
  name: string;
  points: number;
  discountCents: number;
}

export function KioskRewardsSection({
  session,
  dispatch,
  center,
  estTotal,
}: {
  session: BookingSession;
  dispatch: Dispatch<Action>;
  center: "fort-myers" | "naples";
  /** Estimated order dollars — drives the "you'll earn ~X" line. */
  estTotal?: number;
}) {
  const t = useT();
  const loyalty = session.loyalty;
  const digits = tenDigits(session.contact.phone);
  const phoneProven = !!session.contact.phoneVerified && digits.length === 10;
  const brand = session.entryBrand === "headpinz" ? "headpinz" : "fasttrax";
  const rewardsName = brand === "headpinz" ? "HeadPinz Rewards" : "FastTrax Rewards";
  // "Pinz" is a HeadPinz brand term (untranslated); FastTrax's generic "points"
  // localizes.
  const pointsUnit = brand === "headpinz" ? "Pinz" : t("rewards.pointsUnit");

  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewardTiers, setRewardTiers] = useState<RewardTier[]>([]);
  const [verifyStep, setVerifyStep] = useState<"idle" | "sending" | "code">("idle");
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyError, setVerifyError] = useState("");
  // Collapsed by default (owner 2026-07-21: three tier rows swallowed the
  // screen) — the header row is the toggle; picking a reward re-collapses.
  const [expanded, setExpanded] = useState(false);

  // Same whole-bill dollar-off filter as the web LoyaltySection.
  async function fetchTiers() {
    try {
      const res = await fetch("/api/square/loyalty/program");
      const data = await res.json();
      if (!data.rewardTiers) return;
      setRewardTiers(
        (
          data.rewardTiers as Array<{
            id: string;
            name: string;
            points: number;
            definition?: { scope?: string; fixedDiscountCents?: number };
          }>
        )
          .filter(
            (t) => t.definition?.scope === "ORDER" && (t.definition.fixedDiscountCents ?? 0) > 0,
          )
          .map((t) => ({
            id: t.id,
            name: t.name,
            points: t.points,
            discountCents: t.definition?.fixedDiscountCents ?? 0,
          })),
      );
    } catch {
      /* non-fatal — loyalty is optional */
    }
  }

  // Auto-lookup for the CONTACT's phone. Re-runs when the phone changes
  // (Booking-as edit); idempotent across remounts — a re-found account keeps
  // its verified state + selected tier, with a fresh balance.
  const lookedUpRef = useRef<string | null>(null);
  useEffect(() => {
    if (digits.length !== 10) {
      lookedUpRef.current = null;
      if (loyalty) dispatch({ type: "clearLoyalty" });
      setNotFound(false);
      setRewardTiers([]);
      setVerifyStep("idle");
      return;
    }
    if (lookedUpRef.current === digits) return;
    lookedUpRef.current = digits;
    setLoading(true);
    setError(null);
    setNotFound(false);
    void (async () => {
      try {
        const res = await fetch("/api/square/loyalty/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: digits }),
        });
        const data = await res.json();
        if (data.account) {
          const sameAccount = loyalty?.accountId === data.account.id;
          const verified = phoneProven || (sameAccount && !!loyalty?.verified);
          dispatch({
            type: "setLoyalty",
            loyalty: {
              accountId: data.account.id,
              customerId: data.account.customerId,
              balance: data.account.balance ?? 0,
              verified,
              isNewSignup: sameAccount ? (loyalty?.isNewSignup ?? false) : false,
              selectedRewardTier: sameAccount ? (loyalty?.selectedRewardTier ?? null) : null,
            },
          });
          if (verified) void fetchTiers();
        } else {
          if (loyalty) dispatch({ type: "clearLoyalty" });
          setNotFound(true);
        }
      } catch {
        /* non-fatal — loyalty is optional */
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits, phoneProven, dispatch]);

  // Verified account arriving without tiers loaded (e.g. remount after Back).
  useEffect(() => {
    if (loyalty?.verified && rewardTiers.length === 0) void fetchTiers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loyalty?.verified]);

  async function handleEnroll() {
    setEnrolling(true);
    setError(null);
    try {
      const res = await fetch("/api/square/loyalty/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.account) {
        const verified = phoneProven;
        dispatch({
          type: "setLoyalty",
          loyalty: {
            accountId: data.account.id ?? data.account.accountId,
            customerId: data.customer?.id ?? data.account.customerId ?? "",
            balance: data.account.balance ?? 0,
            verified,
            isNewSignup: true,
            selectedRewardTier: null,
          },
        });
        setNotFound(false);
        clarityEvent("rewards:signup");
        if (verified) void fetchTiers();
      } else {
        setError(t("rewards.enrollError"));
      }
    } catch {
      setError("Couldn't create a rewards account — you can sign up at the front desk.");
    } finally {
      setEnrolling(false);
    }
  }

  async function sendVerifyCode() {
    setVerifyStep("sending");
    setVerifyError("");
    try {
      const res = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits, brand: verifyBrand(center, brand) }),
      });
      if (res.ok) setVerifyStep("code");
      else {
        setVerifyError(t("rewards.sendError"));
        setVerifyStep("idle");
      }
    } catch {
      setVerifyError("Couldn't send the code — try again.");
      setVerifyStep("idle");
    }
  }

  async function submitVerifyCode() {
    if (verifyCode.length !== 6) return;
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
        setVerifyStep("idle");
        setVerifyCode("");
        if (loyalty) dispatch({ type: "setLoyalty", loyalty: { ...loyalty, verified: true } });
        // The phone is now OTP-proven for the rest of this session.
        dispatch({ type: "setContact", patch: { phoneVerified: true } });
        clarityEvent("kiosk:rewards:verified");
        void fetchTiers();
      } else {
        setVerifyError(data.error ?? t("rewards.codeMismatch"));
      }
    } catch {
      setVerifyError(t("rewards.verifyFailed"));
    }
  }

  function selectRewardTier(tier: SelectedRewardTier | null) {
    if (!loyalty) return;
    if (tier) {
      clarityTag("reward_redeemed", String(tier.discountCents));
      clarityEvent("rewards:reward_selected");
      // Reward locked in — give the screen back to the order.
      setExpanded(false);
    }
    dispatch({ type: "setLoyalty", loyalty: { ...loyalty, selectedRewardTier: tier } });
  }

  const earnPreview = estTotal && estTotal > 0 ? Math.round(estTotal * 10) : 0;

  // No usable phone yet — the Booking-as card above owns phone entry.
  if (digits.length !== 10) {
    return (
      <div className="k-glass p-[32px]">
        <p className="k-eyebrow" style={{ color: GOLD }}>
          {rewardsName}
        </p>
        <p className="mt-[8px] text-[26px] text-white/55">
          {t("rewards.addMobile", { unit: pointsUnit })}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="k-glass flex items-center gap-[18px] p-[32px]">
        <div
          className="h-[32px] w-[32px] animate-spin rounded-full border-[3px] border-white/15"
          style={{ borderTopColor: GOLD }}
        />
        <span className="text-[26px] text-white/55">
          {t("rewards.checking", { program: rewardsName })}
        </span>
      </div>
    );
  }

  // Not a member yet — one-tap free enrollment on the signed-in phone.
  if (!loyalty && notFound) {
    return (
      <div className="k-glass flex items-center justify-between gap-[24px] p-[32px]">
        <div className="min-w-0">
          <p className="k-eyebrow" style={{ color: GOLD }}>
            {rewardsName}
          </p>
          <p className="mt-[6px] text-[26px] text-white/60">
            {earnPreview > 0
              ? t("rewards.enrollBlurbPreview", { unit: pointsUnit, earn: earnPreview })
              : t("rewards.enrollBlurbPlain", { unit: pointsUnit })}
          </p>
          {error && <p className="mt-[6px] text-[24px] text-red-400">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => void handleEnroll()}
          disabled={enrolling}
          className="k-tap h-[92px] shrink-0 rounded-full px-[44px] text-[26px] font-extrabold uppercase tracking-wider disabled:opacity-50"
          style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
        >
          {enrolling ? t("rewards.signingUp") : t("rewards.joinFree")}
        </button>
      </div>
    );
  }

  if (!loyalty) return null;

  const affordableTiers = rewardTiers.filter((t) => t.points <= loyalty.balance);

  const selectedTier = loyalty.selectedRewardTier;
  // Collapsed subtitle: the one thing worth knowing at a glance.
  const collapsedHint = selectedTier
    ? t("rewards.collapsed.applied", { name: selectedTier.name })
    : loyalty.verified
      ? t("rewards.collapsed.spend", { unit: pointsUnit })
      : t("rewards.collapsed.verifySpend", { unit: pointsUnit });

  return (
    <div className="k-glass p-[32px]" style={{ borderColor: `${GOLD}35` }}>
      {/* Header doubles as the collapse toggle (owner 2026-07-21: the tier
          list swallowed the screen — collapsed by default). */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="k-tap flex w-full items-center justify-between gap-[20px] text-left"
      >
        <div className="min-w-0">
          <p className="k-eyebrow" style={{ color: GOLD }}>
            {rewardsName}
          </p>
          <p className="k-num mt-[6px] text-[40px] font-extrabold text-white">
            {loyalty.balance.toLocaleString()} <span className="text-[28px]">{pointsUnit}</span>
          </p>
          {expanded ? (
            earnPreview > 0 && (
              <p className="text-[23px] text-white/45">
                {t("rewards.earnMore", { n: earnPreview, unit: pointsUnit })}
              </p>
            )
          ) : (
            <p
              className="text-[23px]"
              style={{ color: selectedTier ? GOLD : "rgba(245,236,238,0.45)" }}
            >
              {collapsedHint}
            </p>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-[16px]">
          <span
            className="rounded-full px-[20px] py-[8px] text-[20px] font-bold uppercase tracking-wider"
            style={{ backgroundColor: `${GOLD}15`, color: GOLD }}
          >
            {selectedTier
              ? `−$${(selectedTier.discountCents / 100).toFixed(2)}`
              : loyalty.verified
                ? t("rewards.verified")
                : t("rewards.member")}
          </span>
          <svg
            className={`h-[34px] w-[34px] text-white/45 transition-transform ${expanded ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {/* Redemption unlock — skipped entirely for OTP-proven phones. */}
      {expanded && !loyalty.verified && (
        <div className="mt-[24px] border-t border-white/10 pt-[24px]">
          {verifyStep !== "code" ? (
            <div className="flex items-center justify-between gap-[24px]">
              <p className="text-[25px] text-white/55">
                {t("rewards.verifyPrompt", { unit: pointsUnit })}
              </p>
              <button
                type="button"
                onClick={() => void sendVerifyCode()}
                disabled={verifyStep === "sending"}
                className="k-tap h-[92px] shrink-0 rounded-full px-[44px] text-[26px] font-extrabold uppercase tracking-wider disabled:opacity-50"
                style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
              >
                {verifyStep === "sending" ? t("rewards.sending") : t("rewards.textCode")}
              </button>
            </div>
          ) : (
            <div className="space-y-[16px]">
              <p className="text-[25px] text-white/55">{t("rewards.enterCode")}</p>
              <div className="flex gap-[16px]">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="k-num min-w-0 flex-1 rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-center text-[40px] tracking-[0.35em] text-white placeholder:text-white/20 focus:outline-none"
                  placeholder="000000"
                />
                <button
                  type="button"
                  onClick={() => void submitVerifyCode()}
                  disabled={verifyCode.length !== 6}
                  className="k-tap h-[92px] shrink-0 rounded-full px-[40px] text-[26px] font-extrabold uppercase disabled:opacity-40"
                  style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
                >
                  {t("rewards.submit")}
                </button>
              </div>
              {verifyError && <p className="text-[24px] text-red-400">{verifyError}</p>}
            </div>
          )}
          {verifyStep !== "code" && verifyError && (
            <p className="mt-[8px] text-[24px] text-red-400">{verifyError}</p>
          )}
        </div>
      )}

      {/* Tier redemption — big tap rows, toggle on/off. */}
      {expanded && loyalty.verified && rewardTiers.length > 0 && (
        <div className="mt-[24px] space-y-[14px] border-t border-white/10 pt-[24px]">
          <p className="text-[25px] font-semibold text-white/60">
            {t("rewards.spendHeading", { unit: pointsUnit })}
          </p>
          {affordableTiers.map((tier) => {
            const isSelected = loyalty.selectedRewardTier?.id === tier.id;
            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => selectRewardTier(isSelected ? null : tier)}
                className="k-tap flex min-h-[96px] w-full items-center justify-between rounded-2xl border-2 px-[28px] py-[16px] text-left"
                style={{
                  borderColor: isSelected ? GOLD : "rgba(255,255,255,0.12)",
                  backgroundColor: isSelected ? `${GOLD}12` : "transparent",
                }}
              >
                <span className="text-[30px] font-bold text-white">
                  {tier.name}
                  <span className="k-num ml-[14px] text-[24px] font-semibold text-white/40">
                    {t("rewards.tierPoints", { points: tier.points, unit: pointsUnit })}
                  </span>
                </span>
                <span className="k-num text-[34px] font-extrabold" style={{ color: GOLD }}>
                  −${(tier.discountCents / 100).toFixed(2)}
                </span>
              </button>
            );
          })}
          {affordableTiers.length === 0 && (
            <p className="text-[24px] text-white/35">
              {t("rewards.notEnough", { unit: pointsUnit })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
