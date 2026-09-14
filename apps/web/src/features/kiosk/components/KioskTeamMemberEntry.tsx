"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { clarityEvent } from "~/lib/clarity";
import type { PartyMember } from "~/features/booking/state/types";
import type { SessionEmployee } from "~/features/discount-codes/programs/employee";
import { employeeApi } from "~/features/discount-codes/programs/employee-client";

/**
 * KIOSK — Team member verification (employee perks), a MODE of the code-entry
 * screen. Employee ID or mobile → one-time code texted to the 7shifts mobile →
 * verified. Same visual grammar as "Enter your code" (k-display title, the
 * dark code field, k-btn-primary / k-btn-ghost footer) so it reads as one
 * screen with one more door, not a new screen.
 *
 * What it never does: send a code to a number typed here, accept a token
 * count or a discount from the client, or say WHY an ID failed. The server
 * (programs/employee.server.ts) owns every rule; this is a keypad.
 */
export function KioskTeamMemberEntry({
  party,
  onVerified,
  onBack,
}: {
  party: PartyMember[];
  /** The server's SessionEmployee — the parent dispatches setEmployee. */
  onVerified: (employee: SessionEmployee, linked: boolean) => void;
  onBack: () => void;
}) {
  const t = useT();
  const { config } = useKioskConfig();
  const [phase, setPhase] = useState<"id" | "code" | "done">("id");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [tail, setTail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; linked: boolean } | null>(null);
  const [resendAt, setResendAt] = useState<number>(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [phase]);
  useEffect(() => {
    if (phase !== "code") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  const kiosk = config
    ? {
        deviceKey: kioskDeviceKey(config),
        center: config.center === "naples" ? "naples" : config.brand,
        brand: config.brand,
      }
    : undefined;

  async function start() {
    const raw = value.trim();
    if (!raw || busy) return;
    setBusy(true);
    setError(null);
    const digits = raw.replace(/\D/g, "");
    const isPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
    const res = await employeeApi.start(isPhone ? { phone: raw } : { punchId: raw }, kiosk);
    setBusy(false);
    if (res.ok) {
      clarityEvent("kiosk:team:code-sent");
      setChallenge(res.challenge);
      setTail(res.maskedPhone);
      setCode("");
      setResendAt(Date.now() + 60_000);
      setPhase("code");
      return;
    }
    clarityEvent("kiosk:team:start-refused");
    setError(startError(res.reason));
  }

  async function verify() {
    if (!challenge || code.replace(/\D/g, "").length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const res = await employeeApi.verify({ challenge, code, party: party.map(toMatchable) }, kiosk);
    setBusy(false);
    if (res.ok) {
      clarityEvent("kiosk:team:verified");
      setDone({ name: res.employee.firstName, linked: !!res.employee.memberId });
      setPhase("done");
      onVerified(res.employee, res.linked);
      return;
    }
    clarityEvent("kiosk:team:code-refused");
    if (res.reason === "incorrect") {
      setError(t("team.err.incorrect", { n: res.attemptsLeft ?? 0 }));
      setCode("");
      return;
    }
    if (res.reason === "expired" || res.reason === "locked") {
      setError(t(res.reason === "expired" ? "team.err.expired" : "team.err.locked"));
      setPhase("id");
      setChallenge(null);
      return;
    }
    setError(startError(res.reason));
  }

  function startError(reason: string): string {
    switch (reason) {
      case "no-mobile":
        return t("team.err.noMobile");
      case "rate-limited":
        return t("team.err.rateLimited");
      case "unavailable":
      case "disabled":
        return t("team.err.unavailable");
      default:
        return t("team.err.unverified");
    }
  }

  const resendLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  if (phase === "done" && done) {
    return (
      <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[104px]">
        <div className="k-eyebrow">{t("team.eyebrow")}</div>
        <h1 className="k-display mt-[24px] text-[80px]">
          {t("team.done.title", { name: done.name })}
        </h1>
        <p className="mt-[24px] text-[30px] leading-[1.35] text-white/70">
          {done.linked ? t("team.done.linked") : t("team.done.unlinked")}
        </p>
        <div className="mt-auto flex gap-[24px]">
          <button type="button" onClick={onBack} className="k-btn-primary k-tap">
            {t("team.done.cta")}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "code") {
    return (
      <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[104px]">
        <div className="k-eyebrow">{t("team.eyebrow")}</div>
        <h1 className="k-display mt-[24px] text-[80px]">{t("team.codeTitle")}</h1>
        <p className="mt-[10px] text-[26px] leading-[1.35] text-white/60">
          {t("team.codeSub", { tail })}
        </p>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => {
            setError(null);
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void verify();
          }}
          aria-label={t("team.codeTitle")}
          placeholder="••••••"
          autoComplete="one-time-code"
          className="k-num mt-[44px] h-[130px] w-full rounded-[24px] border-2 border-[rgba(0,226,229,0.55)] bg-[#040d24] px-[40px] font-mono text-[52px] tracking-[0.3em] text-white placeholder:text-white/30 focus:outline-none"
        />
        <div className="mt-[20px] flex items-center justify-between gap-[24px] text-[24px] text-white/55">
          <span>
            {error ? <span className="text-[#ff8c7a]">{error}</span> : t("team.codeHint")}
          </span>
          <button
            type="button"
            disabled={resendLeft > 0 || busy}
            onClick={() => {
              setPhase("id");
              void start();
            }}
            className="k-tap shrink-0 font-heading text-[22px] font-bold uppercase tracking-[0.05em] text-white/60 disabled:text-white/30"
          >
            {resendLeft > 0 ? t("team.resendIn", { seconds: resendLeft }) : t("team.resend")}
          </button>
        </div>
        <div className="mt-auto flex gap-[24px]">
          <button
            type="button"
            onClick={() => {
              setPhase("id");
              setError(null);
            }}
            className="k-btn-ghost k-tap"
          >
            {t("codeEntry.back")}
          </button>
          <button
            type="button"
            onClick={() => void verify()}
            disabled={code.length !== 6 || busy}
            className="k-btn-primary k-tap"
          >
            {t("team.verify")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[104px]">
      <div className="k-eyebrow">{t("team.eyebrow")}</div>
      <h1 className="k-display mt-[24px] text-[80px]">{t("team.title")}</h1>
      <p className="mt-[10px] text-[26px] leading-[1.35] text-white/60">{t("team.sub")}</p>
      {/* type=password: the employee ID is a time-clock credential and the
          kiosk screen is public — never echo it (owner 2026-09-13). */}
      <input
        ref={inputRef}
        type="password"
        inputMode="tel"
        value={value}
        onChange={(e) => {
          setError(null);
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void start();
        }}
        aria-label={t("team.title")}
        placeholder={t("team.placeholder")}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="k-num mt-[44px] h-[130px] w-full rounded-[24px] border-2 border-[rgba(0,226,229,0.55)] bg-[#040d24] px-[40px] font-mono text-[52px] tracking-[0.12em] text-white placeholder:text-white/30 focus:outline-none"
      />
      <div className="mt-[20px] min-h-[40px] text-[26px] leading-[1.35] text-[#ff8c7a]">
        {error}
      </div>
      <div className="mt-auto flex gap-[24px]">
        <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
          {t("codeEntry.back")}
        </button>
        <button
          type="button"
          onClick={() => void start()}
          disabled={!value.trim() || busy}
          className="k-btn-primary k-tap"
        >
          {t("team.continue")}
        </button>
      </div>
    </div>
  );
}

/** PartyMember → the server's match shape (names, phone, BMI id — nothing else). */
export function toMatchable(m: PartyMember) {
  return {
    id: m.id,
    firstName: m.firstName,
    lastName: m.lastName ?? null,
    phone: m.phone ?? null,
    bmiPersonId: m.bmiPersonId ?? null,
  };
}
