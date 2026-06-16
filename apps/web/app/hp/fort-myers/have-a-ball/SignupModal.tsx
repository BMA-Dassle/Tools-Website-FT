"use client";

import { useState, useRef, useEffect } from "react";
import CardCaptureForm, { type CardCaptureHandle } from "@/components/square/CardCaptureForm";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * Have-A-Ball league signup modal.
 * Step 1: bowler info  ->  Step 2: card entry + join.
 *
 * On open it fetches a quote from the server (the go-forward weekly schedule
 * for whatever weeks remain) and submits a single /join call. The server owns
 * all money math — this component sends no amounts.
 */

interface JoinPlan {
  status: "preseason" | "midseason" | "closed";
  subStartDate: string;
  remainingCharges: number;
  weeklyTotalCents: number;
  totalDueCents: number;
  /** Weeks already played — disclosed as a retro payment owed, not charged here. */
  missedWeeks: number;
  retroAmountCents: number;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function longDate(ymd: string): string {
  const dt = new Date(`${ymd}T12:00:00Z`);
  return dt.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

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
  const [step, setStep] = useState<"info" | "payment" | "success">("info");
  const [bowler, setBowler] = useState<Bowler>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Bowler, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [plan, setPlan] = useState<JoinPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ subscriptionId: string } | null>(null);
  const cardRef = useRef<CardCaptureHandle>(null);
  // Stable per-mount id so a network retry can't create a duplicate subscription.
  // Generated in an effect (crypto is impure / unavailable during SSR render).
  const joinAttemptId = useRef<string>("");
  useEffect(() => {
    joinAttemptId.current = crypto.randomUUID();
  }, []);

