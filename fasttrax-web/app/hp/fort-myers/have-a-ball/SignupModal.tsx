"use client";

import { useState, useRef } from "react";
import CardCaptureForm, { type CardCaptureHandle } from "@/components/square/CardCaptureForm";

/**
 * Have-A-Ball league signup modal.
 * Step 1: bowler info  ->  Step 2: card entry + subscribe.
 */

const PLAN_VARIATION_ID = "VGQZDMULELNJNVLC3SUSY2R3"; // "Have A Ball" subscription plan variation
const LOCATION_ID = "TXBSQN0FEKQ11"; // HeadPinz Fort Myers Square location
const START_DATE = "2026-05-26";

interface Props {
  onClose: () => void;
}

type Bowler = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  teamName: string;
  smsOptIn: boolean;
};

const EMPTY: Bowler = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dob: "",
  teamName: "",
  smsOptIn: true,
};

function validateBowler(b: Bowler): Partial<Record<keyof Bowler, string>> {
  const errs: Partial<Record<keyof Bowler, string>> = {};
  if (!b.firstName.trim()) errs.firstName = "Required";
  if (!b.lastName.trim()) errs.lastName = "Required";
  if (!b.email.trim()) errs.email = "Required";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errs.email = "Invalid email";
  const digits = b.phone.replace(/\D/g, "");
  if (!digits) errs.phone = "Required";
  else if (digits.length < 10) errs.phone = "Enter a 10-digit phone";
  if (!b.dob) errs.dob = "Required";
  return errs;
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function SignupModal({ onClose }: Props) {
  const [step, setStep] = useState<"info" | "payment" | "success" | "error">("info");
  const [bowler, setBowler] = useState<Bowler>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Bowler, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ subscriptionId: string; startDate: string } | null>(null);
  const cardRef = useRef<CardCaptureHandle>(null);

  function handleInfoNext(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateBowler(bowler);
    setErrors(errs);
    if (Object.keys(errs).length === 0) setStep("payment");
  }

  async function handleSubscribe() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 1. Tokenize card
      const tok = await cardRef.current?.tokenize();
      if (!tok || "error" in tok) {
        setSubmitError(tok && "error" in tok ? tok.error : "Card entry failed");
        setSubmitting(false);
        return;
      }

      // 2. Create subscription
      const subRes = await fetch("/api/square/subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cardToken: tok.token,
          planVariationId: PLAN_VARIATION_ID,
          locationId: LOCATION_ID,
          startDate: START_DATE,
          phone: bowler.phone,
          firstName: bowler.firstName,
          lastName: bowler.lastName,
          email: bowler.email,
        }),
      });
      const subData = await subRes.json();
      if (!subRes.ok || !subData.ok) {
        setSubmitError(subData.error || "Failed to create subscription");
        setSubmitting(false);
        return;
      }

      // 3. Store signup record
      await fetch("/api/leagues/have-a-ball/signups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscriptionId: subData.subscriptionId,
          customerId: subData.customerId,
          cardId: subData.cardId,
          firstName: bowler.firstName,
          lastName: bowler.lastName,
          email: bowler.email,
          phone: bowler.phone,
          dob: bowler.dob,
          teamName: bowler.teamName || null,
          smsOptIn: bowler.smsOptIn,
          startDate: subData.startDate,
        }),
      }).catch(() => { /* non-fatal — subscription succeeded */ });

      setConfirmation({ subscriptionId: subData.subscriptionId, startDate: subData.startDate });
      setStep("success");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      style={{ backgroundColor: "rgba(10,22,40,0.9)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl rounded-xl my-8"
        style={{ backgroundColor: "#0a1628", border: "1.78px dashed rgba(253,91,86,0.45)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl leading-none"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-6 sm:p-8">
          <div className="mb-5">
            <p className="text-[#fd5b56] text-xs font-bold uppercase tracking-widest">HeadPinz Fort Myers</p>
            <h2 className="text-white font-heading uppercase text-2xl sm:text-3xl tracking-wider">
              Have-A-Ball League Signup
            </h2>
            <p className="text-white/50 text-sm mt-1">
              Starts May 26, 2026 · $20/week for 12 weeks · Ball included
            </p>
          </div>

          {/* Progress dots */}
          <div className="flex items-center gap-2 mb-6">
            {(["info", "payment", "success"] as const).map((s, i) => (
              <div
                key={s}
                className={`h-1.5 flex-1 rounded-full ${
                  step === s
                    ? "bg-[#fd5b56]"
                    : (["info", "payment", "success"].indexOf(step) > i)
                      ? "bg-[#fd5b56]/60"
                      : "bg-white/10"
                }`}
              />
            ))}
          </div>

          {step === "info" && (
            <form onSubmit={handleInfoNext} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="First name" error={errors.firstName}>
                  <input
                    type="text"
                    value={bowler.firstName}
                    onChange={(e) => setBowler({ ...bowler, firstName: e.target.value })}
                    className={inputClass(!!errors.firstName)}
                    autoComplete="given-name"
                  />
                </Field>
                <Field label="Last name" error={errors.lastName}>
                  <input
                    type="text"
                    value={bowler.lastName}
                    onChange={(e) => setBowler({ ...bowler, lastName: e.target.value })}
                    className={inputClass(!!errors.lastName)}
                    autoComplete="family-name"
                  />
                </Field>
              </div>
              <Field label="Email" error={errors.email}>
                <input
                  type="email"
                  value={bowler.email}
                  onChange={(e) => setBowler({ ...bowler, email: e.target.value })}
                  className={inputClass(!!errors.email)}
                  autoComplete="email"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Phone" error={errors.phone}>
                  <input
                    type="tel"
                    value={bowler.phone}
                    onChange={(e) => setBowler({ ...bowler, phone: formatPhone(e.target.value) })}
                    className={inputClass(!!errors.phone)}
                    placeholder="(239) 555-1212"
                    autoComplete="tel"
                  />
                </Field>
                <Field label="Date of birth" error={errors.dob}>
                  <input
                    type="date"
                    value={bowler.dob}
                    onChange={(e) => setBowler({ ...bowler, dob: e.target.value })}
                    className={inputClass(!!errors.dob)}
                    autoComplete="bday"
                  />
                </Field>
              </div>
              <Field label="Team name or who you're bowling with (optional)">
                <input
                  type="text"
                  value={bowler.teamName}
                  onChange={(e) => setBowler({ ...bowler, teamName: e.target.value })}
                  className={inputClass(false)}
                  placeholder="e.g. Pin Crushers · or: Bowling with Alex and Jamie"
                />
              </Field>
              <label className="flex items-start gap-2 text-white/70 text-sm">
                <input
                  type="checkbox"
                  checked={bowler.smsOptIn}
                  onChange={(e) => setBowler({ ...bowler, smsOptIn: e.target.checked })}
                  className="mt-1"
                />
                <span>Text me league updates (lane assignments, weekly reminders, ball pickup info).</span>
              </label>
              <button
                type="submit"
                className="w-full rounded-full font-bold uppercase tracking-widest text-white py-3 transition-all hover:brightness-110"
                style={{ backgroundColor: "#fd5b56", boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
              >
                Continue to Payment →
              </button>
            </form>
          )}

          {step === "payment" && (
            <div className="space-y-5">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
                <p className="text-white font-semibold mb-1">Signing up: {bowler.firstName} {bowler.lastName}</p>
                <p>
                  Your card will be <strong className="text-white">charged $20 every week for 12 weeks</strong>, starting{" "}
                  <strong className="text-white">Tuesday, May 26, 2026</strong>. Total: $240. You won&apos;t be charged anything today — the first
                  charge runs on the start date. Cancel any time by contacting HeadPinz.
                </p>
              </div>

              <CardCaptureForm ref={cardRef} locationId="headpinz" />

              {submitError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-red-200 text-sm">
                  {submitError}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => setStep("info")}
                  className="flex-1 rounded-full border border-white/20 text-white/70 hover:text-white hover:border-white/40 py-3 text-sm font-bold uppercase tracking-widest"
                  disabled={submitting}
                >
                  ← Back
                </button>
                <button
                  onClick={handleSubscribe}
                  disabled={submitting}
                  className="flex-[2] rounded-full font-bold uppercase tracking-widest text-white py-3 transition-all hover:brightness-110 disabled:opacity-60"
                  style={{ backgroundColor: "#fd5b56", boxShadow: "0 0 24px rgba(253,91,86,0.4)" }}
                >
                  {submitting ? "Subscribing…" : "Reserve My Spot"}
                </button>
              </div>
            </div>
          )}

          {step === "success" && confirmation && (
            <div className="text-center space-y-4 py-4">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40">
                <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-white font-heading uppercase text-2xl">You&apos;re In, {bowler.firstName}!</h3>
              <p className="text-white/60 text-sm max-w-md mx-auto">
                Your first weekly charge of $20 runs on <strong className="text-white">Tuesday, May 26, 2026</strong>. We&apos;ll email you ball
                selection details and lane assignments as the season approaches.
              </p>
              <div className="inline-block rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-xs text-white/50">
                Subscription ID: {confirmation.subscriptionId}
              </div>
              <button
                onClick={onClose}
                className="mt-2 rounded-full font-bold uppercase tracking-widest text-white py-3 px-8 transition-all hover:brightness-110"
                style={{ backgroundColor: "#fd5b56" }}
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1 block">{label}</span>
      {children}
      {error && <span className="text-red-400 text-xs mt-1 block">{error}</span>}
    </label>
  );
}

function inputClass(hasError: boolean) {
  return `w-full rounded-lg border bg-white/5 px-3 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 ${
    hasError ? "border-red-500/50 focus:ring-red-500/40" : "border-white/15 focus:ring-[#fd5b56]/40 focus:border-[#fd5b56]/50"
  }`;
}
