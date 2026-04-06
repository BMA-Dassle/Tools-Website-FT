"use client";

import { useState, useEffect, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface LoyaltyAccount {
  id: string;
  balance: number;
  lifetimePoints: number;
  customerId: string;
  enrolledAt: string;
}

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  profileComplete: boolean;
}

interface RewardTier {
  id: string;
  points: number;
  name: string;
}

interface AccrualRule {
  type: string;
  points: number;
  spendAmountCents?: number;
}

interface ProgramData {
  terminology: { one: string; other: string };
  rewardTiers: RewardTier[];
  accrualRules: AccrualRule[];
}

type Step = "phone" | "code" | "dashboard";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function rawDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function RewardsPortal() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [codeSending, setCodeSending] = useState(false);

  // Dashboard state
  const [account, setAccount] = useState<LoyaltyAccount | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [program, setProgram] = useState<ProgramData | null>(null);
  const [isNewUser, setIsNewUser] = useState(false);

  // Profile completion form
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [bonusAwarded, setBonusAwarded] = useState(false);

  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Fetch program data on mount
  useEffect(() => {
    fetch("/api/square/loyalty/program")
      .then((r) => r.json())
      .then((d) => { if (!d.error) setProgram(d); })
      .catch(() => {});
  }, []);

  /* ── Phone entry ───────────────────────────────────────────────── */

  async function handleSendCode() {
    const digits = rawDigits(phone);
    if (digits.length !== 10) {
      setError("Please enter a valid 10-digit phone number");
      return;
    }
    setError("");
    setCodeSending(true);

    try {
      const res = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (data.sent) {
        setStep("code");
        setCode(["", "", "", "", "", ""]);
      } else {
        setError(data.error || "Failed to send code");
      }
    } catch {
      setError("Failed to send code");
    } finally {
      setCodeSending(false);
    }
  }

  /* ── Code verification ─────────────────────────────────────────── */

  function handleCodeInput(index: number, value: string) {
    if (!/^\d?$/.test(value)) return;
    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);

    // Auto-focus next input
    if (value && index < 5) {
      codeRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (value && index === 5 && newCode.every((d) => d)) {
      verifyCode(newCode.join(""));
    }
  }

  function handleCodeKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      codeRefs.current[index - 1]?.focus();
    }
  }

  function handleCodePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      const newCode = pasted.split("");
      setCode(newCode);
      codeRefs.current[5]?.focus();
      verifyCode(pasted);
    }
  }

  async function verifyCode(fullCode: string) {
    setError("");
    setLoading(true);
    const digits = rawDigits(phone);

    try {
      // Step 1: Verify SMS code
      const verifyRes = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits, code: fullCode }),
      });
      const verifyData = await verifyRes.json();

      if (!verifyData.verified) {
        setError(verifyData.error || "Invalid code");
        setLoading(false);
        return;
      }

      // Step 2: Look up loyalty account
      const lookupRes = await fetch("/api/square/loyalty/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const lookupData = await lookupRes.json();

      if (lookupData.exists) {
        // Returning customer
        setAccount(lookupData.account);
        setCustomer(lookupData.customer);
        setIsNewUser(false);
        setStep("dashboard");
      } else {
        // New customer — enroll
        const enrollRes = await fetch("/api/square/loyalty/enroll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: digits }),
        });
        const enrollData = await enrollRes.json();

        if (enrollData.error) {
          setError(enrollData.error);
          setLoading(false);
          return;
        }

        setAccount(enrollData.account);
        setCustomer(enrollData.customer);
        setIsNewUser(true);
        setShowProfileForm(true);
        setStep("dashboard");
      }
    } catch {
      setError("Verification failed");
    } finally {
      setLoading(false);
    }
  }

  /* ── Profile completion ────────────────────────────────────────── */

  async function handleCompleteProfile() {
    if (!profileFirstName.trim() || !profileLastName.trim()) {
      setError("First and last name are required");
      return;
    }
    setError("");
    setProfileSaving(true);

    try {
      const res = await fetch("/api/square/loyalty/complete-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer?.id,
          loyaltyAccountId: account?.id,
          firstName: profileFirstName,
          lastName: profileLastName,
          email: profileEmail || undefined,
        }),
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setAccount(data.account);
        setCustomer(data.customer);
        setBonusAwarded(true);
        setShowProfileForm(false);
      }
    } catch {
      setError("Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }

  /* ── Render ────────────────────────────────────────────────────── */

  const termPlural = program?.terminology?.other || "Pinz";

  return (
    <div className="max-w-lg mx-auto">
      {/* ====== PHONE ENTRY ====== */}
      {step === "phone" && (
        <div
          className="rounded-lg p-8 text-center"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
        >
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white text-xl tracking-wider mb-2"
            style={{ textShadow: "0 0 20px rgba(255,215,0,0.25)" }}
          >
            Sign In or Sign Up
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-6">
            Enter your phone number to check your balance or create a new account
          </p>

          <div className="mb-4">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
              placeholder="(239) 555-0123"
              className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3.5 text-white text-center text-lg font-[var(--font-hp-body)] tracking-wider placeholder:text-white/20 focus:outline-none focus:border-[#FFD700]/50 transition-colors"
            />
          </div>

          {error && (
            <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm mb-4">{error}</p>
          )}

          <button
            onClick={handleSendCode}
            disabled={codeSending || rawDigits(phone).length !== 10}
            className="w-full bg-[#FFD700] hover:bg-[#ffe44d] text-[#0a1628] font-[var(--font-hp-body)] font-bold text-base uppercase tracking-wider py-3.5 rounded-full transition-all hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
            style={{ boxShadow: "0 0 20px rgba(255,215,0,0.3)" }}
          >
            {codeSending ? "Sending..." : "Send Verification Code"}
          </button>
        </div>
      )}

      {/* ====== CODE VERIFICATION ====== */}
      {step === "code" && (
        <div
          className="rounded-lg p-8 text-center"
          style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
        >
          <h2
            className="font-[var(--font-hp-display)] uppercase text-white text-xl tracking-wider mb-2"
            style={{ textShadow: "0 0 20px rgba(255,215,0,0.25)" }}
          >
            Enter Code
          </h2>
          <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-6">
            We sent a 6-digit code to {phone}
          </p>

          {/* 6-digit code input */}
          <div className="flex justify-center gap-2 mb-4">
            {code.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { codeRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleCodeInput(i, e.target.value)}
                onKeyDown={(e) => handleCodeKeyDown(i, e)}
                onPaste={i === 0 ? handleCodePaste : undefined}
                className="w-12 h-14 bg-[#0a1628] border border-white/20 rounded-lg text-white text-center text-xl font-[var(--font-hp-body)] font-bold focus:outline-none focus:border-[#FFD700]/50 transition-colors"
              />
            ))}
          </div>

          {error && (
            <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm mb-4">{error}</p>
          )}

          {loading && (
            <p className="font-[var(--font-hp-body)] text-[#FFD700] text-sm mb-4">Verifying...</p>
          )}

          <div className="flex items-center justify-between mt-6">
            <button
              onClick={() => { setStep("phone"); setError(""); }}
              className="font-[var(--font-hp-body)] text-white/40 hover:text-white text-sm transition-colors"
            >
              &larr; Change Number
            </button>
            <button
              onClick={handleSendCode}
              className="font-[var(--font-hp-body)] text-[#FFD700] hover:text-[#ffe44d] text-sm transition-colors"
            >
              Resend Code
            </button>
          </div>
        </div>
      )}

      {/* ====== DASHBOARD ====== */}
      {step === "dashboard" && account && (
        <div className="space-y-6">
          {/* Welcome / Balance card */}
          <div
            className="rounded-lg p-8 text-center"
            style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.3)" }}
          >
            {isNewUser && !bonusAwarded && (
              <div className="bg-[#FFD700]/10 border border-[#FFD700]/30 rounded-lg px-4 py-3 mb-6">
                <p className="font-[var(--font-hp-body)] text-[#FFD700] text-sm font-bold">
                  Welcome to HeadPinz Rewards!
                </p>
              </div>
            )}

            {bonusAwarded && (
              <div className="bg-[#FFD700]/10 border border-[#FFD700]/30 rounded-lg px-4 py-3 mb-6">
                <p className="font-[var(--font-hp-body)] text-[#FFD700] text-sm font-bold">
                  +500 {termPlural} bonus added!
                </p>
              </div>
            )}

            {customer?.firstName && (
              <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-1">
                {customer.firstName} {customer.lastName}
              </p>
            )}

            <div className="mb-2">
              <span
                className="font-[var(--font-hp-display)] text-[#FFD700]"
                style={{ fontSize: "clamp(48px, 10vw, 72px)", textShadow: "0 0 30px rgba(255,215,0,0.35)" }}
              >
                {account.balance.toLocaleString()}
              </span>
            </div>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm uppercase tracking-wider">
              {termPlural} Balance
            </p>
            <p className="font-[var(--font-hp-body)] text-white/30 text-xs mt-2">
              {account.lifetimePoints.toLocaleString()} lifetime {termPlural.toLowerCase()} earned
            </p>
          </div>

          {/* Profile completion prompt */}
          {showProfileForm && !customer?.profileComplete && (
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(253,91,86,0.3)" }}
            >
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-1">
                Complete Your Profile
              </h3>
              <p className="font-[var(--font-hp-body)] text-[#FFD700] text-sm font-bold mb-4">
                Get 500 bonus {termPlural}!
              </p>

              <div className="space-y-3 mb-4">
                <input
                  type="text"
                  value={profileFirstName}
                  onChange={(e) => setProfileFirstName(e.target.value)}
                  placeholder="First Name"
                  className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3 text-white text-sm font-[var(--font-hp-body)] placeholder:text-white/20 focus:outline-none focus:border-[#FFD700]/50 transition-colors"
                />
                <input
                  type="text"
                  value={profileLastName}
                  onChange={(e) => setProfileLastName(e.target.value)}
                  placeholder="Last Name"
                  className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3 text-white text-sm font-[var(--font-hp-body)] placeholder:text-white/20 focus:outline-none focus:border-[#FFD700]/50 transition-colors"
                />
                <input
                  type="email"
                  value={profileEmail}
                  onChange={(e) => setProfileEmail(e.target.value)}
                  placeholder="Email (optional)"
                  className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3 text-white text-sm font-[var(--font-hp-body)] placeholder:text-white/20 focus:outline-none focus:border-[#FFD700]/50 transition-colors"
                />
              </div>

              {error && (
                <p className="font-[var(--font-hp-body)] text-[#fd5b56] text-sm mb-3">{error}</p>
              )}

              <button
                onClick={handleCompleteProfile}
                disabled={profileSaving}
                className="w-full bg-[#FFD700] hover:bg-[#ffe44d] text-[#0a1628] font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider py-3 rounded-full transition-all hover:scale-[1.02] disabled:opacity-50"
                style={{ boxShadow: "0 0 16px rgba(255,215,0,0.3)" }}
              >
                {profileSaving ? "Saving..." : `Claim 500 ${termPlural}`}
              </button>
            </div>
          )}

          {/* Reward tiers */}
          {program && program.rewardTiers.length > 0 && (
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.2)" }}
            >
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-4">
                Rewards
              </h3>

              <div className="space-y-4">
                {program.rewardTiers
                  .sort((a, b) => a.points - b.points)
                  .map((tier) => {
                    const progress = Math.min((account.balance / tier.points) * 100, 100);
                    const canRedeem = account.balance >= tier.points;

                    return (
                      <div key={tier.id}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-[var(--font-hp-body)] text-white text-sm">
                            {tier.name}
                          </span>
                          <span
                            className="font-[var(--font-hp-body)] text-xs font-bold"
                            style={{ color: canRedeem ? "#FFD700" : "rgba(255,255,255,0.4)" }}
                          >
                            {tier.points.toLocaleString()} {termPlural}
                          </span>
                        </div>
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${progress}%`,
                              background: canRedeem
                                ? "linear-gradient(90deg, #FFD700, #fd5b56)"
                                : "linear-gradient(90deg, rgba(255,215,0,0.4), rgba(253,91,86,0.4))",
                            }}
                          />
                        </div>
                        {canRedeem && (
                          <p className="font-[var(--font-hp-body)] text-[#FFD700] text-xs mt-1">
                            Ready to redeem!
                          </p>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* How to earn */}
          {program && program.accrualRules.length > 0 && (
            <div
              className="rounded-lg p-6"
              style={{ backgroundColor: "rgba(7,16,39,0.5)", border: "1.78px dashed rgba(255,215,0,0.15)" }}
            >
              <h3 className="font-[var(--font-hp-display)] uppercase text-white text-base tracking-wider mb-3">
                How to Earn
              </h3>
              <div className="space-y-2">
                {program.accrualRules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="font-[var(--font-hp-body)] text-[#FFD700] text-sm font-bold whitespace-nowrap">
                      +{rule.points} {termPlural}
                    </span>
                    <span className="font-[var(--font-hp-body)] text-white/50 text-sm">
                      {rule.type === "SPEND"
                        ? `per $${((rule.spendAmountCents || 100) / 100).toFixed(0)} spent`
                        : rule.type === "VISIT"
                        ? "per visit"
                        : rule.type.toLowerCase().replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sign out */}
          <div className="text-center">
            <button
              onClick={() => {
                setStep("phone");
                setPhone("");
                setCode(["", "", "", "", "", ""]);
                setAccount(null);
                setCustomer(null);
                setIsNewUser(false);
                setShowProfileForm(false);
                setBonusAwarded(false);
                setError("");
              }}
              className="font-[var(--font-hp-body)] text-white/30 hover:text-white/60 text-sm transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