  // Lock background scroll while open — on mobile the page behind would
  // otherwise scroll instead of the modal content.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Fetch the current quote (go-forward schedule for the remaining weeks) on open.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/leagues/have-a-ball/quote")
      .then((r) => r.json())
      .then((p: JoinPlan) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        if (!cancelled) setPlanError("Couldn't load pricing — please refresh.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const seasonClosed = plan?.status === "closed" || (plan?.remainingCharges ?? 1) === 0;

  function handleInfoNext(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateBowler(bowler);
    setErrors(errs);
    if (Object.keys(errs).length === 0) setStep("payment");
  }

  async function handleJoin() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const tok = await cardRef.current?.tokenize();
      if (!tok || "error" in tok) {
        setSubmitError(tok && "error" in tok ? tok.error : "Card entry failed");
        setSubmitting(false);
        return;
      }

      const res = await fetch("/api/leagues/have-a-ball/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cardToken: tok.token,
          joinAttemptId: joinAttemptId.current,
          firstName: bowler.firstName,
          lastName: bowler.lastName,
          email: bowler.email,
          phone: bowler.phone,
          dob: bowler.dob,
          teamName: bowler.teamName || null,
          smsOptIn: bowler.smsOptIn,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSubmitError(data.error || "Failed to complete signup");
        setSubmitting(false);
        return;
      }

      setConfirmation({ subscriptionId: data.subscriptionId });
      setStep("success");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const headerSub = plan
    ? `Starts ${longDate(plan.subStartDate)} · ${usd(plan.weeklyTotalCents)}/week · ball included`
    : "$21.30/week · ball included";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,22,40,0.9)" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-2xl rounded-xl max-h-[90vh] flex flex-col overflow-hidden"
        style={{ backgroundColor: "#0a1628", border: "1.78px dashed rgba(253,91,86,0.45)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl leading-none"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-6 sm:p-8 min-h-0 overflow-y-auto overscroll-contain">
          <div className="mb-5">
            <p className="text-[#fd5b56] text-xs font-bold uppercase tracking-widest">
              HeadPinz Fort Myers
            </p>
            <h2 className="text-white font-heading uppercase text-2xl sm:text-3xl tracking-wider">
              Have-A-Ball League Signup
            </h2>
            <p className="text-white/50 text-sm mt-1">{headerSub}</p>
          </div>

          {seasonClosed ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-center text-white/70">
              <p className="text-white font-semibold mb-2">It&apos;s late in the season</p>
              <p className="text-sm">
                Online signup is closed for the final week. Give us a call at{" "}
                <a href="tel:+12393022155" className="text-[#fd5b56]">
                  (239) 302-2155
                </a>{" "}
                and we&apos;ll get you on the lanes.
              </p>
            </div>
          ) : (
            <>
              {/* Progress dots */}
              <div className="flex items-center gap-2 mb-6">
                {(["info", "payment", "success"] as const).map((s, i) => (
                  <div
                    key={s}
                    className={`h-1.5 flex-1 rounded-full ${
                      step === s
                        ? "bg-[#fd5b56]"
                        : ["info", "payment", "success"].indexOf(step) > i
                          ? "bg-[#fd5b56]/60"
                          : "bg-white/10"
                    }`}
                  />
                ))}
              </div>

              {planError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 mb-4 text-red-200 text-sm">
                  {planError}
                </div>
              )}

              {step === "info" && (
                <form onSubmit={handleInfoNext} className="space-y-4">
                  {plan && plan.status === "midseason" && (
                    <div className="rounded-lg border border-[#fd5b56]/40 bg-[#fd5b56]/10 p-4 text-sm">
                      <p className="text-white font-semibold mb-1">
                        The season&apos;s already underway — jump in now:
                      </p>
                      <p className="text-white/75 leading-relaxed">
                        Your card is set up for the{" "}
                        <strong className="text-white">
                          {plan.remainingCharges} remaining week
                        </strong>
                        {plan.remainingCharges === 1 ? "" : "s"} —{" "}
                        <strong className="text-white">{usd(plan.weeklyTotalCents)}/week</strong>{" "}
                        starting {longDate(plan.subStartDate)}. No charge today.
                      </p>
                      {plan.missedWeeks > 0 && (
                        <p className="text-white/75 leading-relaxed mt-2">
                          Heads up: you&apos;ll also be responsible for a one-time retro payment of{" "}
                          <strong className="text-white">{usd(plan.retroAmountCents)}</strong> for
                          the {plan.missedWeeks} week{plan.missedWeeks === 1 ? "" : "s"} already
                          played. A HeadPinz team member will arrange this with you separately.
                        </p>
                      )}
                    </div>
                  )}
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
                        onChange={(e) =>
                          setBowler({ ...bowler, phone: formatPhone(e.target.value) })
                        }
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
                    <span>Text me league updates.</span>
                  </label>
                  <button
                    type="submit"
                    className="w-full rounded-full font-bold uppercase tracking-widest text-white py-3 transition-all hover:brightness-110"
                    style={{
                      backgroundColor: "#fd5b56",
                      boxShadow: "0 0 24px rgba(253,91,86,0.4)",
                    }}
                  >
                    Continue to Payment →
                  </button>
                </form>
              )}

              {step === "payment" && (
                <div className="space-y-5">
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
                    <p className="text-white font-semibold mb-2">
                      Signing up: {bowler.firstName} {bowler.lastName}
                    </p>
                    {plan ? (
                      <>
                        <p>
                          Your card will be charged{" "}
                          <strong className="text-white">
                            {usd(plan.weeklyTotalCents)} every week for {plan.remainingCharges} week
                            {plan.remainingCharges === 1 ? "" : "s"}
                          </strong>{" "}
                          ($20 + 6.5% Lee County tax), starting{" "}
                          <strong className="text-white">{longDate(plan.subStartDate)}</strong>.
                          Total: {usd(plan.totalDueCents)}. You won&apos;t be charged anything
                          today. Cancel any time by contacting HeadPinz.
                        </p>
                        {plan.missedWeeks > 0 && (
                          <p className="mt-3 rounded-md border border-[#fd5b56]/40 bg-[#fd5b56]/10 px-3 py-2 text-white/80">
                            <strong className="text-white">One-time retro payment:</strong> because
                            the season is underway, you&apos;re also responsible for a one-time{" "}
                            <strong className="text-white">{usd(plan.retroAmountCents)}</strong>{" "}
                            retro payment for the {plan.missedWeeks} week
                            {plan.missedWeeks === 1 ? "" : "s"} already played. A HeadPinz team
                            member will arrange this with you separately — it is{" "}
                            <strong>not</strong> charged here.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-white/40">Loading pricing…</p>
                    )}
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
                      onClick={handleJoin}
                      disabled={submitting || !plan}
                      className="flex-[2] rounded-full font-bold uppercase tracking-widest text-white py-3 transition-all hover:brightness-110 disabled:opacity-60"
                      style={{
                        backgroundColor: "#fd5b56",
                        boxShadow: "0 0 24px rgba(253,91,86,0.4)",
                      }}
                    >
                      {submitting ? "Processing…" : "Reserve My Spot"}
                    </button>
                  </div>
                </div>
              )}

              {step === "success" && confirmation && (
                <div className="text-center space-y-4 py-4">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40">
                    <svg
                      className="w-8 h-8 text-emerald-400"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-white font-heading uppercase text-2xl">
                    You&apos;re In, {bowler.firstName}!
                  </h3>
                  <p className="text-white/60 text-sm max-w-md mx-auto">
                    Your first weekly charge runs on{" "}
                    <strong className="text-white">
                      {plan ? longDate(plan.subStartDate) : "the start date"}
                    </strong>
                    .{" "}
                    {plan && plan.missedWeeks > 0 && (
                      <>
                        We&apos;ll reach out about the one-time{" "}
                        <strong className="text-white">{usd(plan.retroAmountCents)}</strong> retro
                        payment for the weeks already played.{" "}
                      </>
                    )}
                    We&apos;ll email ball selection and lane details soon.
                  </p>
                  <div className="inline-block rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-xs text-white/50">
                    Subscription ID: {confirmation.subscriptionId}
                  </div>
                  <button
                    onClick={onClose}
                    className="mt-2 rounded-full font-bold uppercase tracking-widest text-white py-3 px-8 transition-all hover:brightness-110 block mx-auto"
                    style={{ backgroundColor: "#fd5b56" }}
                  >
                    Done
                  </button>
                </div>
              )}
            </>
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
      <span className="text-white/60 text-xs font-semibold uppercase tracking-wider mb-1 block">
        {label}
      </span>
      {children}
      {error && <span className="text-red-400 text-xs mt-1 block">{error}</span>}
    </label>
  );
}

function inputClass(hasError: boolean) {
  return `w-full rounded-lg border bg-white/5 px-3 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 ${
    hasError
      ? "border-red-500/50 focus:ring-red-500/40"
      : "border-white/15 focus:ring-[#fd5b56]/40 focus:border-[#fd5b56]/50"
  }`;
}
