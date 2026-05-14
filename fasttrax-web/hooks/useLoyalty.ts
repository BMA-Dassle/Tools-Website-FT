"use client";

import { useState, useCallback, useRef } from "react";
import type {
  LoyaltyAccount,
  LoyaltyCustomer,
  RewardTier,
} from "@/lib/loyalty-types";

/**
 * SMS "from" phone numbers per location.
 * The verification text appears to come from the venue's main line.
 */
const SMS_FROM: Record<string, string> = {
  fasttrax: "+12393022155",
  headpinz: "+12393022155",
  naples: "+12394553755",
};

export interface UseLoyaltyOpts {
  /** Location key — determines which SMS number the verify text comes from. */
  locationKey: string;
}

export interface UseLoyaltyReturn {
  /* ── State ── */
  account: LoyaltyAccount | null;
  customer: LoyaltyCustomer | null;
  phoneLookedUp: boolean;
  phoneLookupLoading: boolean;
  phoneVerified: boolean;
  verifyStep: "idle" | "sending" | "code" | "verified";
  verifyCode: string[];
  verifyError: string;
  rewardsSignup: boolean;
  isNewSignup: boolean;
  enrolling: boolean;
  rewardTiers: RewardTier[];
  selectedRewardTier: RewardTier | null;

  /* ── Handlers ── */
  /** Call when phone digits change (pass raw 10-digit string). Auto-triggers lookup at 10 digits. */
  handlePhoneChange: (digits: string) => void;
  /** Send SMS verification code. */
  sendVerifyCode: (phone: string) => void;
  /** Handle individual code digit input. */
  handleCodeInput: (index: number, value: string) => void;
  /** Handle keydown on code digits (backspace navigation). */
  handleCodeKeyDown: (index: number, e: React.KeyboardEvent) => void;
  /** Handle paste into code input. */
  handleCodePaste: (e: React.ClipboardEvent) => void;
  /** Refs for the 6 code input elements. */
  codeInputRefs: React.MutableRefObject<(HTMLInputElement | null)[]>;
  /** Toggle rewards signup checkbox. */
  setRewardsSignup: (v: boolean) => void;
  /** Select or deselect a reward tier. */
  setSelectedRewardTier: (tier: RewardTier | null) => void;
  /** Enroll in rewards (call after contact info is known). */
  enroll: (phone: string, name?: string, email?: string) => Promise<void>;
  /** Reset all loyalty state. */
  reset: () => void;
}

