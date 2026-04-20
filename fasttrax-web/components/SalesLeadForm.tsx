"use client";

import { useState } from "react";

/**
 * SalesLeadForm — replaces the Cognito iframe on group-events and birthday pages.
 *
 * Posts to `/api/sales-lead/submit`, which orchestrates Pandora `/bmi/party-lead`,
 * customer SMS + email (from the assigned planner), Teams Adaptive Card, and the
 * BMI Office audit trail.
 *
 * Props:
 *   - centerKey: "fasttrax-ft-myers" | "headpinz-ft-myers" | "headpinz-naples"
 *   - brand:     "ft" | "hp" (controls coral vs cyan accent)
 *   - kind:      "group" | "birthday" (prefills eventType default)
 *   - onClose:   caller-provided close-modal handler
 */

export interface SalesLeadFormProps {
  centerKey: "fasttrax-ft-myers" | "headpinz-ft-myers" | "headpinz-naples";
  brand: "ft" | "hp";
  kind: "group" | "birthday";
  onClose: () => void;
}

const EVENT_TYPES_GROUP = [
  { value: "corporate", label: "Corporate event" },
  { value: "team-building", label: "Team building" },
  { value: "fundraiser", label: "Fundraiser" },
  { value: "school-group", label: "School / youth group" },
  { value: "other", label: "Other" },
];

const EVENT_TYPES_BIRTHDAY = [
  { value: "birthday-kid", label: "Kids birthday" },
  { value: "birthday-adult", label: "Adult birthday" },
  { value: "other", label: "Other" },
];

const ACTIVITIES = [
  { value: "bowling", label: "Bowling" },
  { value: "laser-tag", label: "Laser tag" },
  { value: "gel-blasters", label: "Gel blasters" },
  { value: "arcade", label: "Arcade" },
  { value: "racing", label: "Go-kart racing" },
  { value: "food-beverage", label: "Food & drinks" },
];

const CONTACT_METHODS = [
  { value: "phone", label: "Call" },
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
] as const;

const BEST_TIMES = [
  { value: "Morning", label: "Morning" },
  { value: "Afternoon", label: "Afternoon" },
  { value: "Evening", label: "Evening" },
] as const;

type ContactMethod = (typeof CONTACT_METHODS)[number]["value"];
type BestTime = (typeof BEST_TIMES)[number]["value"];

/**
 * Event-time slots — 11 AM → 10 PM in 30-min increments. Covers normal
 * operating hours at both HP centers and FastTrax. Value is 24-hour
 * HH:MM format (what Pandora's /bmi/party-lead expects); label is the
 * friendly 12-hour form the customer picks from.
 */
