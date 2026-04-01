"use client";

import { useState, useRef } from "react";
import { bmiGet } from "../data";

export interface PersonData {
  personId: string;
  fullName: string;
  email: string;
  races: number;
  maxExpiry: string | null;
  tag: string;
  loginCode: string;
  personReference: string;
}

interface Props {
  onVerified: (person: PersonData) => void;
  onSwitchToNew: () => void;
}

export default function ReturningRacerLookup({ onVerified, onSwitchToNew }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [phase, setPhase] = useState<"email" | "looking" | "not-found" | "sending" | "code" | "verified">("email");
  const [person, setPerson] = useState<PersonData | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function handleLookup() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;

    setPhase("looking");
    try {
      const result = await bmiGet("person", { email: trimmed });
      if (!result.person) { setPhase("not-found"); return; }

      const p: PersonData = {
        personId: result.person.personId,
        fullName: result.person.fullName,
        email: result.person.email,
        races: result.person.races ?? 0,
        maxExpiry: result.person.maxExpiry,
        tag: result.tag || result.person.tag,
        loginCode: result.loginCode,
        personReference: result.personReference,
      };
      setPerson(p);

      // Auto-send verification code
      setPhase("sending");
      await fetch("/api/email/login-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: p.email, loginCode: p.loginCode, fullName: p.fullName }),
      });
      setPhase("code");
      setTimeout(() => codeRef.current?.focus(), 100);
    } catch {
      setPhase("not-found");
    }
  }

  async function handleResend() {
    if (!person) return;
    setPhase("sending");
    await fetch("/api/email/login-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: person.email, loginCode: person.loginCode, fullName: person.fullName }),
    });
    setPhase("code");
  }

  function handleVerify() {
    if (!person) return;
    setCodeError("");
    if (code.trim().toLowerCase() === person.loginCode.toLowerCase()) {
      setPhase("verified");
      setTimeout(() => onVerified(person), 400);
    } else {
      setCodeError("Invalid code. Check your email and try again.");
    }
  }

  const isLicenseActive = person?.maxExpiry ? new Date(person.maxExpiry) > new Date() : false;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">Welcome Back</h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          Enter the email you used when you first raced at FastTrax.
        </p>
      </div>

      {/* Phase: email input */}
      {(phase === "email" || phase === "looking" || phase === "not-found") && (
        <div className="max-w-sm mx-auto space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            placeholder="racer@email.com"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 focus:border-[#00E2E5] focus:ring-1 focus:ring-[#00E2E5]/30 outline-none transition-colors"
            autoFocus
          />
          <button
            onClick={handleLookup}
            disabled={phase === "looking" || !email.includes("@")}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40"
          >
            {phase === "looking" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                Looking up...
              </span>
            ) : "Look Up My Account"}
          </button>
          {phase === "not-found" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 text-center">
              <p className="text-amber-400 text-sm font-semibold mb-1">No account found</p>
              <p className="text-white/40 text-xs mb-3">We couldn&apos;t find a FastTrax account with that email.</p>
              <button onClick={onSwitchToNew} className="text-[#00E2E5] text-xs font-semibold hover:underline">
                Continue as a New Racer instead
              </button>
            </div>
          )}
        </div>
      )}

      {/* Phase: sending code */}
      {phase === "sending" && (
        <div className="max-w-sm mx-auto text-center space-y-3">
          <div className="rounded-xl border border-[#8652FF]/30 bg-[#8652FF]/8 p-4">
            <p className="text-[#8652FF] font-semibold text-sm">Account found</p>
          </div>
          <div className="flex items-center justify-center gap-2 py-3">
            <span className="w-4 h-4 border-2 border-[#8652FF]/30 border-t-[#8652FF] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">Sending verification code...</p>
          </div>
        </div>
      )}

      {/* Phase: enter code */}
      {phase === "code" && (
        <div className="max-w-sm mx-auto space-y-4">
          <div className="rounded-xl border border-[#8652FF]/30 bg-[#8652FF]/8 p-4 text-center">
            <p className="text-[#8652FF] font-semibold text-sm">Account found</p>
            <p className="text-white/40 text-xs mt-1">Verification code sent — check your email</p>
          </div>
          <input
            ref={codeRef}
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setCodeError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleVerify()}
            placeholder="Enter verification code"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-lg tracking-widest placeholder:text-white/30 placeholder:text-sm placeholder:tracking-normal focus:border-[#8652FF] focus:ring-1 focus:ring-[#8652FF]/30 outline-none transition-colors"
          />
          {codeError && <p className="text-red-400 text-xs text-center">{codeError}</p>}
          <button
            onClick={handleVerify}
            disabled={!code.trim()}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#8652FF] text-white hover:bg-[#9b6fff] transition-colors disabled:opacity-40"
          >
            Verify
          </button>
          <div className="flex justify-between">
            <button onClick={handleResend} className="text-white/30 text-xs hover:text-white/50 transition-colors">
              Resend code
            </button>
            <button onClick={() => { setPhase("email"); setEmail(""); setCode(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors">
              Different email
            </button>
          </div>
        </div>
      )}

      {/* Phase: verified — show person info */}
      {phase === "verified" && person && (
        <div className="max-w-sm mx-auto space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-500/15 border border-green-500/40 flex items-center justify-center mx-auto text-xl">✓</div>
          <div className="rounded-xl border border-[#8652FF]/30 bg-[#8652FF]/8 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-white font-bold text-lg">{person.fullName}</p>
                <p className="text-white/50 text-xs">{person.email}</p>
              </div>
              <div className="text-right">
                <p className="text-[#8652FF] font-bold text-2xl">{person.races}</p>
                <p className="text-white/40 text-[10px] uppercase tracking-wider">Races</p>
              </div>
            </div>
            {person.maxExpiry && (
              <div className="mt-3">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isLicenseActive ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  License {isLicenseActive ? "Active" : "Expired"}
                </span>
              </div>
            )}
          </div>
          <p className="text-white/40 text-xs text-center">Setting up your booking...</p>
        </div>
      )}
    </div>
  );
}
