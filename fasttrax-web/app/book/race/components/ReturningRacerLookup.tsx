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
  memberships: string[];
  category?: "adult" | "junior";
  hasCredits?: boolean;
  creditBalances?: { kind: string; balance: number }[];
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
  const [mode, setMode] = useState<"choose" | "email" | "code" | "phone">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [phase, setPhase] = useState<"input" | "looking" | "not-found" | "sending" | "sent" | "sms-sent" | "phone-verified" | "verifying" | "verified">("input");
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);
  const [verifiedPerson, setVerifiedPerson] = useState<PersonData | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsError, setSmsError] = useState("");

  async function handleEmailLookup() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;

    setPhase("looking");
    try {
      // Search via Office API — get up to 200 results to find accounts with memberships
      const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(trimmed)}&max=200`);
      const results = await searchRes.json();

      if (!Array.isArray(results) || results.length === 0) {
        setPhase("not-found");
        return;
      }

      // Filter to only accounts with "Memberships:" in their description (real racers)
      // Then deduplicate by name
      const withMemberships = (results as { localId: string; description: string }[])
        .filter(r => r.description.includes("Memberships:"));

      const byName = new Map<string, { localId: string; description: string }>();
      for (const r of withMemberships) {
        const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
        const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
        if (!byName.has(name)) {
          byName.set(name, r);
        }
      }

      // If no accounts with memberships, also check accounts without (but dedup by name, max 5)
      if (byName.size === 0) {
        for (const r of results as { localId: string; description: string }[]) {
          const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
          const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
          if (!byName.has(name)) {
            byName.set(name, r);
            if (byName.size >= 5) break;
          }
        }
      }

      const uniqueEntries = [...byName.values()].slice(0, 10);
      const RELEVANT_MEMBERSHIPS = ["license fee", "qualified intermediate", "qualified pro", "turbo pass", "employee pass", "race credit"];

      const detailPromises = uniqueEntries.map(async (r) => {
        try {
          const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
          const p = await res.json();
          // Get the most recent tag as login code
          const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
            (b.lastSeen || "").localeCompare(a.lastSeen || "")
          );
          const loginCode = tags[0]?.tag || "";
          const memberships = (p.memberships || [])
            .filter((m: { stops: string; name: string }) =>
              (!m.stops || new Date(m.stops) > new Date()) &&
              RELEVANT_MEMBERSHIPS.some(rel => m.name.toLowerCase().includes(rel))
            )
            .map((m: { name: string }) => m.name)
            .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);
          const lastSeen = p.lastLineUp
            ? new Date(p.lastLineUp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : "";

          return {
            personId: String(p.id),
            fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
            loginCode,
            lastSeen,
            races: (p.tags || []).length,
            memberships,
          } as FoundAccount;
        } catch {
          return null;
        }
      });

      const allDetails = (await Promise.all(detailPromises)).filter((d): d is FoundAccount => d !== null && !!d.loginCode);

      // Sort: memberships first, then by latest activity
      allDetails.sort((a, b) => {
        if (a.memberships.length > 0 && b.memberships.length === 0) return -1;
        if (a.memberships.length === 0 && b.memberships.length > 0) return 1;
        return (b.lastSeen || "").localeCompare(a.lastSeen || "");
      });
      const unique = allDetails.filter(d => d.memberships.length > 0);

      if (unique.length === 0) {
        // No accounts with memberships — fall back to BMI Public API single lookup
        try {
          const pubResult = await bmiGet("person", { email: trimmed });
          if (pubResult.person && pubResult.person.races > 0) {
            const p = pubResult.person;
            setAccounts([{
              personId: p.personId,
              fullName: p.fullName,
              loginCode: pubResult.loginCode,
              lastSeen: "",
              races: p.races,
              memberships: [],
            }]);
            setPhase("sending");
            await fetch("/api/email/login-code", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                email: trimmed,
                accounts: [{
                  personId: p.personId,
                  fullName: p.fullName,
                  loginCode: pubResult.loginCode,
                  lastSeen: "",
                  races: p.races,
                  memberships: [],
                }],
              }),
            });
            setPhase("sent");
            setMode("code");
            setTimeout(() => codeRef.current?.focus(), 200);
            return;
          }
        } catch { /* fall through */ }
        setPhase("not-found");
        return;
      }

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
        memberships: match.memberships,
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
            memberships: (p.memberships || [])
              .filter((m: { stops: string; name: string }) =>
                (!m.stops || new Date(m.stops) > new Date()) &&
                ["license fee", "qualified intermediate", "qualified pro", "turbo pass", "employee pass", "race credit"]
                  .some(r => m.name.toLowerCase().includes(r))
              )
              .map((m: { name: string }) => m.name)
              .filter((n: string, i: number, a: string[]) => a.indexOf(n) === i),
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

  /** Phone lookup: search by phone, send SMS code, verify, show accounts */
  async function handlePhoneLookup() {
    const digits = phone.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;

    setPhase("looking");
    setSmsError("");
    try {
      // Search Office API by phone
      const searchRes = await fetch(`/api/bmi-office?action=search&q=${encodeURIComponent(digits)}&max=200`);
      const results = await searchRes.json();

      if (!Array.isArray(results) || results.length === 0) {
        setPhase("not-found");
        return;
      }

      // Filter and dedupe (same logic as email lookup)
      const withMemberships = (results as { localId: string; description: string }[])
        .filter(r => r.description.includes("Memberships:"));
      const byName = new Map<string, { localId: string; description: string }>();
      for (const r of (withMemberships.length > 0 ? withMemberships : results) as { localId: string; description: string }[]) {
        const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
        const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
        if (!byName.has(name)) byName.set(name, r);
      }
      const uniqueEntries = [...byName.values()].slice(0, 10);

      // Fetch person details for each
      const RELEVANT_MEMBERSHIPS = ["license fee", "qualified intermediate", "qualified pro", "turbo pass", "employee pass", "race credit"];
      const detailPromises = uniqueEntries.map(async (r) => {
        try {
          const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
          const p = await res.json();
          const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
            (b.lastSeen || "").localeCompare(a.lastSeen || "")
          );
          const loginCode = tags[0]?.tag || "";
          const memberships = (p.memberships || [])
            .filter((m: { stops: string; name: string }) =>
              (!m.stops || new Date(m.stops) > new Date()) &&
              RELEVANT_MEMBERSHIPS.some(rel => m.name.toLowerCase().includes(rel))
            )
            .map((m: { name: string }) => m.name)
            .filter((name: string, i: number, arr: string[]) => arr.indexOf(name) === i);
          const lastSeen = p.lastLineUp
            ? new Date(p.lastLineUp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : "";
          return { personId: String(p.id), fullName: `${p.firstName || ""} ${p.name || ""}`.trim(), loginCode, lastSeen, races: (p.tags || []).length, memberships } as FoundAccount;
        } catch { return null; }
      });
      const allDetails = (await Promise.all(detailPromises)).filter((d): d is FoundAccount => d !== null && !!d.loginCode);
      // Sort: latest activity first, then those with memberships first
      allDetails.sort((a, b) => {
        // Memberships first
        if (a.memberships.length > 0 && b.memberships.length === 0) return -1;
        if (a.memberships.length === 0 && b.memberships.length > 0) return 1;
        // Then by last seen (most recent first)
        return (b.lastSeen || "").localeCompare(a.lastSeen || "");
      });
      const foundAccounts = allDetails.slice(0, 5);

      if (foundAccounts.length === 0) {
        setPhase("not-found");
        return;
      }

      setAccounts(foundAccounts);

      // Send SMS verification code
      const smsRes = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const smsData = await smsRes.json();
      if (!smsData.sent) {
        setSmsError(smsData.error || "Failed to send code");
        setPhase("input");
        return;
      }

      setPhase("sms-sent");
    } catch {
      setSmsError("Lookup failed. Please try again.");
      setPhase("input");
    }
  }

  async function handleSmsVerify() {
    const trimmed = smsCode.trim();
    if (!trimmed || trimmed.length !== 6) { setSmsError("Enter the 6-digit code"); return; }

    setSmsError("");
    setPhase("verifying");
    const digits = phone.replace(/\D/g, "").replace(/^1/, "");

    try {
      const res = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: digits, code: trimmed }),
      });
      const data = await res.json();

      if (data.verified) {
        // Show account selection directly
        setPhase("phone-verified");
      } else {
        setSmsError(data.error || "Incorrect code");
        setPhase("sms-sent");
      }
    } catch {
      setSmsError("Verification failed. Please try again.");
      setPhase("sms-sent");
    }
  }

  function formatPhoneInput(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
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

      {/* Choose: phone, email, or code */}
      {mode === "choose" && (
        <div className="max-w-sm mx-auto space-y-3">
          <button
            onClick={() => { setMode("phone"); setPhase("input"); setPhone(""); setSmsCode(""); setSmsError(""); }}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors"
          >
            Look Up by Phone
          </button>
          <button
            onClick={() => { setMode("email"); setPhase("input"); }}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors border border-white/10"
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

      {/* Phone lookup */}
      {mode === "phone" && (phase === "input" || phase === "looking" || phase === "not-found") && (
        <div className="max-w-sm mx-auto space-y-3">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && handlePhoneLookup()}
            placeholder="(239) 555-1234"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-lg tracking-wider placeholder:text-white/30 placeholder:text-base placeholder:tracking-normal focus:border-[#00E2E5] focus:ring-1 focus:ring-[#00E2E5]/30 outline-none transition-colors"
            autoFocus
          />
          {smsError && <p className="text-red-400 text-xs text-center">{smsError}</p>}
          <button
            onClick={handlePhoneLookup}
            disabled={phase === "looking" || phone.replace(/\D/g, "").length !== 10}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40"
          >
            {phase === "looking" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#000418]/30 border-t-[#000418] rounded-full animate-spin" />
                Looking up accounts...
              </span>
            ) : "Send Verification Code"}
          </button>
          {phase === "not-found" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4 text-center">
              <p className="text-amber-400 text-sm font-semibold mb-1">No account found</p>
              <p className="text-white/40 text-xs mb-3">We couldn&apos;t find a FastTrax account with that phone number.</p>
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

      {/* SMS code verification */}
      {mode === "phone" && phase === "sms-sent" && (
        <div className="max-w-sm mx-auto space-y-4">
          <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-4 text-center">
            <p className="text-green-400 font-semibold text-sm">Code Sent!</p>
            <p className="text-white/40 text-xs mt-1">
              We texted a 6-digit code to {phone}
            </p>
          </div>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={smsCode}
            onChange={(e) => { setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setSmsError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleSmsVerify()}
            placeholder="000000"
            className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-center text-2xl tracking-[0.5em] font-mono placeholder:text-white/20 focus:border-[#00E2E5] focus:ring-1 focus:ring-[#00E2E5]/30 outline-none transition-colors"
            autoFocus
          />
          {smsError && <p className="text-red-400 text-xs text-center">{smsError}</p>}
          <button
            onClick={handleSmsVerify}
            disabled={smsCode.length !== 6}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors disabled:opacity-40"
          >
            Verify Code
          </button>
          <div className="flex justify-between">
            <button onClick={handlePhoneLookup} className="text-white/30 text-xs hover:text-white/50 transition-colors">
              Resend code
            </button>
            <button onClick={() => { setMode("choose"); setPhase("input"); setSmsCode(""); setSmsError(""); }} className="text-white/30 text-xs hover:text-white/50 transition-colors">
              ← Start over
            </button>
          </div>
        </div>
      )}

      {/* Phone verified — show accounts to select */}
      {mode === "phone" && phase === "phone-verified" && (
        <div className="max-w-sm mx-auto space-y-3">
          <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-3 text-center">
            <p className="text-green-400 font-semibold text-sm">Phone Verified!</p>
            <p className="text-white/40 text-xs mt-1">Select your account below</p>
          </div>
          {accounts.map(a => (
            <button
              key={a.personId}
              onClick={() => {
                const person: PersonData = {
                  personId: a.personId,
                  fullName: a.fullName,
                  email: "",
                  races: a.races,
                  maxExpiry: null,
                  tag: a.loginCode,
                  loginCode: a.loginCode,
                  personReference: "",
                  memberships: a.memberships,
                };
                setVerifiedPerson(person);
                setPhase("verified");
                setTimeout(() => onVerified(person), 600);
              }}
              className="w-full rounded-xl border border-white/10 bg-white/5 hover:border-[#00E2E5]/50 hover:bg-[#00E2E5]/5 p-4 text-left transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-semibold text-sm">{a.fullName}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {a.memberships.slice(0, 3).map((m, i) => (
                      <span key={i} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-white/10 text-white/50">{m}</span>
                    ))}
                  </div>
                  {a.lastSeen && <p className="text-white/30 text-[10px] mt-1">Last seen: {a.lastSeen}</p>}
                </div>
                <div className="text-right">
                  <p className="text-[#8652FF] font-bold text-lg">{a.races}</p>
                  <p className="text-white/30 text-[9px] uppercase">visits</p>
                </div>
              </div>
            </button>
          ))}
          <button onClick={() => { setMode("choose"); setPhase("input"); }} className="w-full text-white/30 text-xs hover:text-white/50 transition-colors py-1">
            ← Start over
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
