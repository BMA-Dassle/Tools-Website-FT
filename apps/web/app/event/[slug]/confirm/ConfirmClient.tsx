"use client";

import { useEffect, useState } from "react";
import { pandoraFetchWaiverTemplate } from "@/lib/pandora";

type ScheduleItem = { label: string; time: string };
type ConflictBundle = {
  summary: string;
  options: { value: string; label: string }[];
  resolution: string | null;
  stayWith: string | null;
};

type Props = {
  mode: "phone" | "email";
  slug: string;
  token: string;
  accent: string;
  eventTitle: string;
  dateLabel: string;
  firstName: string;
  schedule: ScheduleItem[];
  hasReservations: boolean;
  existingPhone: string;
  alreadyConfirmed?: boolean;
  conflict: ConflictBundle | null;
};

/** Format a 10-digit string as (xxx) xxx-xxxx as the user types. */
function formatPhone(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function ConfirmClient(props: Props) {
  const { mode, slug, accent, eventTitle, dateLabel } = props;
  const eventUrl = `/event/${slug}`;

  // Resolved guest context — known up front for a tokenized link; filled in
  // after the email lookup for the shortlink path.
  const [token, setToken] = useState(props.token);
  const [firstName, setFirstName] = useState(props.firstName);
  const [schedule, setSchedule] = useState<ScheduleItem[]>(props.schedule);
  const [hasReservations, setHasReservations] = useState(props.hasReservations);

  // Already fully checked in (signed + phone confirmed) → straight to "all set".
  const [view, setView] = useState<"email" | "phone" | "done">(
    props.alreadyConfirmed ? "done" : mode === "phone" ? "phone" : "email",
  );

  // Schedule-conflict resolution — captured together with the phone on the same form.
  const [conflict, setConflict] = useState<ConflictBundle | null>(props.conflict);
  const [conflictChoice, setConflictChoice] = useState(props.conflict?.resolution || "");
  const [stayWith, setStayWith] = useState(props.conflict?.stayWith || "");

  // Email-entry (shortlink) state
  const [emailInput, setEmailInput] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Phone-capture state
  const [phone, setPhone] = useState(formatPhone(props.existingPhone));
  const [consent, setConsent] = useState(true);
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, "");

  // Waiver acceptance — only for guests with a waiver-gated reservation
  // (racing/gel/laser; these are exactly the timed reservations in `schedule`,
  // so `hasReservations` doubles as "needs a waiver").
  const [waiverBody, setWaiverBody] = useState("");
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const acceptedDateLabel = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "long",
    timeStyle: "short",
  });

  // The confirm button stays greyed until the form is actually submittable:
  // a valid phone, the waiver accepted (when required), and any timing conflict
  // resolved. Mirrors the checks in submitPhone() so the button reflects them.
  const phoneEntered = digits.length >= 10;
  const waiverOk = !hasReservations || waiverAccepted;
  const conflictOk = !conflict || !!conflictChoice;
  const canSubmit = phoneEntered && waiverOk && conflictOk && status !== "submitting";

  // After confirming, jump to the top so the "You're all set" header is in view.
  useEffect(() => {
    if (view === "done") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [view]);

  // Load the waiver text once we're on the phone step and the guest has a
  // waiver-gated reservation. Non-fatal: the accept line still renders if the
  // body fails to load (the server holds the canonical terms version anyway).
  useEffect(() => {
    if (view !== "phone" || !hasReservations || waiverBody) return;
    let cancelled = false;
    pandoraFetchWaiverTemplate(35, "headpinz")
      .then((t) => {
        if (!cancelled) setWaiverBody(t.body || "");
      })
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [view, hasReservations, waiverBody]);

  async function lookupEmail(e: React.FormEvent) {
    e.preventDefault();
    const em = emailInput.trim();
    if (!em.includes("@")) {
      setLookupError("Please enter the email you RSVP'd with.");
      return;
    }
    setLookupBusy(true);
    setLookupError(null);
    try {
      const res = await fetch("/api/group-event/checkin-lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, email: em }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        setLookupError(
          "We couldn't find an RSVP for that email. Check the address or ask your event coordinator.",
        );
        return;
      }
      setToken(data.token);
      setFirstName(data.firstName || "");
      setSchedule(data.schedule || []);
      setHasReservations(!!data.hasReservations);
      setPhone(formatPhone(data.existingPhone || ""));
      setConflict(data.conflict ?? null);
      setConflictChoice(data.conflict?.resolution || "");
      setStayWith(data.conflict?.stayWith || "");
      setView(data.confirmed ? "done" : "phone");
    } catch {
      setLookupError("Something went wrong. Please try again.");
    } finally {
      setLookupBusy(false);
    }
  }

  async function submitPhone(e: React.FormEvent) {
    e.preventDefault();
    if (digits.length < 10) {
      setError("Please enter a valid 10-digit mobile number.");
      return;
    }
    if (conflict && !conflictChoice) {
      setError("Please choose how you'd like us to handle the tight timing.");
      return;
    }
    if (hasReservations && !waiverAccepted) {
      setError("Please review and accept the activity waiver to continue.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/group-event/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          token,
          phone: digits,
          smsConsent: consent,
          conflictChoice: conflict ? conflictChoice : undefined,
          stayWith: conflict ? stayWith : undefined,
          waiverAccept: hasReservations ? waiverAccepted : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save. Please try again.");
      setView("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    }
  }

  const card = "rounded-2xl border border-white/10 bg-white/5 p-6";

  // Race-day safety block — shown on the success screen. No emoji (house rule).
  const raceDay = (
    <div className="mt-5 rounded-xl border border-amber-300/25 bg-amber-400/10 p-4 text-left">
      <p className="text-xs font-bold uppercase tracking-wider text-amber-300">Before you arrive</p>
      <p className="mt-2 text-sm leading-relaxed text-white/85">
        If you&apos;re <strong>racing</strong>, the following are{" "}
        <strong>required for your safety</strong>: closed-toe shoes, hair secured back, and no loose
        clothing.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-white/85">
        Forgot your closed-toe shoes? Bowling shoes are available — FastTrax provides them at the
        track, so please don&apos;t wear them across the parking lot.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-white/85">
        Please plan to arrive about <strong>5 minutes before</strong> each scheduled time at your
        designated attraction. We&apos;ll text your check-ins.
      </p>
    </div>
  );

  return (
    <main
      style={{ ["--accent" as string]: accent }}
      className="flex min-h-screen flex-col items-center bg-[#000418] px-5 pb-10 pt-28 text-white sm:pt-32"
    >
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p
            className="text-xs font-bold uppercase tracking-[0.2em]"
            style={{ color: "var(--accent)" }}
          >
            Private Event
          </p>
          <h1 className="mt-1 text-2xl font-bold">{eventTitle}</h1>
          <p className="mt-1 text-sm text-white/60">{dateLabel}</p>
        </div>

        {view === "done" ? (
          <div className={`${card} text-center`}>
            <h2 className="text-xl font-bold">
              You&apos;re all set{firstName ? `, ${firstName}` : ""}!
            </h2>
            <p className="mt-3 text-sm text-white/80">
              We&apos;ll text your event ticket to{" "}
              <span className="font-bold" style={{ color: "var(--accent)" }}>
                {formatPhone(digits)}
              </span>{" "}
              the <strong>morning of Friday, June 19</strong> — it&apos;s your fast pass to
              check-in.
            </p>

            {schedule.length > 0 && (
              <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4 text-left">
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50">
                  Your schedule
                </p>
                <ul className="mt-2 divide-y divide-white/10">
                  {schedule.map((s, i) => (
                    <li key={i} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-white/90">{s.label}</span>
                      <span className="font-bold" style={{ color: "var(--accent)" }}>
                        {s.time}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-relaxed text-white/55">
                  Watch your texts — your e-ticket arrives the morning of the event. Show it at
                  check-in.
                </p>
              </div>
            )}

            {conflict && conflictChoice && (
              <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4 text-left">
                <p className="text-sm leading-relaxed text-white/80">
                  We noted your reschedule preference — we&apos;ll sort the timing and text you the
                  new time.
                </p>
              </div>
            )}

            {raceDay}
            {!hasReservations && (
              <p className="mt-4 border-t border-white/10 pt-4 text-sm text-white/70">
                Want to do more? It&apos;s not too late to add go-kart racing, laser tag, or gel
                blaster.{" "}
                <a
                  href={eventUrl}
                  className="font-bold underline"
                  style={{ color: "var(--accent)" }}
                >
                  Schedule your activities →
                </a>
              </p>
            )}
          </div>
        ) : view === "email" ? (
          <form onSubmit={lookupEmail} className={card}>
            <label htmlFor="hn-email" className="block text-sm font-bold">
              Check in for the event
            </label>
            <p className="mt-1 text-xs text-white/60">
              Enter the email you RSVP&apos;d with and we&apos;ll pull up your day.
            </p>
            <input
              id="hn-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@healthcareswfl.org"
              className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none placeholder:text-white/30 focus:border-[var(--accent)]"
            />
            {lookupError && <p className="mt-3 text-sm text-red-400">{lookupError}</p>}
            <button
              type="submit"
              disabled={lookupBusy}
              className="mt-5 w-full rounded-full px-6 py-4 text-sm font-bold uppercase tracking-wider text-[#000418] disabled:opacity-60"
              style={{ backgroundColor: "var(--accent)" }}
            >
              {lookupBusy ? "Looking you up…" : "Continue"}
            </button>

            {/* Walk-in path — never RSVP'd, so the lookup above won't find them.
                Send them straight to the kiosk waiver they still need to sign. */}
            <div className="mt-5 border-t border-white/10 pt-4 text-center">
              <p className="text-sm font-bold text-white/70">Didn&apos;t RSVP?</p>
              <a
                href="https://kiosk.bmileisure.com/headpinzftmyers"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block w-full rounded-full border border-white/15 px-6 py-3 text-sm font-bold uppercase tracking-wider transition-opacity hover:opacity-80"
                style={{ color: "var(--accent)" }}
              >
                Sign the waiver →
              </a>
            </div>
          </form>
        ) : (
          <form onSubmit={submitPhone} className={card}>
            {schedule.length > 0 ? (
              <>
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50">
                  Your reserved times
                </p>
                <ul className="mt-2 divide-y divide-white/10">
                  {schedule.map((s, i) => (
                    <li key={i} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-white/90">{s.label}</span>
                      <span className="font-bold" style={{ color: "var(--accent)" }}>
                        {s.time}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="my-5 h-px bg-white/10" />
              </>
            ) : (
              <p className="mb-4 text-sm text-white/70">
                You&apos;re on the guest list — and it&apos;s not too late to{" "}
                <a
                  href={eventUrl}
                  className="font-bold underline"
                  style={{ color: "var(--accent)" }}
                >
                  add an activity
                </a>
                .
              </p>
            )}

            {hasReservations && (
              <div className="mb-5">
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-white/50">
                  Activity Waiver
                </p>
                <p className="mt-1 text-xs text-white/60">
                  Go-kart racing, gel blaster, and laser tag require a signed waiver. Please review
                  and accept below.
                </p>
                <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-white/5 p-3">
                  {waiverBody ? (
                    <div
                      className="prose prose-invert max-w-none text-[11px] leading-relaxed text-white/60"
                      dangerouslySetInnerHTML={{ __html: waiverBody }}
                    />
                  ) : (
                    <p className="text-xs text-white/40">Loading waiver…</p>
                  )}
                </div>

                <label className="mt-3 flex items-start gap-2 text-xs text-white/80">
                  <input
                    type="checkbox"
                    checked={waiverAccepted}
                    onChange={(e) => setWaiverAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ accentColor: accent }}
                  />
                  <span>
                    I have read and agree to the waiver above, and I accept it electronically.
                  </span>
                </label>

                {/* Signature line — electronic acceptance, never a drawn signature. */}
                {waiverAccepted && (
                  <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                      Signature
                    </p>
                    <p className="mt-1 text-lg font-bold" style={{ color: accent }}>
                      Digitally Accepted
                    </p>
                    <p className="text-xs text-white/60">
                      {firstName ? `${firstName} · ` : ""}
                      {acceptedDateLabel}
                    </p>
                  </div>
                )}

                <div className="my-5 h-px bg-white/10" />
              </div>
            )}

            <label htmlFor="hn-phone" className="block text-sm font-bold">
              Confirm you&apos;re joining us — add your mobile number
            </label>
            <p className="mt-1 text-xs text-white/60">
              We&apos;ll text your event ticket the morning of the event.
            </p>
            <input
              id="hn-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              placeholder="(239) 555-1234"
              className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none placeholder:text-white/30 focus:border-[var(--accent)]"
            />

            <p className="mt-2 text-xs leading-relaxed text-white/45">
              Can&apos;t receive texts? You&apos;ll need to check in at{" "}
              <strong className="text-white/70">Guest Services at least 30 minutes before</strong>{" "}
              your activity to pick up a physical ticket. Add your number above to save the trip —
              we&apos;ll text it straight to you.
            </p>

            <label className="mt-3 flex items-start gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ accentColor: accent }}
              />
              <span>
                Text me my event ticket and check-in updates. Message &amp; data rates may apply.
                Reply STOP to opt out.
              </span>
            </label>

            {conflict && (
              <div className="mt-4 rounded-xl border border-amber-300/30 bg-amber-400/10 p-4 text-left">
                <p className="text-xs font-bold uppercase tracking-wider text-amber-300">
                  Heads up — tight timing
                </p>
                <p className="mt-2 text-sm leading-relaxed text-white/85">
                  We noticed {conflict.summary}. Go-kart racing is about a{" "}
                  <strong>30-minute experience</strong>, so those are too close together. How would
                  you like us to adjust?
                </p>
                <div className="mt-3 space-y-2">
                  {conflict.options.map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm text-white/85">
                      <input
                        type="radio"
                        name="conflictChoice"
                        value={o.value}
                        checked={conflictChoice === o.value}
                        onChange={() => setConflictChoice(o.value)}
                        className="h-4 w-4 shrink-0"
                        style={{ accentColor: accent }}
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
                <label htmlFor="hn-staywith" className="mt-4 block text-xs text-white/60">
                  Anyone you&apos;re trying to stay with? List their names so we keep your group
                  together.
                </label>
                <textarea
                  id="hn-staywith"
                  value={stayWith}
                  onChange={(e) => setStayWith(e.target.value)}
                  rows={2}
                  placeholder="e.g. Jane Smith, John Doe"
                  className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[var(--accent)]"
                />
              </div>
            )}

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-5 w-full rounded-full px-6 py-4 text-sm font-bold uppercase tracking-wider text-[#000418] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              style={{ backgroundColor: "var(--accent)" }}
            >
              {status === "submitting" ? "Confirming…" : "Confirm & get my ticket"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-xs text-white/40">HeadPinz Fort Myers &amp; FastTrax</p>
      </div>
    </main>
  );
}
