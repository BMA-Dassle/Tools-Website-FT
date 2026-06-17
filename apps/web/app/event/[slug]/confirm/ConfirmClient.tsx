"use client";

import { useState } from "react";

type ScheduleItem = { label: string; time: string };

type Props = {
  slug: string;
  token: string;
  invalid: boolean;
  accent: string;
  eventTitle: string;
  dateLabel: string;
  firstName: string;
  schedule: ScheduleItem[];
  hasReservations: boolean;
  existingPhone: string;
};

/** Format a 10-digit string as (xxx) xxx-xxxx as the user types. */
function formatPhone(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function ConfirmClient({
  slug,
  token,
  invalid,
  accent,
  eventTitle,
  dateLabel,
  firstName,
  schedule,
  hasReservations,
  existingPhone,
}: Props) {
  const [phone, setPhone] = useState(formatPhone(existingPhone));
  const [consent, setConsent] = useState(true);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "");
  const eventUrl = `/event/${slug}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (digits.length < 10) {
      setError("Please enter a valid 10-digit mobile number.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/group-event/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, token, phone: digits, smsConsent: consent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save. Please try again.");
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    }
  }

  return (
    <main
      style={{ ["--accent" as string]: accent }}
      className="flex min-h-screen flex-col items-center bg-[#000418] px-5 py-10 text-white"
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

        {invalid ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
            <h2 className="text-lg font-bold">This link has expired</h2>
            <p className="mt-2 text-sm text-white/70">
              We couldn&apos;t verify this confirmation link. You can still look up your RSVP and
              add your details on the event page.
            </p>
            <a
              href={eventUrl}
              className="mt-5 inline-block rounded-full px-6 py-3 text-sm font-bold uppercase tracking-wider text-[#000418]"
              style={{ backgroundColor: "var(--accent)" }}
            >
              Go to event page
            </a>
          </div>
        ) : status === "done" ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
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
        ) : (
          <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/5 p-6">
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

            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="mt-5 w-full rounded-full px-6 py-4 text-sm font-bold uppercase tracking-wider text-[#000418] disabled:opacity-60"
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