const TIME_SLOTS: Array<{ value: string; label: string }> = (() => {
  const out: Array<{ value: string; label: string }> = [];
  for (let h = 11; h <= 22; h++) {
    for (const m of [0, 30]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const hour12 = h === 12 ? 12 : h % 12;
      const ampm = h < 12 ? "AM" : "PM";
      const label = `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
      out.push({ value, label });
    }
  }
  return out;
})();

export function SalesLeadForm({ centerKey, brand, kind, onClose }: SalesLeadFormProps) {
  // Brand palette — coral for HeadPinz, cyan for FastTrax (matches site).
  const accent = brand === "hp" ? "#fd5b56" : "#00E2E5";
  const accentText = brand === "hp" ? "#ffffff" : "#000418";
  const bg = brand === "hp" ? "#0a1628" : "#000418";

  const eventTypes = kind === "birthday" ? EVENT_TYPES_BIRTHDAY : EVENT_TYPES_GROUP;

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [eventType, setEventType] = useState(eventTypes[0].value);
  const [preferredDate, setPreferredDate] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [guestCount, setGuestCount] = useState<string>("15");
  const [activityInterest, setActivityInterest] = useState<string[]>([]);
  const [preferredContactMethod, setPreferredContactMethod] = useState<ContactMethod>("phone");
  const [bestTimeToCall, setBestTimeToCall] = useState<BestTime>("Afternoon");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    projectNumber: string;
    plannerName: string;
    isIndividual: boolean;
  } | null>(null);

  const toggleActivity = (value: string) => {
    setActivityInterest((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const canSubmit =
    firstName.trim() &&
    lastName.trim() &&
    email.trim() &&
    phone.trim() &&
    Number(guestCount) >= 1 &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/sales-lead/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          centerKey,
          kind,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          eventType,
          preferredDate,
          preferredTime,
          guestCount: Number(guestCount),
          notes: notes.trim(),
          activityInterest,
          preferredContactMethod,
          bestTimeToCall,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Submit failed (${res.status})`);
      }
      setSuccess({
        projectNumber: data.projectNumber,
        plannerName: data.planner?.displayName || "Guest Services",
        isIndividual: !!data.planner?.isIndividual,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Success state ─────────────────────────────────────────────────────────
  if (success) {
    return (
      <div
        style={{
          padding: "clamp(32px, 6vw, 64px)",
          minHeight: "100%",
          background: bg,
          color: "#ffffff",
          overflowY: "auto",
        }}
        className="flex flex-col justify-center"
      >
        <div className="max-w-lg mx-auto text-center">
          <div
            style={{ color: accent, fontSize: "12px", letterSpacing: "3px" }}
            className="uppercase font-bold mb-4"
          >
            Inquiry Received · #{success.projectNumber}
          </div>
          <h2
            className="font-heading font-black uppercase italic text-white"
            style={{
              fontSize: "clamp(28px, 6vw, 44px)",
              lineHeight: 1.05,
              letterSpacing: "-0.5px",
              marginBottom: "16px",
            }}
          >
            Thanks!
          </h2>
          <p className="text-white/80 mb-2" style={{ fontSize: "16px", lineHeight: 1.6 }}>
            {success.isIndividual ? (
              <>
                <strong style={{ color: accent }}>{success.plannerName}</strong> will be your
                event planner and will reach out shortly.
              </>
            ) : (
              <>Our Guest Services team will follow up shortly.</>
            )}
          </p>
          <p className="text-white/60 mb-8" style={{ fontSize: "14px" }}>
            Check your email and phone — we just sent you {success.plannerName}&apos;s direct
            contact info.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105 cursor-pointer"
            style={{ backgroundColor: accent, color: accentText }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // ── Form state ────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        padding: "clamp(24px, 4vw, 48px)",
        background: bg,
        color: "#ffffff",
        overflowY: "auto",
        maxHeight: "100%",
      }}
    >
      <div className="max-w-2xl mx-auto">
        <div
          style={{ color: accent, fontSize: "11px", letterSpacing: "3px" }}
          className="uppercase font-bold mb-2"
        >
          {kind === "birthday" ? "Birthday Party" : "Group Event"} Inquiry
        </div>
        <h2
          className="font-heading font-black uppercase italic text-white"
          style={{
            fontSize: "clamp(24px, 5vw, 36px)",
            lineHeight: 1.05,
            letterSpacing: "-0.3px",
            marginBottom: "24px",
          }}
        >
          Tell us about your event
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Contact row — 4-col on desktop, 2-col on tablet, 1-col on mobile */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Field label="First name" required>
              <input
                type="text"
                autoComplete="given-name"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={inputCls(accent)}
              />
            </Field>
            <Field label="Last name" required>
              <input
                type="text"
                autoComplete="family-name"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={inputCls(accent)}
              />
            </Field>
            <Field label="Email" required>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls(accent)}
              />
            </Field>
            <Field label="Phone" required>
              <input
                type="tel"
                autoComplete="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(239) 555-0123"
                className={inputCls(accent)}
              />
            </Field>
          </div>

          {/* Event details row — same grid cadence */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Field label="Event type">
              <select
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                className={inputCls(accent)}
              >
                {eventTypes.map((t) => (
                  <option key={t.value} value={t.value} style={{ backgroundColor: "#0a1628" }}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Number of guests" required>
              <input
                type="number"
                min={1}
                max={500}
                required
                value={guestCount}
                onChange={(e) => setGuestCount(e.target.value)}
                className={inputCls(accent)}
              />
            </Field>
            <Field label="Preferred date">
              <input
                type="date"
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
                className={inputCls(accent)}
              />
            </Field>
            <Field label="Preferred time">
              <select
                value={preferredTime}
                onChange={(e) => setPreferredTime(e.target.value)}
                className={inputCls(accent)}
              >
                <option value="" style={{ backgroundColor: "#0a1628" }}>
                  Select a time...
                </option>
                {TIME_SLOTS.map((t) => (
                  <option key={t.value} value={t.value} style={{ backgroundColor: "#0a1628" }}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Activity interest — 6-col on lg (single row), 3-col on sm, 2-col on mobile */}
          <Field label="Interested in (pick all that apply)">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-1">
              {ACTIVITIES.map((a) => {
                const selected = activityInterest.includes(a.value);
                return (
                  <button
                    type="button"
                    key={a.value}
                    onClick={() => toggleActivity(a.value)}
                    className="px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center"
                    style={{
                      border: selected ? `1px solid ${accent}` : "1px solid rgba(255,255,255,0.15)",
                      backgroundColor: selected ? `${accent}20` : "rgba(255,255,255,0.03)",
                      color: selected ? accent : "#ffffffc0",
                    }}
                  >
                    {selected ? "✓ " : ""}
                    {a.label}
                  </button>
                );
              })}
            </div>
          </Field>

          {/* Preferences row — on lg, put all three (contact / time / notes) side-by-side
              so the notes field doesn't eat a whole row to itself on desktop. */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Field label="Preferred contact method">
              <div className="grid grid-cols-3 gap-2 mt-1">
                {CONTACT_METHODS.map((m) => {
                  const selected = preferredContactMethod === m.value;
                  return (
                    <button
                      type="button"
                      key={m.value}
                      onClick={() => setPreferredContactMethod(m.value)}
                      className="px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center"
                      style={{
                        border: selected ? `1px solid ${accent}` : "1px solid rgba(255,255,255,0.15)",
                        backgroundColor: selected ? `${accent}20` : "rgba(255,255,255,0.03)",
                        color: selected ? accent : "#ffffffc0",
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Best time to reach you">
              <div className="grid grid-cols-3 gap-2 mt-1">
                {BEST_TIMES.map((t) => {
                  const selected = bestTimeToCall === t.value;
                  return (
                    <button
                      type="button"
                      key={t.value}
                      onClick={() => setBestTimeToCall(t.value)}
                      className="px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center"
                      style={{
                        border: selected ? `1px solid ${accent}` : "1px solid rgba(255,255,255,0.15)",
                        backgroundColor: selected ? `${accent}20` : "rgba(255,255,255,0.03)",
                        color: selected ? accent : "#ffffffc0",
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Anything else we should know?">
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Dietary needs, age range, special occasions..."
                className={inputCls(accent) + " resize-y"}
                style={{ minHeight: "44px" }}
              />
            </Field>
          </div>

          {error && (
            <div
              className="rounded-lg px-4 py-3 text-sm"
              style={{
                backgroundColor: "rgba(229,57,53,0.15)",
                color: "#ffb4b4",
                border: "1px solid rgba(229,57,53,0.4)",
              }}
            >
              {error}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              style={{ border: "1px solid rgba(255,255,255,0.15)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex-[2] px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              style={{ backgroundColor: accent, color: accentText }}
            >
              {submitting ? "Sending..." : "Submit inquiry"}
            </button>
          </div>

          <p className="text-xs text-white/40 text-center pt-2">
            We&apos;ll text &amp; email you within a business day. No spam, just event planning.
          </p>
        </form>
      </div>
    </div>
  );
}

// ── UI bits ────────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wider text-white/60 mb-1.5">
        {label}
        {required && <span className="text-white/40"> *</span>}
      </span>
      {children}
    </label>
  );
}

function inputCls(accent: string): string {
  // Matches `/hp/book/bowling/page.tsx` contact inputs for visual consistency.
  return `w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3 text-white font-body text-sm placeholder:text-white/30 focus:outline-none transition-colors`;
  // note: `accent` used elsewhere (select options bg); the focus-border is
  // handled inline for simplicity because per-component dynamic Tailwind
  // JIT strings don't work well with runtime values.
  void accent;
}
