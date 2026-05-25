"use client";

import { useEffect, useRef, useState } from "react";
import { isRelevantMembership } from "~/features/booking/service/race-products";

export interface PersonData {
  personId: string;
  fullName: string;
  email: string;
  phone?: string;
  races: number;
  loginCode: string;
  memberships: string[];
  birthDate?: string | null;
  creditBalances?: Array<{ kind: string; balance: number }>;
  waiverValid?: boolean;
}

interface FoundAccount {
  personId: string;
  fullName: string;
  email: string;
  loginCode: string;
  lastSeen: string;
  races: number;
  memberships: string[];
  birthDate: string | null;
  creditBalances: Array<{ kind: string; balance: number }>;
}

interface Props {
  onVerified: (person: PersonData) => void;
  onSwitchToNew: () => void;
  autoCode?: string | null;
}

type Mode = "choose" | "phone" | "email" | "code";
type Phase =
  | "input"
  | "looking"
  | "not-found"
  | "sms-sent"
  | "phone-verified"
  | "verifying"
  | "verified";

function scoreSearchResult(desc: string): number {
  let s = 0;
  if (/\(\d/.test(desc)) s += 100;
  if (desc.includes("Memberships:")) s += 50;
  if (desc.includes("zip:")) s += 25;
  if (desc.includes("Last seen:")) s += 10;
  return s;
}

async function searchAndFetchAccounts(query: string): Promise<FoundAccount[]> {
  const searchRes = await fetch(
    `/api/bmi-office?action=search&q=${encodeURIComponent(query)}&max=500`,
  );
  if (!searchRes.ok) return [];
  const results = (await searchRes.json()) as Array<{
    localId: string;
    description: string;
  }>;

  const byName = new Map<string, { localId: string; description: string; score: number }>();
  for (const r of results) {
    const nameMatch = r.description.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
    const name = nameMatch ? nameMatch[1].trim() : r.description.split(" phone:")[0].trim();
    const score = scoreSearchResult(r.description);
    const existing = byName.get(name);
    if (!existing || score > existing.score) {
      byName.set(name, { localId: r.localId, description: r.description, score });
    }
  }

  const unique = [...byName.values()].slice(0, 10);
  const details = await Promise.all(
    unique.map(async (r) => {
      try {
        const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}`);
        if (!res.ok) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (await res.json()) as any;
        const tags = (p.tags || []).sort((a: { lastSeen?: string }, b: { lastSeen?: string }) =>
          (b.lastSeen || "").localeCompare(a.lastSeen || ""),
        );
        const loginCode = tags[0]?.tag || "";
        if (!loginCode) return null;
        const memberships = (p.memberships || [])
          .filter(
            (m: { stops?: string; name: string }) =>
              (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name),
          )
          .map((m: { name: string }) => m.name)
          .filter((n: string, i: number, a: string[]) => a.indexOf(n) === i);

        let creditBalances: FoundAccount["creditBalances"] = [];
        try {
          const depRes = await fetch(`/api/bmi-office?action=deposits&personId=${p.id}`);
          if (depRes.ok) {
            const deposits = (await depRes.json()) as Array<{
              depositKind: string;
              balance: number;
            }>;
            creditBalances = deposits
              .filter(
                (d) =>
                  d.balance > 0 &&
                  (d.depositKind.toLowerCase().includes("credit") ||
                    d.depositKind.toLowerCase().includes("pass")),
              )
              .map((d) => ({ kind: d.depositKind, balance: d.balance }));
          }
        } catch {
          /* non-fatal */
        }

        return {
          personId: String(p.id),
          fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
          email: p.addresses?.[0]?.email || "",
          loginCode,
          lastSeen: p.lastLineUp
            ? new Date(p.lastLineUp).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "",
          races: (p.tags || []).length,
          memberships,
          birthDate: p.birthDate || null,
          creditBalances,
        } satisfies FoundAccount;
      } catch {
        return null;
      }
    }),
  );

  const valid = details.filter((d): d is FoundAccount => d !== null);
  valid.sort((a, b) => {
    if (a.memberships.length > 0 && b.memberships.length === 0) return -1;
    if (a.memberships.length === 0 && b.memberships.length > 0) return 1;
    return (b.lastSeen || "").localeCompare(a.lastSeen || "");
  });
  return valid.slice(0, 5);
}

export function ReturningRacerLookup({ onVerified, onSwitchToNew, autoCode }: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [phase, setPhase] = useState<Phase>("input");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsError, setSmsError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);

  const autoCodeUsed = useRef(false);

  useEffect(() => {
    if (autoCode && !autoCodeUsed.current) {
      autoCodeUsed.current = true;
      setCode(autoCode);
      setMode("code");
      setTimeout(() => handleCodeVerify(autoCode), 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCode]);

  function formatPhoneInput(value: string): string {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function selectAccount(a: FoundAccount) {
    const person: PersonData = {
      personId: a.personId,
      fullName: a.fullName,
      email: a.email || (mode === "email" ? email.trim().toLowerCase() : ""),
      phone: mode === "phone" ? phone.replace(/\D/g, "").replace(/^1/, "") : undefined,
      races: a.races,
      loginCode: a.loginCode,
      memberships: a.memberships,
      birthDate: a.birthDate,
      creditBalances: a.creditBalances,
    };
    setPhase("verified");
    setTimeout(() => onVerified(person), 400);
  }

  async function handlePhoneLookup() {
    const digits = phone.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;
    setPhase("looking");
    setSmsError("");
    try {
      const found = await searchAndFetchAccounts(digits);
      if (found.length === 0) {
        setPhase("not-found");
        return;
      }
      setAccounts(found);
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

  async function handleEmailLookup() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;
    setPhase("looking");
    setSmsError("");
    try {
      const found = await searchAndFetchAccounts(trimmed);
      if (found.length === 0) {
        setPhase("not-found");
        return;
      }
      setAccounts(found);
      const otpRes = await fetch("/api/sms-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const otpData = await otpRes.json();
      if (!otpData.sent) {
        setSmsError(otpData.error || "Failed to send code");
        setPhase("input");
        return;
      }
      setPhase("sms-sent");
    } catch {
      setPhase("not-found");
    }
  }

  async function handleSmsVerify() {
    const trimmed = smsCode.trim();
    if (!trimmed || trimmed.length !== 6) {
      setSmsError("Enter the 6-digit code");
      return;
    }
    setSmsError("");
    const verifyBody =
      mode === "phone"
        ? { phone: phone.replace(/\D/g, "").replace(/^1/, ""), code: trimmed }
        : { email: email.trim().toLowerCase(), code: trimmed };
    try {
      const res = await fetch("/api/sms-verify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verifyBody),
      });
      const data = await res.json();
      if (data.verified) {
        setPhase("phone-verified");
      } else {
        setSmsError(data.error || "Incorrect code");
      }
    } catch {
      setSmsError("Verification failed. Please try again.");
    }
  }

  async function handleCodeVerify(overrideCode?: string) {
    const trimmed = (overrideCode || code).trim().toLowerCase();
    if (!trimmed) return;
    setCodeError("");
    setPhase("verifying");
    const match = accounts.find((a) => a.loginCode.toLowerCase() === trimmed);
    if (match) {
      selectAccount(match);
      return;
    }
    try {
      const searchRes = await fetch(
        `/api/bmi-office?action=search&q=${encodeURIComponent(trimmed)}`,
      );
      const results = (await searchRes.json()) as Array<{ localId: string; description: string }>;
      if (Array.isArray(results) && results.length > 0) {
        const detailRes = await fetch(`/api/bmi-office?action=person&id=${results[0].localId}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = (await detailRes.json()) as any;
        const tags = (p.tags || []).sort((a: { lastSeen?: string }, b: { lastSeen?: string }) =>
          (b.lastSeen || "").localeCompare(a.lastSeen || ""),
        );
        const matchTag = tags.find((t: { tag: string }) => t.tag.toLowerCase() === trimmed);
        if (matchTag) {
          const memberships = (p.memberships || [])
            .filter(
              (m: { stops?: string; name: string }) =>
                (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(m.name),
            )
            .map((m: { name: string }) => m.name)
            .filter((n: string, i: number, a: string[]) => a.indexOf(n) === i);
          const person: PersonData = {
            personId: String(p.id),
            fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
            email: p.addresses?.[0]?.email || "",
            races: (p.tags || []).length,
            loginCode: matchTag.tag,
            memberships,
            birthDate: p.birthDate || null,
          };
          setPhase("verified");
          setTimeout(() => onVerified(person), 400);
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

  // ── Choose mode ─────────────────────────────────────────────

  if (mode === "choose") {
    return (
      <div className="mx-auto max-w-sm space-y-3">
        <p className="text-center text-sm text-white/60">
          Find your account to unlock your earned speeds
        </p>
        <button type="button" onClick={() => setMode("phone")} className={btnClass}>
          Look Up by Phone
        </button>
        <button type="button" onClick={() => setMode("email")} className={btnClass}>
          Look Up by Email
        </button>
        <button type="button" onClick={() => setMode("code")} className={btnClass}>
          I Have My Login Code
        </button>
        <button
          type="button"
          onClick={onSwitchToNew}
          className="w-full py-2 text-center text-xs text-white/40 transition-colors hover:text-white/60"
        >
          Actually, I&apos;m a new racer →
        </button>
      </div>
    );
  }

  // ── Loading / looking ─────────────────────────────────────

  if (phase === "looking" || phase === "verifying") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
        <p className="text-sm text-white/50">{phase === "looking" ? "Searching…" : "Verifying…"}</p>
      </div>
    );
  }

  // ── Not found ─────────────────────────────────────────────

  if (phase === "not-found") {
    return (
      <div className="mx-auto max-w-sm space-y-4 text-center">
        <p className="text-sm text-amber-300">
          No account found. You may be a new racer, or try a different lookup method.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              setMode("choose");
              setPhase("input");
            }}
            className="flex-1 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/60 transition-colors hover:text-white"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onSwitchToNew}
            className="flex-1 rounded-lg bg-[#00E2E5]/10 px-4 py-2 text-sm font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/20"
          >
            Continue as new racer
          </button>
        </div>
      </div>
    );
  }

  // ── Verified → show account selection ─────────────────────

  if (phase === "phone-verified") {
    return (
      <div className="mx-auto max-w-sm space-y-3">
        <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-3 text-center">
          <p className="text-sm font-semibold text-green-400">Verified!</p>
          <p className="mt-1 text-xs text-white/40">Select your account below</p>
        </div>
        {accounts.map((a) => (
          <button
            key={a.personId}
            type="button"
            onClick={() => selectAccount(a)}
            className="w-full rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-all hover:border-white/25 hover:bg-white/10"
          >
            <p className="font-semibold text-white">{a.fullName}</p>
            <p className="mt-0.5 text-xs text-white/40">
              {a.races} race{a.races !== 1 ? "s" : ""}
              {a.memberships.length > 0 && ` · ${a.memberships.join(", ")}`}
              {a.lastSeen && ` · Last seen ${a.lastSeen}`}
            </p>
            {a.creditBalances.length > 0 && (
              <p className="mt-1 text-xs text-green-400">
                {a.creditBalances.map((c) => `${c.balance} ${c.kind}`).join(", ")}
              </p>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setMode("choose");
            setPhase("input");
          }}
          className="w-full py-2 text-center text-xs text-white/30 hover:text-white/50"
        >
          ← Start over
        </button>
      </div>
    );
  }

  if (phase === "verified") {
    return (
      <div className="flex min-h-32 items-center justify-center">
        <div className="rounded-xl border border-green-500/30 bg-green-500/8 px-6 py-4 text-center">
          <p className="text-sm font-semibold text-green-400">Account verified!</p>
        </div>
      </div>
    );
  }

  // ── OTP code input ────────────────────────────────────────

  if (phase === "sms-sent") {
    return (
      <form
        className="mx-auto max-w-sm space-y-4 text-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (smsCode.length === 6) handleSmsVerify();
        }}
      >
        <p className="text-sm text-white/60">
          We sent a 6-digit code to your {mode === "phone" ? "phone" : "email"}
        </p>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={smsCode}
          onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="000000"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="mx-auto block w-40 rounded-lg border border-white/20 bg-white/5 px-4 py-3 text-center font-mono text-xl tracking-[0.5em] text-white placeholder-white/20 outline-none focus:border-[#00E2E5]/50"
        />
        {smsError && <p className="text-xs text-red-400">{smsError}</p>}
        <button
          type="submit"
          disabled={smsCode.length !== 6}
          className="rounded-xl bg-[#00E2E5] px-6 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
        >
          Verify Code
        </button>
        <div className="flex justify-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => (mode === "phone" ? handlePhoneLookup() : handleEmailLookup())}
            className="text-white/40 hover:text-white/60"
          >
            Resend code
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("choose");
              setPhase("input");
              setSmsCode("");
              setSmsError("");
            }}
            className="text-white/40 hover:text-white/60"
          >
            Start over
          </button>
        </div>
      </form>
    );
  }

  // ── Input forms ───────────────────────────────────────────

  return (
    <div className="mx-auto max-w-sm space-y-4">
      {mode === "phone" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (phone.replace(/\D/g, "").length >= 10) handlePhoneLookup();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-white/50">Phone number</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
              placeholder="(555) 555-1234"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-[#00E2E5]/50"
            />
          </label>
          {smsError && <p className="text-xs text-red-400">{smsError}</p>}
          <button
            type="submit"
            disabled={phone.replace(/\D/g, "").length < 10}
            className="w-full rounded-xl bg-[#00E2E5] py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
          >
            Look Up
          </button>
        </form>
      )}

      {mode === "email" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.includes("@")) handleEmailLookup();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-white/50">Email address</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-[#00E2E5]/50"
            />
          </label>
          {smsError && <p className="text-xs text-red-400">{smsError}</p>}
          <button
            type="submit"
            disabled={!email.includes("@")}
            className="w-full rounded-xl bg-[#00E2E5] py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
          >
            Look Up
          </button>
        </form>
      )}

      {mode === "code" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) handleCodeVerify();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-white/50">Login code</span>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Your code from email"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-[#00E2E5]/50"
            />
          </label>
          {codeError && <p className="text-xs text-red-400">{codeError}</p>}
          <button
            type="submit"
            disabled={!code.trim()}
            className="w-full rounded-xl bg-[#00E2E5] py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
          >
            Verify
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={() => {
          setMode("choose");
          setPhase("input");
          setSmsError("");
          setCodeError("");
        }}
        className="w-full py-2 text-center text-xs text-white/30 hover:text-white/50"
      >
        ← Back to lookup options
      </button>
    </div>
  );
}

const btnClass =
  "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/80 transition-all hover:border-white/25 hover:bg-white/10";
