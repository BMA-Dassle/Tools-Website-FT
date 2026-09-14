"use client";

import { useEffect, useRef, useState } from "react";
import { clarityEvent } from "~/lib/clarity";
import type { PartyMember } from "~/features/booking/state/types";
import type { SessionEmployee } from "~/features/discount-codes/programs/employee";
import { employeeApi } from "~/features/discount-codes/programs/employee-client";
import { PeekSecretInput } from "~/components/ui/PeekSecretInput";

/**
 * WEB checkout — "Team member?" beside the promo field (owner 2026-09-13).
 * Employee ID or mobile → one-time code texted to the 7shifts mobile → the
 * server's SessionEmployee is dispatched onto the session (addEmployee), which
 * stamps the matched party member so the review prices the perks. Mirrors
 * PromoCodeInput's styling; the difference is two steps and no client-side
 * pricing of any kind.
 *
 * SEVERAL team members can verify on one booking (owner 2026-09-14): each
 * verified employee gets a chip with their own Remove, and the "Team member?"
 * door stays open for the next one.
 */
export function EmployeePerksInput({
  employees,
  party,
  onVerified,
  onRemove,
}: {
  employees: ReadonlyArray<SessionEmployee>;
  party: PartyMember[];
  onVerified: (employee: SessionEmployee) => void;
  onRemove: (userId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"id" | "code">("id");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [tail, setTail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chips =
    employees.length > 0 ? (
      <div className="space-y-2">
        {employees.map((employee) => {
          const linked = !!employee.memberId;
          return (
            <div key={employee.userId} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="rounded-full bg-green-500/[0.18] px-2.5 py-1 text-xs font-bold tracking-wider text-green-500">
                    &#10003; TEAM MEMBER · {employee.firstName.toUpperCase()}
                  </span>
                  <span className="text-xs text-white/50">
                    {linked ? "perks on your items — savings shown below" : "verified"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(employee.userId)}
                  className="text-xs uppercase tracking-wider text-white/40 transition-colors hover:text-white/80"
                >
                  &#10005; Remove
                </button>
              </div>
              {!linked && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs text-white/60">
                  We couldn&apos;t match {employee.firstName} to a racer on this booking. The
                  racer&apos;s last name and phone both have to match the 7shifts profile. Add
                  yourself to the party as a returning racer, then verify again.
                </div>
              )}
            </div>
          );
        })}
      </div>
    ) : null;

  if (!open) {
    return (
      <div className="space-y-2">
        {chips}
        <div className="flex justify-end px-1">
          <span className="text-xs text-white/40">
            {employees.length > 0 ? "Another team member?" : "Team member?"}{" "}
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                clarityEvent("employee:open");
              }}
              className="font-semibold text-[#00E2E5] hover:text-white"
            >
              Use your employee perks
            </button>
          </span>
        </div>
      </div>
    );
  }

  async function start() {
    const raw = value.trim();
    if (!raw || busy) return;
    setBusy(true);
    setError(null);
    const digits = raw.replace(/\D/g, "");
    const isPhone = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
    const res = await employeeApi.start(isPhone ? { phone: raw } : { punchId: raw });
    setBusy(false);
    if (res.ok) {
      setChallenge(res.challenge);
      setTail(res.maskedPhone);
      setPhase("code");
      clarityEvent("employee:code-sent");
      return;
    }
    setError(
      res.reason === "no-mobile"
        ? "Your 7shifts profile has no mobile number. Add one in 7shifts, then try again."
        : res.reason === "rate-limited"
          ? "Too many tries. Please wait a moment."
          : res.reason === "unavailable" || res.reason === "disabled"
            ? "We can't verify team members right now. Please try again later."
            : "We couldn't verify you. Check your employee ID or mobile and try again.",
    );
  }

  async function verify() {
    if (!challenge || code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const res = await employeeApi.verify({
      challenge,
      code,
      party: party.map((m) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName ?? null,
        phone: m.phone ?? null,
        bmiPersonId: m.bmiPersonId ?? null,
      })),
    });
    setBusy(false);
    if (res.ok) {
      clarityEvent("employee:verified");
      onVerified(res.employee);
      setOpen(false);
      setPhase("id");
      setValue("");
      setCode("");
      setChallenge(null);
      return;
    }
    if (res.reason === "incorrect") {
      setError(`That code isn't right. ${res.attemptsLeft ?? 0} tries left.`);
      setCode("");
      return;
    }
    if (res.reason === "expired" || res.reason === "locked") {
      setError(
        res.reason === "expired"
          ? "That code expired. Start again to get a new one."
          : "Too many wrong codes. Please wait 15 minutes.",
      );
      setPhase("id");
      setChallenge(null);
      return;
    }
    setError("We couldn't verify you. Please try again.");
  }

  return (
    <div className="space-y-2">
      {chips}
      <div className="space-y-3 rounded-xl border border-[#00E2E5]/25 bg-[#00E2E5]/5 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/40">
            Team member perks
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="text-xs uppercase tracking-wider text-white/40 hover:text-white/80"
          >
            &#10005; Close
          </button>
        </div>
        {phase === "id" ? (
          <>
            <p className="text-sm text-white/70">
              Enter your employee ID or the mobile number on your 7shifts profile. We&apos;ll text
              you a code.
            </p>
            <div className="flex gap-2">
              <PeekSecretInput
                inputMode="tel"
                value={value}
                onValueChange={(next) => {
                  setError(null);
                  setValue(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void start();
                  }
                }}
                placeholder="Employee ID or mobile"
                autoComplete="off"
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
              />
              <button
                type="button"
                disabled={!value.trim() || busy}
                onClick={() => void start()}
                className="rounded-lg bg-[#00E2E5] px-4 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
              >
                {busy ? "Sending…" : "Text me a code"}
              </button>
            </div>
            <p className="text-xs text-white/40">
              Perks apply to your own single races, gel blaster and laser tag. Your ID is never
              shown to anyone else on this booking.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-white/70">
              We texted a 6-digit code to the number on your 7shifts profile ending in{" "}
              <strong className="text-white">{tail}</strong>.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => {
                  setError(null);
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void verify();
                  }
                }}
                placeholder="••••••"
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 font-mono text-sm tracking-[0.3em] text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
              />
              <button
                type="button"
                disabled={code.length !== 6 || busy}
                onClick={() => void verify()}
                className="rounded-lg bg-[#00E2E5] px-4 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-40"
              >
                {busy ? "Checking…" : "Verify"}
              </button>
            </div>
            <div className="flex justify-between text-xs text-white/40">
              <span>Wrong number on file? Update it in 7shifts.</span>
              <button
                type="button"
                onClick={() => {
                  setPhase("id");
                  setError(null);
                }}
                className="hover:text-white/80"
              >
                Start over
              </button>
            </div>
          </>
        )}
        {error && <p className="text-xs text-[#ff8c7a]">{error}</p>}
      </div>
    </div>
  );
}

