"use client";

import { useEffect, useRef, useState } from "react";
import {
  isRelevantMembership,
  tierFromMemberships,
} from "~/features/booking/service/race-products";
import { creditBalancesFromDeposits } from "~/features/booking/data/race-credits";
import { rankSearchResults, type SearchCandidate } from "~/features/booking/service/office-search";

export interface PersonData {
  personId: string;
  fullName: string;
  email: string;
  phone?: string;
  /** True when `phone` was proven by the SMS OTP this lookup ran (phone mode
   *  only — email/login-code lookups never verify a phone). */
  phoneVerified?: boolean;
  races: number;
  loginCode: string;
  memberships: string[];
  birthDate?: string | null;
  creditBalances?: Array<{ kind: string; balance: number }>;
  waiverValid?: boolean;
}

export interface FoundAccount {
  personId: string;
  fullName: string;
  email: string;
  loginCode: string;
  lastSeen: string;
  /** Epoch ms of the last line-up — the sortable form of `lastSeen` (0 = never). */
  lastSeenAt: number;
  races: number;
  memberships: string[];
  birthDate: string | null;
  creditBalances: Array<{ kind: string; balance: number }>;
}

interface Props {
  onVerified: (person: PersonData) => void;
  /**
   * Optional multi-select. When provided AND the phone/email OTP matched more
   * than one account (a household sharing a number/email), the post-verify
   * screen becomes a checkbox picker and this fires ONCE with every chosen
   * account — the consumer adds them all. When only one account matches, the
   * screen stays single-tap and calls {@link onVerified}. The login-code path
   * always resolves a single account and never uses this.
   */
  onVerifiedMultiple?: (people: PersonData[]) => void;
  onSwitchToNew: () => void;
  /** Kiosk surfaces render inside a wide panel — set this to double the
   *  post-verify account list's width (max-w-sm → max-w-3xl) and lay the
   *  cards out two-across. Web / phone-join leave it off (mobile, single col). */
  wide?: boolean;
  autoCode?: string | null;
  /** Intro line on the method chooser. Defaults preserve the racing copy —
   *  the kiosk mobile-join page overrides it (attraction sessions must not
   *  say "racer"). */
  introText?: string;
  /** Label of the "actually I'm new" switch. Same defaulting rationale. */
  switchToNewLabel?: string;
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

// Description parsing + ranking now live in the shared pure module (the
// server-side kiosk license lookup shares them) — see office-search.ts.

/**
 * SECURITY (2026-07-18): the lookup is split so NO PII is fetched before the
 * OTP verifies. searchCandidates() only hits the (rate-limited) search
 * action; fetchAccountDetails() runs AFTER /api/sms-verify PUT succeeds and
 * carries the verified identifier (`verify=phone:…|email:…`) or the typed
 * login code (`code=…`) so the server-side gate on person/deposits admits it.
 *
 * Accepts multiple queries because phones are stored in mixed formats upstream:
 * a guest saved as "12397762044" or "+12397762044" only matches the 1-prefixed
 * search, never the bare 10 digits. Results are merged before ranking.
 *
 * Ranking (owner 2026-07-21): keep the TOP 10 candidates ordered by most
 * recent use first (Last seen), then the description completeness score —
 * so the account the guest actually uses surfaces instead of whichever
 * duplicate the API happened to list first.
 */
async function searchCandidates(queries: string | string[]): Promise<SearchCandidate[]> {
  const qs = Array.isArray(queries) ? queries : [queries];
  const batches = await Promise.all(
    qs.map(async (query) => {
      try {
        const searchRes = await fetch(
          `/api/bmi-office?action=search&q=${encodeURIComponent(query)}&max=500`,
        );
        if (!searchRes.ok) return [];
        return (await searchRes.json()) as Array<{ localId: string; description: string }>;
      } catch {
        return [];
      }
    }),
  );

  // Dedupe by id, then one candidate per person NAME (most recent copy wins,
  // ties on completeness) — shared rule, see office-search.ts.
  return rankSearchResults(batches.flat(), 10);
}

async function fetchAccountDetails(
  unique: SearchCandidate[],
  proof: { verify?: string; code?: string },
): Promise<FoundAccount[]> {
  const proofQs = proof.verify
    ? `&verify=${encodeURIComponent(proof.verify)}`
    : proof.code
      ? `&code=${encodeURIComponent(proof.code)}`
      : "";
  const details = await Promise.all(
    unique.map(async (r) => {
      try {
        const res = await fetch(`/api/bmi-office?action=person&id=${r.localId}${proofQs}`);
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
          const depRes = await fetch(`/api/bmi-office?action=deposits&personId=${p.id}${proofQs}`);
          if (depRes.ok) {
            creditBalances = creditBalancesFromDeposits(await depRes.json());
          }
        } catch {
          /* non-fatal */
        }

        // lastLineUp is often absent on the person record even when the search
        // description carried "Last seen:" — trust whichever is more recent.
        const fromLineUp = p.lastLineUp ? new Date(p.lastLineUp).getTime() : 0;
        const lastSeenAt = Math.max(Number.isFinite(fromLineUp) ? fromLineUp : 0, r.lastSeenAt);
        return {
          personId: String(p.id),
          fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
          email: p.addresses?.[0]?.email || "",
          loginCode,
          lastSeen:
            lastSeenAt > 0
              ? new Date(lastSeenAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "",
          lastSeenAt,
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

  // Owner ranking (2026-07-21): accounts that carry a relevant membership
  // (license / intermediate / pro / …) or a credit deposit form the TOP tier,
  // ordered by most recent visit; everything else sits below, also by most
  // recent visit — so the account the guest actually uses lands on top.
  const valid = details.filter((d): d is FoundAccount => d !== null);
  const topTier = (a: FoundAccount) =>
    a.memberships.length > 0 || a.creditBalances.some((c) => c.balance > 0) ? 1 : 0;
  valid.sort((a, b) => topTier(b) - topTier(a) || b.lastSeenAt - a.lastSeenAt);
  return valid.slice(0, 10);
}

export function ReturningRacerLookup({
  onVerified,
  onVerifiedMultiple,
  onSwitchToNew,
  wide = false,
  autoCode,
  introText = "Find your account to unlock your earned speeds",
  switchToNewLabel = "Actually, I'm a new racer →",
}: Props) {
  const [mode, setMode] = useState<Mode>("choose");
  const [phase, setPhase] = useState<Phase>("input");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsError, setSmsError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [accounts, setAccounts] = useState<FoundAccount[]>([]);
  // Multi-select: personIds ticked on the post-verify list (only used when the
  // consumer wired onVerifiedMultiple AND more than one account matched).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Search hits held between "code sent" and "code verified" — PII details
  // are only fetched once the OTP verifies (server enforces this too).
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);

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
    // Strip a US country code before truncating — browser autofill supplies "+1 (239) 555-1234"
    let digits = value.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function buildPerson(a: FoundAccount): PersonData {
    return {
      personId: a.personId,
      fullName: a.fullName,
      email: a.email || (mode === "email" ? email.trim().toLowerCase() : ""),
      phone: mode === "phone" ? phone.replace(/\D/g, "").replace(/^1/, "") : undefined,
      // Phone mode only reaches here AFTER handleSmsVerify succeeded, so the
      // phone above is OTP-proven (email mode proves the email, not a phone).
      // Every returned account shares the OTP'd phone/email, so the proof holds
      // for each of them in a multi-select add.
      phoneVerified: mode === "phone" || undefined,
      races: a.races,
      loginCode: a.loginCode,
      memberships: a.memberships,
      birthDate: a.birthDate,
      creditBalances: a.creditBalances,
    };
  }

  function selectAccount(a: FoundAccount) {
    const person = buildPerson(a);
    setPhase("verified");
    setTimeout(() => onVerified(person), 400);
  }

  // Commit the ticked accounts as ONE batch (multi-select path).
  function confirmMultiple() {
    const chosen = accounts.filter((a) => selectedIds.has(a.personId)).map(buildPerson);
    if (chosen.length === 0 || !onVerifiedMultiple) return;
    setPhase("verified");
    const emit = onVerifiedMultiple;
    setTimeout(() => emit(chosen), 400);
  }

  function toggleSelected(personId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  async function handlePhoneLookup() {
    const digits = phone.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) return;
    setPhase("looking");
    setSmsError("");
    try {
      // Phones are stored upstream in mixed formats — bare 10 digits, 11 with
      // a leading 1, or E.164 (+1…). The office search only matches the stored
      // string, so search both forms and let searchCandidates merge them.
      const found = await searchCandidates([digits, `1${digits}`]);
      if (found.length === 0) {
        setPhase("not-found");
        return;
      }
      setCandidates(found);
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
      const found = await searchCandidates(trimmed);
      if (found.length === 0) {
        setPhase("not-found");
        return;
      }
      setCandidates(found);
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
        // Verified — NOW fetch the account details (PII) with proof attached.
        setPhase("verifying");
        const proof =
          mode === "phone"
            ? { verify: `phone:${phone.replace(/\D/g, "").replace(/^1/, "")}` }
            : { verify: `email:${email.trim().toLowerCase()}` };
        const found = await fetchAccountDetails(candidates, proof);
        if (found.length === 0) {
          setSmsError("We couldn't load that account — please try again.");
          setPhase("sms-sent");
          return;
        }
        setAccounts(found);
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
        const detailRes = await fetch(
          `/api/bmi-office?action=person&id=${results[0].localId}&code=${encodeURIComponent(trimmed)}`,
        );
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
          // Fetch the racer's credit balances — the login-code path previously
          // skipped this (only the phone/email path fetched them), so anyone who
          // logged in with their code saw NO race credits at checkout.
          let creditBalances: PersonData["creditBalances"] = [];
          try {
            const depRes = await fetch(`/api/bmi-office?action=deposits&personId=${p.id}`);
            if (depRes.ok) creditBalances = creditBalancesFromDeposits(await depRes.json());
          } catch {
            /* non-fatal */
          }
          const person: PersonData = {
            personId: String(p.id),
            fullName: `${p.firstName || ""} ${p.name || ""}`.trim(),
            email: p.addresses?.[0]?.email || "",
            races: (p.tags || []).length,
            loginCode: matchTag.tag,
            memberships,
            birthDate: p.birthDate || null,
            creditBalances,
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
        <p className="text-center text-sm text-white/60">{introText}</p>
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
          {switchToNewLabel}
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
    // Multi-select only when the consumer opted in AND the OTP matched more
    // than one account (a household on one phone/email). A lone match stays a
    // single tap — no reason to make one person tick a box and confirm.
    const multiEnabled = !!onVerifiedMultiple && accounts.length > 1;
    // Kiosk = double-wide (max-w-3xl is exactly 2× max-w-sm) with cards two-across.
    const widthClass = wide ? "max-w-3xl" : "max-w-sm";
    const cardGrid = wide ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "space-y-3";
    const startOver = (
      <button
        type="button"
        onClick={() => {
          setMode("choose");
          setPhase("input");
          setSelectedIds(new Set());
        }}
        className="w-full py-2 text-center text-xs text-white/30 hover:text-white/50"
      >
        ← Start over
      </button>
    );

    if (multiEnabled) {
      const allSelected = selectedIds.size === accounts.length;
      const count = selectedIds.size;
      return (
        <div className={`mx-auto ${widthClass} space-y-3`}>
          <div className="flex items-center justify-between gap-2.5 rounded-xl border border-emerald-500/25 bg-gradient-to-r from-emerald-500/10 to-emerald-500/[0.03] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
                <CheckIcon className="h-4 w-4 text-emerald-400" />
              </span>
              <div className="text-left">
                <p className="text-sm font-semibold text-emerald-300">Verified</p>
                <p className="text-xs text-white/40">Tap everyone to add</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setSelectedIds(allSelected ? new Set() : new Set(accounts.map((a) => a.personId)))
              }
              className="shrink-0 text-xs font-semibold text-[#00E2E5]/80 transition-colors hover:text-[#00E2E5]"
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className={cardGrid}>
            {accounts.map((a) => (
              <AccountCard
                key={a.personId}
                account={a}
                selectable
                selected={selectedIds.has(a.personId)}
                onSelect={() => toggleSelected(a.personId)}
              />
            ))}
          </div>
          <button
            type="button"
            disabled={count === 0}
            onClick={confirmMultiple}
            className="w-full rounded-xl bg-[#00E2E5] py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
          >
            {count <= 1 ? "Add selected" : `Add ${count} people`}
          </button>
          {startOver}
        </div>
      );
    }

    return (
      <div className={`mx-auto ${widthClass} space-y-3`}>
        <div className="flex items-center justify-center gap-2.5 rounded-xl border border-emerald-500/25 bg-gradient-to-r from-emerald-500/10 to-emerald-500/[0.03] px-4 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
            <CheckIcon className="h-4 w-4 text-emerald-400" />
          </span>
          <div className="text-left">
            <p className="text-sm font-semibold text-emerald-300">Verified</p>
            <p className="text-xs text-white/40">Select your account below</p>
          </div>
        </div>
        <div className={cardGrid}>
          {accounts.map((a) => (
            <AccountCard key={a.personId} account={a} onSelect={() => selectAccount(a)} />
          ))}
        </div>
        {startOver}
      </div>
    );
  }

  if (phase === "verified") {
    return (
      <div className="flex min-h-32 items-center justify-center">
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-6 py-4">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20">
            <CheckIcon className="h-4 w-4 text-emerald-400" />
          </span>
          <p className="text-sm font-semibold text-emerald-300">Account verified!</p>
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
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          data-osk-layout="numeric"
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
              name="phone"
              autoComplete="tel"
              data-osk-layout="phone"
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

// ── Account card ────────────────────────────────────────────

const TIER_THEME: Record<
  "Pro" | "Intermediate" | "Starter",
  { grad: string; ring: string; badge: string }
> = {
  Pro: {
    grad: "from-[#E53935] to-[#ff7a6e]",
    ring: "ring-[#E53935]/40",
    badge: "bg-[#E53935]/15 text-[#E53935]",
  },
  Intermediate: {
    grad: "from-[#8652FF] to-[#b18cff]",
    ring: "ring-[#8652FF]/40",
    badge: "bg-[#8652FF]/15 text-[#8652FF]",
  },
  Starter: {
    grad: "from-[#00E2E5] to-[#7af6f8]",
    ring: "ring-[#00E2E5]/40",
    badge: "bg-[#00E2E5]/15 text-[#00E2E5]",
  },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Trim BMI's verbose "Credit - X" / "X Pass" labels down to the meaningful part. */
function creditLabel(kind: string): string {
  return kind.replace(/^credit\s*-\s*/i, "").trim() || kind;
}

/** Exported for the kiosk license-scan match picker — same card, same look. */
export function AccountCard({
  account,
  onSelect,
  selectable = false,
  selected = false,
}: {
  account: FoundAccount;
  onSelect: () => void;
  /** Render a checkbox instead of a chevron and toggle rather than advance. */
  selectable?: boolean;
  selected?: boolean;
}) {
  const tier = account.memberships.length > 0 ? tierFromMemberships(account.memberships) : null;
  const theme = tier ? TIER_THEME[tier] : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selectable ? selected : undefined}
      className={
        "group flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-all focus:outline-none focus-visible:border-[#00E2E5]/60 " +
        (selected
          ? "border-[#00E2E5]/60 bg-[#00E2E5]/10"
          : "border-white/10 bg-white/5 hover:border-[#00E2E5]/40 hover:bg-white/[0.08]")
      }
    >
      <div
        className={
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-sm font-bold ring-2 ring-offset-2 ring-offset-[#000418] " +
          (theme
            ? `${theme.grad} ${theme.ring} text-[#000418]`
            : "from-white/25 to-white/5 text-white/80 ring-white/15")
        }
      >
        {initials(account.fullName)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-semibold text-white">{account.fullName}</p>
          {tier && theme && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${theme.badge}`}
            >
              {tier}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-white/40">
          {account.races} race{account.races !== 1 ? "s" : ""}
          {account.lastSeen && ` · Last seen ${account.lastSeen}`}
        </p>
        {account.creditBalances.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {account.creditBalances.slice(0, 3).map((c) => (
              <span
                key={c.kind}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300"
              >
                <span className="tabular-nums">{c.balance}</span>
                {creditLabel(c.kind)}
              </span>
            ))}
            {account.creditBalances.length > 3 && (
              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] font-medium text-white/40">
                +{account.creditBalances.length - 3} more
              </span>
            )}
          </div>
        )}
      </div>

      {selectable ? (
        <span
          aria-hidden="true"
          className={
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors " +
            (selected ? "border-[#00E2E5] bg-[#00E2E5]" : "border-white/25")
          }
        >
          {selected && <CheckIcon className="h-4 w-4 text-[#000418]" />}
        </span>
      ) : (
        <ChevronRightIcon className="h-5 w-5 shrink-0 text-white/20 transition-all group-hover:translate-x-0.5 group-hover:text-[#00E2E5]" />
      )}
    </button>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 10.5l3.5 3.5L15 6.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7.5 5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
