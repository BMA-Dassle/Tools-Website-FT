"use client";

import { useState } from "react";
import type { KbfItem, StepDef } from "~/features/booking";

const CORAL = "#fd5b56";

interface PassWithMembers {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  fpass: boolean;
  members: Array<{
    id: number;
    passId: number;
    relation: "kid" | "family";
    slot: number;
    firstName: string;
    lastName: string;
    birthday: string;
    prefs: { wantBumpers: boolean | null } | null;
  }>;
}

const KbfIdentityStepComponent: StepDef<KbfItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  const phase = session.kbfIdentity?.phase ?? "lookup";

  const [tab, setTab] = useState<"email" | "phone" | "new">("email");
  const [emailInput, setEmailInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [maskedDest, setMaskedDest] = useState("");
  const [code, setCode] = useState("");
  const [verifyError, setVerifyError] = useState("");

  const centerId = item.qamfCenterId ?? 9172;

  function formatPhone(raw: string): string {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  async function handleLookup() {
    const contact = tab === "email" ? emailInput.trim() : phoneInput.replace(/\D/g, "");
    if (!contact) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/kbf/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact, centerId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Couldn't find that account. Check your email or phone.");
        return;
      }
      setMaskedDest(data.maskedDestination ?? "");
      dispatch({
        type: "setKbfIdentity",
        patch: {
          phase: "verify",
          emailOrPhone: contact,
        },
      });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    if (code.length !== 6) return;
    setBusy(true);
    setVerifyError("");
    try {
      const res = await fetch("/api/kbf/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact: session.kbfIdentity?.emailOrPhone,
          code,
        }),
      });
      const data = await res.json();
      if (!data.verified) {
        setVerifyError(data.error ?? "Invalid code. Please try again.");
        return;
      }
      const passes: PassWithMembers[] = data.passes ?? [];
      const primary = passes[0];
      if (!primary) {
        setVerifyError("No KBF pass found for this account.");
        return;
      }
      // Flatten the roster across EVERY pass — a parent can have more
      // than one (e.g. registered at both centers). Kids are always
      // bookable; family adults only when the account has Families Bowl
      // Free (fpass). Captured here so the Bowlers step has the roster
      // without a second round-trip.
      const hasFbf = passes.some((p) => p.fpass === true);
      const members = passes.flatMap((p) =>
        (p.members ?? [])
          .filter((m) => m.relation === "kid" || hasFbf)
          .map((m) => ({
            id: m.id,
            passId: m.passId,
            relation: m.relation,
            slot: m.slot,
            firstName: m.firstName,
            lastName: m.lastName,
          })),
      );
      dispatch({
        type: "setKbfIdentity",
        patch: { phase: "verified", passId: primary.id, members },
      });
      onChange({ passId: primary.id });
    } catch {
      setVerifyError("Verification failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── Lookup phase ──────────────────────────────────────────────────
  if (phase === "lookup") {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <div className="text-center">
          <h2 className="font-display text-2xl uppercase tracking-widest text-white">Sign In</h2>
          <p className="mt-1 text-sm text-white/40">Look up your Kids Bowl Free family pass</p>
        </div>

        <div className="flex gap-1 rounded-lg bg-white/5 p-1">
          {(["email", "phone", "new"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setTab(m)}
              className="flex-1 rounded-md py-2 text-xs font-semibold uppercase tracking-wider transition-colors"
              style={{
                backgroundColor: tab === m ? CORAL : "transparent",
                color: tab === m ? "#0a1628" : "rgba(255,255,255,0.45)",
              }}
            >
              {m === "phone" ? "SMS" : m === "new" ? "New" : "Email"}
            </button>
          ))}
        </div>

        {tab === "email" && (
          <div className="space-y-3">
            <input
              type="email"
              autoComplete="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleLookup()}
              placeholder="parent@example.com"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none"
              style={{ borderColor: `${CORAL}30` }}
            />
            <button
              type="button"
              onClick={() => void handleLookup()}
              disabled={busy || !emailInput.includes("@")}
              className="w-full rounded-full py-3 text-sm font-bold uppercase tracking-wider text-white transition-all disabled:opacity-40"
              style={{ backgroundColor: CORAL }}
            >
              {busy ? "Looking up…" : "Send verification code"}
            </button>
          </div>
        )}

        {tab === "phone" && (
          <div className="space-y-3">
            <input
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phoneInput}
              onChange={(e) => setPhoneInput(formatPhone(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && void handleLookup()}
              placeholder="(239) 555-1234"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-sm tracking-wider text-white placeholder:text-white/25 focus:outline-none"
              style={{ borderColor: `${CORAL}30` }}
            />
            <button
              type="button"
              onClick={() => void handleLookup()}
              disabled={busy || phoneInput.replace(/\D/g, "").length !== 10}
              className="w-full rounded-full py-3 text-sm font-bold uppercase tracking-wider text-white transition-all disabled:opacity-40"
              style={{ backgroundColor: CORAL }}
            >
              {busy ? "Looking up…" : "Send verification code"}
            </button>
          </div>
        )}

        {tab === "new" && (
          <div
            className="rounded-xl px-4 py-4"
            style={{
              backgroundColor: "rgba(253,91,86,0.05)",
              border: "1px solid rgba(253,91,86,0.20)",
            }}
          >
            <p className="text-xs leading-relaxed text-white/65">
              Sign up at{" "}
              <a
                href="https://www.kidsbowlfree.com/bowland"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-white"
              >
                kidsbowlfree.com/bowland
              </a>{" "}
              — new accounts take about an hour to be reservable here.
            </p>
          </div>
        )}

        {error && <p className="text-center text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Verify phase ──────────────────────────────────────────────────
  if (phase === "verify") {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <div className="text-center">
          <h2 className="font-display text-2xl uppercase tracking-widest text-white">Enter Code</h2>
          {maskedDest && <p className="mt-1 text-sm text-white/40">Code sent to {maskedDest}</p>}
        </div>

        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && void handleVerify()}
          placeholder="000000"
          className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-4 text-center text-2xl tracking-[0.5em] text-white placeholder:text-white/20 focus:outline-none"
          style={{ borderColor: `${CORAL}30` }}
        />

        <button
          type="button"
          onClick={() => void handleVerify()}
          disabled={busy || code.length !== 6}
          className="w-full rounded-full py-3 text-sm font-bold uppercase tracking-wider text-white transition-all disabled:opacity-40"
          style={{ backgroundColor: CORAL }}
        >
          {busy ? "Verifying…" : "Verify"}
        </button>

        {verifyError && <p className="text-center text-xs text-red-400">{verifyError}</p>}

        <button
          type="button"
          onClick={() => dispatch({ type: "setKbfIdentity", patch: { phase: "lookup" } })}
          className="mx-auto block text-xs text-white/40 hover:text-white/70"
        >
          &larr; Try a different email or phone
        </button>
      </div>
    );
  }

  // ── Verified — auto-advance handled by canAdvance ─────────────────
  return (
    <div className="mx-auto max-w-md py-8 text-center">
      <div className="mb-3 text-2xl text-green-400">&#10003;</div>
      <p className="text-sm text-white/60">Pass verified. Tap Next to continue.</p>
    </div>
  );
};

const KbfIdentityStep: StepDef<KbfItem> = {
  id: "kbf-identity",
  title: "Verify",
  Component: KbfIdentityStepComponent,
  isVisible: () => true,
  canAdvance: (item, session) =>
    session.kbfIdentity?.phase === "verified" && item.passId !== null
      ? true
      : { reason: "Verify your KBF pass first" },
};

export default KbfIdentityStep;
