"use client";

import { useEffect, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

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
  /**
   * Which event-type dropdown to show:
   *   "group"    → corporate / team-building / fundraiser / ...
   *   "birthday" → kids / adult / other
   *   "all"      → combined list (both birthday variants + group types),
   *                used on /group-events pages since many guests land
   *                there looking to plan a birthday party.
   */
  kind: "group" | "birthday" | "all";
  onClose: () => void;
  /**
   * Pre-filled "package the customer clicked Book on" label, e.g.
   * "VIP Birthday", "Fajita Bar". Shown as a pill at the top of the
   * form and sent as Pandora's `packageType` field — which is exactly
   * what that column is for. Submit endpoint also prepends it to the
   * specialRequests blob so planners see it without opening Pandora.
   */
  packagePrefill?: string;
  /**
   * Pre-select the event type (matches one of the option values for the
   * chosen `kind`). When the caller knows what the guest clicked — e.g.
   * "Adult Birthday" card on /group-events — pass the value here so the
   * dropdown lands on the right row.
   */
  initialEventType?: string;
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

const EVENT_TYPES_ALL = [
  { value: "birthday-adult", label: "Adult birthday" },
  { value: "birthday-kid", label: "Kids birthday" },
  { value: "corporate", label: "Corporate event" },
  { value: "team-building", label: "Team building" },
  { value: "fundraiser", label: "Fundraiser" },
  { value: "school-group", label: "School / youth group" },
  { value: "other", label: "Other" },
];

type CenterKey = SalesLeadFormProps["centerKey"];

/** User-facing location picker options. Order matters — shown as cards. */
const CENTERS: Array<{ key: CenterKey; label: string; subtitle: string }> = [
  { key: "headpinz-ft-myers", label: "HeadPinz Fort Myers", subtitle: "Bowling · Laser tag · Gel blasters · Arcade" },
  { key: "headpinz-naples", label: "HeadPinz Naples", subtitle: "Bowling · Laser tag · Gel blasters · Arcade" },
  { key: "fasttrax-ft-myers", label: "FastTrax Fort Myers", subtitle: "Electric karting · Duckpin · Shuffly" },
];

const ACTIVITIES = [
  { value: "bowling", label: "Bowling" },
  { value: "laser-tag", label: "Laser tag" },
  { value: "gel-blasters", label: "Gel blasters" },
  { value: "arcade", label: "Arcade" },
  { value: "racing", label: "Karting" },
  { value: "food-beverage", label: "Food" },
  { value: "private-event-area", label: "Private event area" },
  { value: "meeting-room", label: "Meeting room" },
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

export function SalesLeadForm({ centerKey, brand, kind, onClose, packagePrefill, initialEventType }: SalesLeadFormProps) {
  // Brand palette — coral for HeadPinz, cyan for FastTrax (matches site).
  const accent = brand === "hp" ? "#fd5b56" : "#00E2E5";
  const accentText = brand === "hp" ? "#ffffff" : "#000418";
  const bg = brand === "hp" ? "#0a1628" : "#000418";

  const eventTypes =
    kind === "birthday" ? EVENT_TYPES_BIRTHDAY
    : kind === "all" ? EVENT_TYPES_ALL
    : EVENT_TYPES_GROUP;
  // If caller hinted at a pre-selected type, honor it when present in the list.
  const defaultEventType =
    initialEventType && eventTypes.some((e) => e.value === initialEventType)
      ? initialEventType
      : eventTypes[0].value;

  /**
   * Selected center — initialized from the prop (the page the user came
   * from) and editable via the step-1 picker. All submissions use this,
   * not the incoming prop, so a guest who switches in the form actually
   * gets routed to the right planner + Pandora location.
   */
  const [selectedCenter, setSelectedCenter] = useState<CenterKey>(centerKey);

  /** 3-step wizard: 1=Basics, 2=When & Activities, 3=Contact. */
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [eventType, setEventType] = useState(defaultEventType);
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

  /**
   * Kids-birthday conflict warning.
   *
   * Fires as early as possible so the guest isn't blindsided at submit:
   *   - Kids birthday + FastTrax center  →  warn (FT can't host organized
   *     kids parties at all; karting restrictions drive the whole center
   *     away from kid parties)
   *   - Kids birthday + karting activity  →  warn (same karting rules
   *     apply at HP if they try to combine it)
   *
   * `ack` flips true once the guest clicks "Keep my choices" so we don't
   * re-nag them after each toggle. The ack resets when the combo is no
   * longer true (center changed, karting removed, event type changed),
   * so if they later re-trigger the combo we re-show the warning.
   */
  const [showKidsKartingWarning, setShowKidsKartingWarning] = useState(false);
  const [kidsKartingAck, setKidsKartingAck] = useState(false);

  /**
   * Short-notice warning — VIP/group events need planning lead time.
   * Fires when preferredDate is <3 calendar days out. Same ack pattern
   * as the kids-karting warning: dismiss once, re-fire if user changes
   * to a short-notice date later.
   */
  const [showShortNoticeWarning, setShowShortNoticeWarning] = useState(false);
  const [shortNoticeAck, setShortNoticeAck] = useState(false);

  const isKidsBirthday = eventType === "birthday-kid";
  const kartingPicked = activityInterest.includes("racing");
  const fastTraxCenter = selectedCenter === "fasttrax-ft-myers";
  const kidsKartingConflict =
    isKidsBirthday && (fastTraxCenter || kartingPicked);

  useEffect(() => {
    if (kidsKartingConflict && !kidsKartingAck) {
      setShowKidsKartingWarning(true);
    }
    // Reset ack once the combo clears — so a later re-trigger warns again.
    if (!kidsKartingConflict && kidsKartingAck) {
      setKidsKartingAck(false);
    }
  }, [kidsKartingConflict, kidsKartingAck]);

  // Short-notice check: preferredDate picked is <3 calendar days out.
  // Uses local midnight anchors for both sides so TZ drift doesn't
  // push a "tomorrow" pick into "today".
  const isShortNotice = (() => {
    if (!preferredDate) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const picked = new Date(`${preferredDate}T00:00:00`);
    if (Number.isNaN(picked.getTime())) return false;
    const days = Math.round((picked.getTime() - today.getTime()) / 86_400_000);
    return days >= 0 && days < 3;
  })();

  useEffect(() => {
    if (isShortNotice && !shortNoticeAck) {
      setShowShortNoticeWarning(true);
    }
    if (!isShortNotice && shortNoticeAck) {
      setShortNoticeAck(false);
    }
  }, [isShortNotice, shortNoticeAck]);

  // Where "Book online instead" sends short-notice guests. Absolute URLs
  // so the guest always lands on the right branded hub regardless of
  // which domain the form was opened on.
  const onlineBookingHref =
    selectedCenter === "fasttrax-ft-myers"
      ? "https://fasttraxent.com/book"
      : selectedCenter === "headpinz-naples"
        ? "https://headpinz.com/book?location=naples"
        : "https://headpinz.com/book";

  // Resolve the "submit a HeadPinz kids party request" link from the
  // currently-selected center — stay in-domain on HP, go external from FT.
  const hpKidsPartyHref =
    selectedCenter === "headpinz-naples"
      ? "/naples/birthdays"
      : selectedCenter === "headpinz-ft-myers"
        ? "/fort-myers/birthdays"
        : "https://headpinz.com/fort-myers/birthdays";

  const toggleActivity = (value: string) => {
    setActivityInterest((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const removeKarting = () => {
    setActivityInterest((prev) => prev.filter((v) => v !== "racing"));
    setShowKidsKartingWarning(false);
  };

  /** Switch to HeadPinz Fort Myers (the kids-party-capable center) */
  const switchToHpFtMyers = () => {
    setSelectedCenter("headpinz-ft-myers");
    setActivityInterest((prev) => prev.filter((v) => v !== "racing"));
    setShowKidsKartingWarning(false);
  };

  // Per-step validation — drives the Next button on steps 1 & 2 and
  // the Submit button on step 3.
  const canAdvanceFromStep1 = Boolean(selectedCenter && eventType && Number(guestCount) >= 1);
  const canAdvanceFromStep2 = true; // date/time/activities/notes are all optional
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
          centerKey: selectedCenter,
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
          packagePrefill,
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
          {kind === "birthday" ? "Birthday Party" : kind === "all" ? "Event" : "Group Event"} Inquiry
        </div>
        <h2
          className="font-heading font-black uppercase italic text-white"
          style={{
            fontSize: "clamp(24px, 5vw, 36px)",
            lineHeight: 1.05,
            letterSpacing: "-0.3px",
            marginBottom: "12px",
          }}
        >
          {step === 1 ? "Let's start with the basics" : step === 2 ? "When & what" : "How do we reach you?"}
        </h2>

        {/* Step progress bar — three pips labelled Basics / When / Contact. */}
        <div className="flex items-center gap-2 mb-5">
          {[1, 2, 3].map((n) => {
            const active = step === n;
            const done = step > n;
            return (
              <div
                key={n}
                className="flex-1 flex items-center gap-2"
                style={{ opacity: done || active ? 1 : 0.4 }}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold"
                  style={{
                    backgroundColor: active || done ? accent : "rgba(255,255,255,0.1)",
                    color: active || done ? accentText : "rgba(255,255,255,0.6)",
                  }}
                >
                  {done ? "✓" : n}
                </div>
                <span className="uppercase font-bold text-white/70" style={{ fontSize: "10px", letterSpacing: "2px" }}>
                  {n === 1 ? "Basics" : n === 2 ? "When" : "Contact"}
                </span>
                {n < 3 && <div className="flex-1 h-px bg-white/10" />}
              </div>
            );
          })}
        </div>

        {/* Pre-selected package pill — set by the "Book This Package" button
            on birthday / group-events pages. Submitted as Pandora packageType. */}
        {packagePrefill && (
          <div
            className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 mb-6"
            style={{
              backgroundColor: `${accent}18`,
              border: `1px solid ${accent}60`,
            }}
          >
            <span style={{ color: accent, fontSize: "10px", letterSpacing: "2px" }} className="uppercase font-bold">
              Package
            </span>
            <span className="text-white text-sm font-medium">{packagePrefill}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5 lg:space-y-6">
          {/* ── Step 1: Basics ─────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <Field label="Location">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1">
                  {CENTERS.map((c) => {
                    const active = selectedCenter === c.key;
                    return (
                      <button
                        type="button"
                        key={c.key}
                        onClick={() => setSelectedCenter(c.key)}
                        className="text-left p-3 rounded-lg transition-colors cursor-pointer"
                        style={{
                          border: active ? `1.78px solid ${accent}` : "1px solid rgba(255,255,255,0.15)",
                          backgroundColor: active ? `${accent}18` : "rgba(255,255,255,0.03)",
                        }}
                      >
                        <div
                          className="font-bold"
                          style={{ color: active ? accent : "#ffffff", fontSize: "13px", lineHeight: 1.25 }}
                        >
                          {active ? "✓ " : ""}{c.label}
                        </div>
                        <div className="text-white/55" style={{ fontSize: "11px", marginTop: "2px", lineHeight: 1.35 }}>
                          {c.subtitle}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              </div>
            </>
          )}

          {/* ── Step 2: When & Activities ──────────────────────────────── */}
          {step === 2 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

              <Field label="Interested in">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-1">
                  {ACTIVITIES.map((a) => {
                    const selected = activityInterest.includes(a.value);
                    return (
                      <button
                        type="button"
                        key={a.value}
                        onClick={() => toggleActivity(a.value)}
                        className="min-h-11 px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center leading-tight"
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

              <Field label="Anything else we should know?">
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Dietary needs, age range, special occasions, timing flexibility…"
                  className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-4 py-3 text-white font-body text-sm placeholder:text-white/30 focus:outline-none transition-colors resize-y"
                />
              </Field>
            </>
          )}

          {/* ── Step 3: Contact ────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 lg:gap-6">
                <Field label="Contact by">
                  <div className="grid grid-cols-3 gap-2 mt-1">
                    {CONTACT_METHODS.map((m) => {
                      const selected = preferredContactMethod === m.value;
                      return (
                        <button
                          type="button"
                          key={m.value}
                          onClick={() => setPreferredContactMethod(m.value)}
                          className="h-11 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center"
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
                          className="h-11 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer text-center"
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
              </div>
            </>
          )}

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

          {/* Step nav */}
          <div className="flex flex-col-reverse sm:flex-row gap-3 pt-4">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
                className="flex-1 px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                style={{ border: "1px solid rgba(255,255,255,0.15)" }}
              >
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                style={{ border: "1px solid rgba(255,255,255,0.15)" }}
              >
                Cancel
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => ((s + 1) as 1 | 2 | 3))}
                disabled={step === 1 ? !canAdvanceFromStep1 : !canAdvanceFromStep2}
                className="flex-[2] px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                style={{ backgroundColor: accent, color: accentText }}
              >
                Continue
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex-[2] px-6 py-3.5 rounded-full font-body font-bold text-sm uppercase tracking-wider transition-all hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                style={{ backgroundColor: accent, color: accentText }}
              >
                {submitting ? "Sending..." : "Submit inquiry"}
              </button>
            )}
          </div>

          <p className="text-xs text-white/40 text-center pt-2">
            We&apos;ll text &amp; email you within a business day. No spam, just event planning.
          </p>
        </form>
      </div>

      {/* Kids-birthday + karting warning.
          Karting requires 13+ and 59" tall, so organized kids parties
          don't combine with it. Offer: remove karting, submit an HP
          kids-party request, or self-book on /book. */}
      {showKidsKartingWarning && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4 overflow-y-auto"
          style={{ backgroundColor: "rgba(0,4,24,0.88)" }}
          {...modalBackdropProps(() => {
            setKidsKartingAck(true);
            setShowKidsKartingWarning(false);
          })}
        >
          <div
            className="relative w-full max-w-xl rounded-xl my-8"
            style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(255,193,7,0.5)" }}
          >
            <button
              type="button"
              onClick={() => { setKidsKartingAck(true); setShowKidsKartingWarning(false); }}
              aria-label="Close dialog"
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <div className="p-6 sm:p-8">
              <div
                className="uppercase font-bold mb-2"
                style={{ color: "#FFC107", fontSize: "11px", letterSpacing: "3px" }}
              >
                Important Notice
              </div>
              <h3
                className="font-heading font-black uppercase italic text-white mb-4"
                style={{ fontSize: "clamp(22px, 4vw, 30px)", lineHeight: 1.15, letterSpacing: "-0.3px" }}
              >
                {fastTraxCenter ? "Kids Birthday at FastTrax" : "Kids Birthday + Karting"}
              </h3>
              <div className="space-y-3 font-body text-white/80" style={{ fontSize: "14px", lineHeight: 1.6 }}>
                <p>
                  {fastTraxCenter
                    ? "FastTrax does not offer organized kids birthday party packages. Our karting-centered experience has strict driver requirements — age 13+ and minimum 59\" tall — which doesn't fit the mixed-age groups that typically come with a kids party."
                    : "Karting has strict driver requirements — age 13+ and minimum 59\" tall — that don't fit the mixed-age groups that typically come with a kids party. Adding karting to an organized kids birthday usually means splitting the group across Junior vs. Adult race types."}
                </p>
                <p>
                  In group settings this can create situations where
                  participants do not qualify for the same kart class,
                  resulting in groups being split across Junior vs. Adult
                  race types.
                </p>
                <p>
                  Please review our race requirements at{" "}
                  <a
                    href="https://fasttraxent.com/racing"
                    className="underline hover:text-white"
                    style={{ color: "#00E2E5" }}
                  >
                    fasttraxent.com/racing
                  </a>
                  . If you&apos;d like to handle karting on your own, you can
                  self-book anytime at{" "}
                  <a
                    href="https://fasttraxent.com/book"
                    className="underline hover:text-white"
                    style={{ color: "#00E2E5" }}
                  >
                    fasttraxent.com/book
                  </a>
                  .
                </p>
                <div
                  className="mt-4 p-4 rounded-lg"
                  style={{ backgroundColor: "rgba(253,91,86,0.08)", border: "1px solid rgba(253,91,86,0.3)" }}
                >
                  <div
                    className="uppercase font-bold mb-1"
                    style={{ color: "#fd5b56", fontSize: "10px", letterSpacing: "2.5px" }}
                  >
                    Looking for an organized kids party?
                  </div>
                  <p className="text-white/85" style={{ fontSize: "14px", lineHeight: 1.55 }}>
                    HeadPinz Fort Myers runs organized kids birthday packages
                    (bowling, laser tag, arcade). Use the button below to
                    switch this request to HeadPinz, or open the HeadPinz
                    birthday packages page.
                  </p>
                </div>
              </div>

              <div className="mt-6 flex flex-col sm:flex-row flex-wrap gap-2">
                {fastTraxCenter ? (
                  <button
                    type="button"
                    onClick={switchToHpFtMyers}
                    className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full transition-transform hover:scale-[1.02] text-center leading-tight"
                    style={{ backgroundColor: "#00E2E5", color: "#000418" }}
                  >
                    Switch to HeadPinz FM
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={removeKarting}
                    className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full transition-transform hover:scale-[1.02] text-center leading-tight"
                    style={{ backgroundColor: "#00E2E5", color: "#000418" }}
                  >
                    Remove karting
                  </button>
                )}
                <a
                  href={hpKidsPartyHref}
                  className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full transition-transform hover:scale-[1.02] no-underline text-center leading-tight"
                  style={{ backgroundColor: "#fd5b56", color: "#ffffff" }}
                >
                  HeadPinz kids party
                </a>
                <button
                  type="button"
                  onClick={() => { setKidsKartingAck(true); setShowKidsKartingWarning(false); }}
                  className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors text-center leading-tight"
                >
                  Keep my choices
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Short-notice warning — VIP group events need lead time.
          Fires when preferredDate is <3 days out. Offers: keep the
          date (ack + continue), or book online (no planner needed). */}
      {showShortNoticeWarning && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4 overflow-y-auto"
          style={{ backgroundColor: "rgba(0,4,24,0.88)" }}
          {...modalBackdropProps(() => {
            setShortNoticeAck(true);
            setShowShortNoticeWarning(false);
          })}
        >
          <div
            className="relative w-full max-w-xl rounded-xl my-8"
            style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(255,193,7,0.5)" }}
          >
            <button
              type="button"
              onClick={() => { setShortNoticeAck(true); setShowShortNoticeWarning(false); }}
              aria-label="Close dialog"
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <div className="p-6 sm:p-8">
              <div
                className="uppercase font-bold mb-2"
                style={{ color: "#FFC107", fontSize: "11px", letterSpacing: "3px" }}
              >
                Short Notice
              </div>
              <h3
                className="font-heading font-black uppercase italic text-white mb-4"
                style={{ fontSize: "clamp(22px, 4vw, 30px)", lineHeight: 1.15, letterSpacing: "-0.3px" }}
              >
                Booking within 3 days
              </h3>
              <div className="space-y-3 font-body text-white/80" style={{ fontSize: "14px", lineHeight: 1.6 }}>
                <p>
                  We may not be able to accommodate your request on such
                  short notice. Our VIP events require planning to make
                  your experience the best one.
                </p>
                <p>
                  If you need something today, our online booking is
                  available same-day for self-serve lanes, karts, and
                  attractions.
                </p>
              </div>

              <div className="mt-6 flex flex-col sm:flex-row flex-wrap gap-2">
                <a
                  href={onlineBookingHref}
                  className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full transition-transform hover:scale-[1.02] no-underline text-center leading-tight"
                  style={{ backgroundColor: "#00E2E5", color: "#000418" }}
                >
                  Book online instead
                </a>
                <button
                  type="button"
                  onClick={() => { setShortNoticeAck(true); setShowShortNoticeWarning(false); }}
                  className="flex-1 inline-flex items-center justify-center font-body font-bold text-sm uppercase tracking-wider px-5 py-3 rounded-full text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors text-center leading-tight"
                >
                  Keep my date
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
  // Fixed h-11 (44px) so inputs align with our button groups on the same row.
  return `w-full h-11 bg-[#0a1628] border border-white/20 rounded-lg px-4 text-white font-body text-sm placeholder:text-white/30 focus:outline-none transition-colors`;
  // note: `accent` used elsewhere (select options bg); the focus-border is
  // handled inline for simplicity because per-component dynamic Tailwind
  // JIT strings don't work well with runtime values.
  void accent;
}