/**
 * WEB code-free RECOGNITION (owner 2026-09-13: "we already required one to pull
 * up the known account" / "web should do the automatic check as well"). Called
 * at the TOP of CheckoutStep — every phase, not just the contact card — so a
 * party member the returning-racer lookup produced (has `bmiPersonId`) is
 * checked against the server the moment checkout opens. A linked employee, or
 * one whose BMI last name + phone match an active 7shifts record, gets the
 * perks applied with no code. Each BMI person is asked about once per checkout;
 * members already verified as an employee are never asked again, so a second
 * team member on the party is recognised in turn (2026-09-14).
 */
export function useEmployeeRecognitionWeb(
  party: PartyMember[],
  employees: ReadonlyArray<SessionEmployee>,
  onVerified: (employee: SessionEmployee) => void,
) {
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    const claimed = new Set(employees.map((e) => e.memberId).filter(Boolean));
    const candidate = party.find(
      (m) => !!m.bmiPersonId && !claimed.has(m.id) && !asked.current.has(m.bmiPersonId),
    );
    if (!candidate?.bmiPersonId) return;
    asked.current.add(candidate.bmiPersonId);
    let cancelled = false;
    void employeeApi
      .recognize({
        id: candidate.id,
        firstName: candidate.firstName,
        lastName: candidate.lastName ?? null,
        phone: candidate.phone ?? null,
        bmiPersonId: candidate.bmiPersonId,
      })
      .then((res) => {
        if (cancelled || !res.ok) return;
        clarityEvent("employee:recognized");
        onVerified(res.employee);
      });
    return () => {
      cancelled = true;
    };
  }, [party, employees, onVerified]);
}
