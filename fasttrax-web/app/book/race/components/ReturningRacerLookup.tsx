"use client";

import { useState, useRef } from "react";

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

interface FoundAccount {
  personId: string;
  fullName: string;
  loginCode: string;
  lastSeen: string;
  races: number;
  memberships: string[];
}

interface Props {
  onVerified: (person: PersonData) => void;
  onSwitchToNew: () => void;
}

export default function ReturningRacerLookup({ onVerified, onSwitchToNew }: Props) {
  const [mode, setMode] = useState<"choose" | "email" | "code">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [phase, setPhase] = useState<"input" | "looking" | "not-found" | "sending" | "sent" | "verifying" | "verified">("input");
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);
  const [verifiedPerson, setVerifiedPerson] = useState<PersonData | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function handleEmailLookup() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;

    setPhase("looking");
    try {
      // Search via Office API for all people with this email
      const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(trimmed)}`);
      const results = await searchRes.json();

      if (!Array.isArray(results) || results.length === 0) {
        setPhase("not-found");
        return;
      }

      // Fetch details for each person (up to 10 to be reasonable)
      const detailPromises = results.slice(0, 10).map(async (r: { localId: string }) => {
        try {
          const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
          const p = await res.json();
          // Get the most recent tag as login code
          const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
            (b.lastSeen || "").localeCompare(a.lastSeen || "")
          );
          const loginCode = tags[0]?.tag || "";
          // Get membership names
          const memberships = (p.memberships || [])
            .filter((m: { stops: string }) => !m.stops || new Date(m.stops) > new Date())
            .map((m: { name: string }) => m.name);
          // Parse last seen from description or lastLineUp
          const lastSeen = p.lastLineUp
            ? new Date(p.lastLineUp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : "";

          return {
            personId: String(p.id),
            fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
            loginCode,
            lastSeen,
            races: tags.length, // approximate from tag count
            memberships,
          } as FoundAccount;
        } catch {
          return null;
        }
      });

      const details = (await Promise.all(detailPromises)).filter((d): d is FoundAccount => d !== null && !!d.loginCode);

      if (details.length === 0) {
        setPhase("not-found");
        return;
      }

      // Deduplicate by personId
      const seen = new Set<string>();
      const unique = details.filter(d => {
        if (seen.has(d.personId)) return false;
        seen.add(d.personId);
        return true;
      });

      setAccounts(unique);

      // Send email with all accounts
      setPhase("sending");
      await fetch("/api/email/login-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, accounts: unique }),
      });
      setPhase("sent");
      setMode("code");
      setTimeout(() => codeRef.current?.focus(), 200);
    } catch {
      setPhase("not-found");
    }
  }

  async function handleCodeVerify() {
    const trimmed = code.trim().toLowerCase();
    if (!trimmed) return;

    setCodeError("");
    setPhase("verifying");

    // Check against known accounts first (if we did email lookup)
    const match = accounts.find(a => a.loginCode.toLowerCase() === trimmed);
    if (match) {
      // We already have the person data
      const person: PersonData = {
        personId: match.personId,
        fullName: match.fullName,
        email: email || "",
        races: match.races,
        maxExpiry: null,
        tag: match.loginCode,
        loginCode: match.loginCode,
        personReference: "",
      };
      setVerifiedPerson(person);
      setPhase("verified");
      setTimeout(() => onVerified(person), 600);
      return;
    }

    // If no email lookup was done (direct code entry), try BMI Public API person lookup
    // The login code IS the tag, so we can't directly search by it on the public API
    // Instead, we need to search the office API by tag
    try {
      const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(trimmed)}`);
      const results = await searchRes.json();

      if (Array.isArray(results) && results.length > 0) {
        const r = results[0];
        const detailRes = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
        const p = await detailRes.json();
        const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
          (b.lastSeen || "").localeCompare(a.lastSeen || "")
        );
        const matchTag = tags.find((t: { tag: string }) => t.tag.toLowerCase() === trimmed);

        if (matchTag) {
          const person: PersonData = {
            personId: String(p.id),
            fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
            email: (p.addresses?.[0]?.email) || "",
            races: tags.length,
            maxExpiry: null,
            tag: matchTag.tag,
            loginCode: matchTag.tag,
            personReference: "",
          };
          setVerifiedPerson(person);
          setPhase("verified");
          setTimeout(() => onVerified(person), 600);
          return;
        }
      }

      setCodeError("Code not recognized. Check your email and try again.");
      setPhase("input");
    } catch {
      setCodeError("Verification failed. Please try again.");
      setPhase("input");
    }
  }

  const isLicenseActive = verifiedPerson?.maxExpiry ? new Date(verifiedPerson.maxExpiry) > new Date() : false;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">Welcome Back</h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          Look up your account to access returning racer benefits.
        </p>
      </div>

      {/* Choose: email or code */}
      {mode === "choose" && (
        <div className="max-w-sm mx-auto space-y-3">
          <button
            onClick={() => { setMode("email"); setPhase("input"); }}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors"
          >
            Look Up by Email
          </button>
          <button
            onClick={() => { setMode("code"); setPhase("input"); }}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors border border-white/10"
          >
            I Have My Login Code
          </button>
          <button onClick={onSwitchToNew} className="w-full text-white/30 text-xs hover:text-white/50 transition-colors py-2">
            Actually, I&apos;m a new racer
          </button>
        </div>
      )}

      {/* Email lookup */}
      {mode === "email" && (phase === "input" || phase === "looking" || phase === "not-found") && (
        <div className="max-w-sm mx-auto space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleEmailLookup()}
            placeholder="racer@email.com"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder:text-white/30 focus:border-[#00E2E5] focus:ring-1 focus:ring-[#00E2E5]/30 outline-none transition-colors"
            autoFocus
          />
          <button
            onClick={handleEmailLookup}
            disabled={phase === "looking" || !email.includes("@")}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40"
          >
            {phase === "looking" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                Looking up accounts...
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
          <button onClick={() => setMode("choose")} className="w-full text-white/30 text-xs hover:text-white/50 transition-colors py-1">
            ← Back
          </button>
        </div>
      )}

      {/* Sending email */}
      {phase === "sending" && (
        <div className="max-w-sm mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2 py-4">
            <span className="w-4 h-4 border-2 border-[#00E2E5]/30 border-t-[#00E2E5] rounded-full animate-spin" />
            <p className="text-white/50 text-sm">
              Found {accounts.length} account{accounts.length !== 1 ? "s" : ""}. Sending verification email...
            </p>
          </div>
        </div>
      )}

      {/* Enter code (after email lookup or direct) */}
      {mode === "code" && (phase === "input" || phase === "sent" || phase === "verifying") && (
        <div className="max-w-sm mx-auto space-y-4">
          {phase === "sent" && (
            <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-4 text-center">
              <p className="text-green-400 font-semibold text-sm">
                {accounts.length > 1 ? `Found ${accounts.length} accounts` : "Account found"}
              </p>
              <p className="text-white/40 text-xs mt-1">
                Check your email for {accounts.length > 1 ? "a list of accounts with codes" : "your verification code"}
              </p>
            </div>
          )}
          <input
            ref={codeRef}
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setCodeError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleCodeVerify()}
            placeholder="Enter your login code"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-lg tracking-widest placeholder:text-white/30 placeholder:text-sm placeholder:tracking-normal focus:border-[#8652FF] focus:ring-1 focus:ring-[#8652FF]/30 outline-none transition-colors"
            autoFocus={mode === "code" && phase === "input"}
          />
          {codeError && <p className="text-red-400 text-xs text-center">{codeError}</p>}
          <button
            onClick={handleCodeVerify}
            disabled={!code.trim() || phase === "verifying"}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#8652FF] text-white hover:bg-[#9b6fff] transition-colors disabled:opacity-40"
          >
            {phase === "verifying" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Verifying...
              </span>
            ) : "Verify"}
          </button>
          <div className="flex justify-between">
            {email && (
              <button onClick={handleEmailLookup} className="text-white/30 text-xs hover:text-white/50 transition-colors">
                Resend email
              </button>
            )}
            <button onClick={() => { setMode("choose"); setPhase("input"); setCode(""); setCodeError(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors ml-auto">
              ← Start over
            </button>
          </div>
        </div>
      )}

      {/* Verified */}
      {phase === "verified" && verifiedPerson && (
        <div className="max-w-sm mx-auto space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-500/15 border border-green-500/40 flex items-center justify-center mx-auto text-xl">✓</div>
          <div className="rounded-xl border border-[#8652FF]/30 bg-[#8652FF]/8 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-white font-bold text-lg">{verifiedPerson.fullName}</p>
                {verifiedPerson.email && <p className="text-white/50 text-xs">{verifiedPerson.email}</p>}
              </div>
              <div className="text-right">
                <p className="text-[#8652FF] font-bold text-2xl">{verifiedPerson.races}</p>
                <p className="text-white/40 text-[10px] uppercase tracking-wider">Visits</p>
              </div>
            </div>
            {verifiedPerson.maxExpiry && (
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