export function useLoyalty({ locationKey }: UseLoyaltyOpts): UseLoyaltyReturn {
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [customer, setCustomer] = useState<LoyaltyCustomer | null>(null);
  const [phoneLookedUp, setPhoneLookedUp] = useState(false);
  const [phoneLookupLoading, setPhoneLookupLoading] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [verifyStep, setVerifyStep] = useState<"idle" | "sending" | "code" | "verified">("idle");
  const [verifyCode, setVerifyCode] = useState(["", "", "", "", "", ""]);
  const [verifyError, setVerifyError] = useState("");
  const [rewardsSignup, setRewardsSignup] = useState(false);
  const [isNewSignup, setIsNewSignup] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [rewardTiers, setRewardTiers] = useState<RewardTier[]>([]);
  const [selectedRewardTier, setSelectedRewardTier] = useState<RewardTier | null>(null);
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Ref to track the loyalty account for use inside callbacks that close over stale state
  const accountRef = useRef<LoyaltyAccount | null>(null);
  accountRef.current = account;

  const reset = useCallback(() => {
    setAccount(null);
    setCustomer(null);
    setPhoneLookedUp(false);
    setPhoneLookupLoading(false);
    setPhoneVerified(false);
    setVerifyStep("idle");
    setVerifyCode(["", "", "", "", "", ""]);
    setVerifyError("");
    setRewardsSignup(false);
    setIsNewSignup(false);
    setRewardTiers([]);
    setSelectedRewardTier(null);
  }, []);

  /** Look up loyalty account by phone (10 digits). */
  const lookupByPhone = useCallback(async (digits: string) => {
    if (digits.length !== 10) return;
    setPhoneLookupLoading(true);
    setPhoneLookedUp(false);
    try {
      const res = await fetch("/api/square/loyalty/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.exists) {
        setAccount(data.account);
      } else {
        setAccount(null);
      }
      setCustomer(null);
      setPhoneLookedUp(true);
    } catch {
      // Silently fail — guest can proceed without rewards
      setPhoneLookedUp(true);
    } finally {
      setPhoneLookupLoading(false);
    }
  }, []);

  /** Called when phone field changes. Resets loyalty state on change, auto-lookups at 10 digits. */
  const handlePhoneChange = useCallback(
    (digits: string) => {
      // Reset if phone changed after a previous lookup
      if (phoneLookedUp) {
        reset();
      }
      if (digits.length === 10) {
        void lookupByPhone(digits);
      }
    },
    [phoneLookedUp, reset, lookupByPhone],
  );

  /** Send SMS verification code to the guest's phone. */
  const sendVerifyCode = useCallback(
    async (phone: string) => {
      const digits = phone.replace(/\D/g, "");
      if (digits.length !== 10) return;
      setVerifyStep("sending");
      setVerifyError("");
      try {
        const smsFrom = SMS_FROM[locationKey] || SMS_FROM.headpinz;
        const res = await fetch("/api/sms-verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: digits, from: smsFrom }),
        });
        const data = await res.json();
        if (data.sent) {
          setVerifyStep("code");
          setVerifyCode(["", "", "", "", "", ""]);
        } else {
          setVerifyError(data.error || "Failed to send code");
          setVerifyStep("idle");
        }
      } catch {
        setVerifyError("Failed to send code");
        setVerifyStep("idle");
      }
    },
    [locationKey],
  );

  /** Submit the 6-digit verification code. */
  const submitCode = useCallback(
    async (codeStr: string, phone: string) => {
      const digits = phone.replace(/\D/g, "");
      setVerifyError("");
      try {
        const res = await fetch("/api/sms-verify", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: digits,
            code: codeStr,
            squareCustomerId: accountRef.current?.customerId,
          }),
        });
        const data = await res.json();
        if (data.verified) {
          setPhoneVerified(true);
          setVerifyStep("verified");
          if (data.customer) {
            setCustomer(data.customer);
          }
          // Fetch reward tiers so verified members can redeem Pinz
          if (accountRef.current) {
            void fetch("/api/square/loyalty/program")
              .then((r) => r.json())
              .then((prog) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const orderTiers = (prog.rewardTiers ?? [])
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .filter((t: any) => t.definition?.scope === "ORDER" && t.definition?.fixedDiscountCents)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  .map((t: any) => ({
                    id: t.id as string,
                    name: t.name as string,
                    points: t.points as number,
                    discountCents: t.definition.fixedDiscountCents as number,
                  }))
                  .sort((a: { points: number }, b: { points: number }) => a.points - b.points);
                setRewardTiers(orderTiers);
              })
              .catch(() => {});
          }
        } else {
          setVerifyError(data.error || "Incorrect code");
        }
      } catch {
        setVerifyError("Verification failed");
      }
    },
    [],
  );

  // We need the phone for submitCode, but the hook consumer provides it.
  // Store it so code input handlers can access it.
  const phoneRef = useRef("");

  /** Handle individual code digit input. */
  const handleCodeInput = useCallback(
    (index: number, value: string) => {
      if (!/^\d?$/.test(value)) return;
      setVerifyCode((prev) => {
        const next = [...prev];
        next[index] = value;
        // Auto-submit when all 6 digits entered
        if (value && index === 5 && next.every((d) => d)) {
          void submitCode(next.join(""), phoneRef.current);
        }
        return next;
      });
      if (value && index < 5) {
        codeInputRefs.current[index + 1]?.focus();
      }
    },
    [submitCode],
  );

  const handleCodeKeyDown = useCallback(
    (index: number, e: React.KeyboardEvent) => {
      if (e.key === "Backspace" && !verifyCode[index] && index > 0) {
        codeInputRefs.current[index - 1]?.focus();
      }
    },
    [verifyCode],
  );

  const handleCodePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
      if (pasted.length === 6) {
        e.preventDefault();
        const newCode = pasted.split("");
        setVerifyCode(newCode);
        codeInputRefs.current[5]?.focus();
        void submitCode(pasted, phoneRef.current);
      }
    },
    [submitCode],
  );

  /** Wrapper around sendVerifyCode that also stashes phone for code handlers. */
  const sendVerifyCodeWrapped = useCallback(
    (phone: string) => {
      phoneRef.current = phone.replace(/\D/g, "");
      void sendVerifyCode(phone);
    },
    [sendVerifyCode],
  );

  /** Enroll new customer in HeadPinz Rewards. */
  const enroll = useCallback(
    async (phone: string, name?: string, email?: string) => {
      const digits = phone.replace(/\D/g, "");
      setEnrolling(true);
      try {
        const res = await fetch("/api/square/loyalty/enroll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: digits }),
        });
        const data = await res.json();
        if (data.account) {
          setAccount(data.account);
          setCustomer(data.customer);
          setIsNewSignup(true);
          setRewardsSignup(false);
          // Complete profile with name + email if provided
          if (name && data.account?.id && data.customer?.id) {
            const parts = name.trim().split(/\s+/);
            const firstName = parts[0] || "";
            const lastName = parts.slice(1).join(" ") || "";
            if (firstName && lastName) {
              void fetch("/api/square/loyalty/complete-profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  customerId: data.customer.id,
                  loyaltyAccountId: data.account.id,
                  firstName,
                  lastName,
                  email: email || undefined,
                }),
              })
                .then((r) => r.json())
                .then((d) => {
                  if (d.account) setAccount(d.account);
                })
                .catch(() => {});
            }
          }
        }
      } catch {
        // Silently fail — booking continues without rewards
      } finally {
        setEnrolling(false);
      }
    },
    [],
  );

  return {
    // State
    account,
    customer,
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
    // Handlers
    handlePhoneChange,
    sendVerifyCode: sendVerifyCodeWrapped,
    handleCodeInput,
    handleCodeKeyDown,
    handleCodePaste,
    codeInputRefs,
    setRewardsSignup,
    setSelectedRewardTier,
    enroll,
    reset,
  };
}
