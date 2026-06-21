"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRequestOtp, useVerifyOtp } from "~/features/account/hooks";
import { AccountApiError } from "~/features/account/api";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Input from "~/components/ui/Input";
import ErrorBox from "~/components/ui/ErrorBox";

export default function LoginFlow() {
  const [phase, setPhase] = useState<"contact" | "otp">("contact");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ maskedDestination: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptsMsg, setAttemptsMsg] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (phase === "otp") codeRef.current?.focus();
  }, [phase]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      const res = await requestOtp.mutateAsync(contact.trim());
      setSent({ maskedDestination: res.maskedDestination });
      setPhase("otp");
      setCooldown(30);
      setAttemptsMsg(null);
    } catch (err) {
      setError(
        err instanceof AccountApiError ? err.message : "Couldn't send a code. Please try again.",
      );
    }
  }

  async function verify(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setAttemptsMsg(null);
    try {
      const res = await verifyOtp.mutateAsync({ contact: contact.trim(), code: code.trim() });
      if (!res.ok) {
        const left =
          res.attemptsLeft != null && res.attemptsLeft > 0
            ? ` ${res.attemptsLeft} ${res.attemptsLeft === 1 ? "try" : "tries"} left.`
            : "";
        setAttemptsMsg(`${res.error ?? "Incorrect code."}${left}`);
        setCode("");
      }
      // On success, useVerifyOtp invalidates `me` → AccountPage swaps to the dashboard.
    } catch (err) {
      setError(
        err instanceof AccountApiError ? err.message : "Verification failed. Please try again.",
      );
    }
  }

  return (
    <Card className="mt-10 p-6">
      {phase === "contact" ? (
        <>
          <h1 className="mb-1 text-xl font-semibold text-white">Manage your membership</h1>
          <p className="mb-5 text-sm text-white/50">
            Sign in to view your subscriptions and update your payment card.
          </p>
          <form onSubmit={send} className="space-y-4">
            <Input
              label="Email or mobile number"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              autoComplete="username"
              placeholder="you@example.com or (239) 555-1234"
            />
            {error && <ErrorBox>{error}</ErrorBox>}
            <Button type="submit" loading={requestOtp.isPending} className="w-full">
              Send code
            </Button>
          </form>
        </>
      ) : (
        <>
          <h1 className="mb-1 text-xl font-semibold text-white">Enter your code</h1>
          <p className="mb-5 text-sm text-white/50">
            We sent a 6-digit code to {sent?.maskedDestination}.
          </p>
          <form onSubmit={verify} className="space-y-4">
            <Input
              ref={codeRef}
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
            />
            {attemptsMsg && (
              <p role="alert" className="text-sm text-red-300">
                {attemptsMsg}
              </p>
            )}
            {error && <ErrorBox>{error}</ErrorBox>}
            <Button
              type="submit"
              loading={verifyOtp.isPending}
              disabled={code.length !== 6}
              className="w-full"
            >
              Verify
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => {
                setPhase("contact");
                setCode("");
                setError(null);
                setAttemptsMsg(null);
              }}
              className="text-white/50 hover:text-white"
            >
              Change email/phone
            </button>
            <button
              type="button"
              onClick={() => send()}
              disabled={cooldown > 0 || requestOtp.isPending}
              className="font-medium text-[color:var(--account-accent)] disabled:text-white/30"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
