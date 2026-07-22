"use client";

/**
 * The phone page a guest lands on after scanning the kiosk's join QR.
 *
 * Identity reuses the exact flows the kiosk itself runs:
 *   returning → ReturningRacerLookup (OTP; no PII pre-verify)
 *   new adult → NewGuestForm → pandoraOnboardGuest
 * Both converge on the same Pandora upsert (resolves the SHORT id that
 * waiver-sign accepts — the 17-digit Office id 500s) → WaiverSigning on the
 * phone → POST the finished guest into the kiosk's join session.
 *
 * `ended` (from useJoinSession or a submit 409/410) replaces the WHOLE screen
 * no matter what step is up — that's what aborts a mid-OTP or mid-signature
 * flow when the kiosk continues, cancels, or times out.
 */
import { useRef, useState } from "react";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";
import WaiverSigning from "@/components/pandora/WaiverSigning";
import { pandoraOnboardGuest, type PandoraWaiverTemplate } from "@/lib/pandora";
import { formatPersonName, normalizeEmail } from "~/lib/helpers/name-format";
import { useJoinSession } from "./useJoinSession";
import { NewGuestForm, type NewGuestFields } from "./NewGuestForm";
import {
  ageFromDob,
  ageFromIso,
  brandLocationFor,
  buildGuestPayload,
  centerDisplayName,
  formatDobInput,
  type DraftGuest,
  type EndedReason,
  type JoinMeta,
} from "./join-helpers";

type Step =
  | { k: "choose" }
  | { k: "returning" }
  | { k: "returningDob"; person: PersonData }
  | { k: "newForm" }
  | { k: "onboarding" }
  | { k: "waiver"; draft: DraftGuest; template: PandoraWaiverTemplate }
  | { k: "submitting" }
  | { k: "success"; firstName: string }
  /** Multi-select finished: everyone who made it onto the kiosk list, plus any
   *  under-18 accounts skipped (phone flow is adults-only). */
  | { k: "batchDone"; added: string[]; skipped: string[] }
  | { k: "blockedMinor"; firstName?: string }
  | { k: "error"; message: string; retry?: () => void };

const card = "rounded-2xl border border-white/10 bg-white/5 p-5";
const primaryBtn =
  "w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-base font-bold text-[#04252b]";
const outlineBtn =
  "w-full rounded-xl border border-white/25 px-4 py-3 text-base font-bold text-white";
const ghostBtn = "w-full py-2 text-center text-sm text-white/40";

export function JoinPhoneFlow({
  code,
  initialMeta,
}: {
  code: string;
  initialMeta: JoinMeta | null;
}) {
  const session = useJoinSession(code, initialMeta);
  const { meta, ended, reconnecting, engage, setStage, disengage, end, clientId } = session;
  const [step, setStep] = useState<Step>({ k: "choose" });

  // Multi-select from ONE OTP: adults sharing a phone/email sign in together.
  // A ref (not state) because we process the queue through a chain of async
  // steps — onboard → sign waiver → submit — and React state would stale-close
  // across them. `active` gates the batch behaviour inside the shared single-
  // guest pipeline (handleVerified / submit); we stay engaged on the kiosk for
  // the whole batch and disengage only once the queue drains.
  const batchRef = useRef<{
    queue: PersonData[];
    added: string[];
    skipped: string[];
    active: boolean;
  }>({ queue: [], added: [], skipped: [], active: false });

  const brand = meta?.brand ?? "fasttrax";
  const brandLocation = brandLocationFor(brand, meta?.center);
  const stepKind = meta?.status === "open" ? meta.stepKind : "race";

  /* ── flow actions ──────────────────────────────────────────────────────── */

  const failOnboarding = (retry: () => void) =>
    setStep({
      k: "error",
      message: "We couldn't finish setting you up. Try again — or see the front desk.",
      retry,
    });

  const onboardReturning = async (person: PersonData, dobIso: string) => {
    setStep({ k: "onboarding" });
    const [first, ...rest] = person.fullName.trim().split(/\s+/);
    const cleanFirst = formatPersonName(first || person.fullName);
    const cleanLast = formatPersonName(rest.join(" "));
    const cleanEmail = normalizeEmail(person.email ?? "");
    try {
      // Same upsert the kiosk runs: resolves the SHORT Pandora id + the
      // authoritative waiver status (the OTP guarantees a dedup identity).
      const result = await pandoraOnboardGuest(
        {
          firstName: cleanFirst,
          lastName: cleanLast,
          email: cleanEmail,
          phone: person.phone || "",
          birthdate: dobIso,
        },
        brandLocation,
      );
      const draft: DraftGuest = {
        firstName: cleanFirst,
        lastName: cleanLast || undefined,
        bmiPersonId: person.personId, // 17-digit Office id — STRING, untouched
        pandoraPersonId: result.personId,
        dobIso,
        phone: person.phone || undefined,
        email: cleanEmail || undefined,
        // OTP-proven phone (phone-mode lookup only) — lets kiosk rewards skip
        // its SMS verify when this guest becomes the main contact.
        phoneVerified: person.phoneVerified || undefined,
        memberships: person.memberships,
        creditBalances: person.creditBalances,
        isNewRacer: false,
      };
      if (result.waiverValid) {
        await submit(draft);
      } else {
        setStage("waiver");
        setStep({ k: "waiver", draft, template: result.template });
      }
    } catch {
      failOnboarding(() => void onboardReturning(person, dobIso));
    }
  };

  const handleVerified = (person: PersonData) => {
    const age = ageFromIso(person.birthDate);
    if (age === null) {
      // No usable birthday on file — ask once (it also feeds the waiver).
      setStep({ k: "returningDob", person });
      return;
    }
    if (age < 18) {
      const fn = person.fullName.split(/\s+/)[0];
      // In a multi-select batch, a minor is skipped (added at the kiosk by a
      // guardian) and we move on — one under-18 account shouldn't block the
      // adults who signed in with them.
      if (batchRef.current.active) {
        batchRef.current.skipped.push(fn);
        advanceBatch();
        return;
      }
      setStep({ k: "blockedMinor", firstName: fn });
      return;
    }
    void onboardReturning(person, String(person.birthDate).slice(0, 10));
  };

  // Single returning racer (one account matched, or the login-code path) —
  // never a batch, so clear any stale batch state before the shared pipeline.
  const handleSingleVerified = (person: PersonData) => {
    batchRef.current.active = false;
    handleVerified(person);
  };

  // Start a multi-select batch: the first person runs now, the rest queue and
  // process one-by-one as each finishes onboarding + waiver + submit.
  const startBatch = (people: PersonData[]) => {
    if (people.length === 0) return;
    if (people.length === 1) {
      handleSingleVerified(people[0]);
      return;
    }
    batchRef.current = { queue: people.slice(1), added: [], skipped: [], active: true };
    handleVerified(people[0]);
  };

  // Pull the next queued person, or wrap up when the queue drains.
  const advanceBatch = () => {
    const next = batchRef.current.queue.shift();
    if (next) {
      handleVerified(next);
      return;
    }
    batchRef.current.active = false;
    disengage(); // whole batch done — stop counting this phone as in-progress
    const { added, skipped } = batchRef.current;
    if (added.length === 0) {
      setStep({ k: "blockedMinor", firstName: skipped[0] });
    } else {
      setStep({ k: "batchDone", added: [...added], skipped: [...skipped] });
    }
  };

  const onboardNew = async (fields: NewGuestFields) => {
    batchRef.current.active = false; // new-guest onboarding is never batched
    setStep({ k: "onboarding" });
    const cleanFirst = formatPersonName(fields.firstName);
    const cleanLast = formatPersonName(fields.lastName);
    const cleanEmail = normalizeEmail(fields.email ?? "");
    try {
      const result = await pandoraOnboardGuest(
        {
          firstName: cleanFirst,
          lastName: cleanLast,
          email: cleanEmail,
          phone: fields.phone,
          birthdate: fields.dobIso,
        },
        brandLocation,
      );
      const draft: DraftGuest = {
        firstName: cleanFirst,
        lastName: cleanLast || undefined,
        // New person: the short Pandora id rides BOTH fields (submitNew mirror).
        bmiPersonId: result.personId,
        pandoraPersonId: result.personId,
        dobIso: fields.dobIso,
        phone: fields.phone,
        email: cleanEmail || undefined,
        isNewRacer: true,
      };
      if (result.waiverValid) {
        await submit(draft);
      } else {
        setStage("waiver");
        setStep({ k: "waiver", draft, template: result.template });
      }
    } catch {
      failOnboarding(() => void onboardNew(fields));
    }
  };

  const submit = async (draft: DraftGuest) => {
    setStep({ k: "submitting" });
    try {
      const res = await fetch(`/api/kiosk/join/${code}/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: clientId(), guest: buildGuestPayload(draft) }),
        cache: "no-store",
      });
      if (res.ok) {
        // In a batch, record the add and move to the next person — stay engaged
        // and hold the summary until the queue drains (advanceBatch disengages).
        if (batchRef.current.active) {
          batchRef.current.added.push(draft.firstName);
          advanceBatch();
          return;
        }
        disengage();
        setStep({ k: "success", firstName: draft.firstName });
        return;
      }
      if (res.status === 409 || res.status === 410) {
        let error = "";
        try {
          error = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          /* body optional */
        }
        if (error === "full") {
          setStep({
            k: "error",
            message: "This group's list is full — see the front desk to be added.",
          });
          return;
        }
        end("moved-on"); // closed or landed-late — never an error dump
        return;
      }
      if (res.status === 404) {
        end("expired");
        return;
      }
      if (res.status === 422) {
        setStep({ k: "blockedMinor", firstName: draft.firstName });
        return;
      }
      setStep({
        k: "error",
        message:
          res.status === 429
            ? "One moment — try again in a few seconds."
            : "Something hiccuped adding you to the list. Try again.",
        retry: () => void submit(draft),
      });
    } catch {
      setStep({
        k: "error",
        message: "Connection hiccup — check your signal and try again.",
        retry: () => void submit(draft),
      });
    }
  };

  /* ── screens ───────────────────────────────────────────────────────────── */

  const body = ended ? (
    <EndedScreen reason={ended} />
  ) : !meta ? (
    <div className="flex flex-col items-center gap-4 py-16">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
      <p className="text-sm text-white/50">Finding your group…</p>
    </div>
  ) : (
    <>
      <header className="mb-6 text-center">
        <div className="text-xs font-black uppercase tracking-[0.3em] text-white/40">
          {brand === "headpinz" ? "HeadPinz" : "FastTrax"}
        </div>
        <h1 className="mt-2 text-2xl font-extrabold text-white">Join your group</h1>
        <p className="mt-1 text-sm text-white/50">
          at {centerDisplayName(meta.center, brand)} —{" "}
          {stepKind === "race" ? "Go-Kart Racing" : "Activity check-in"}
        </p>
      </header>

      {step.k === "choose" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-[#f0b341]/60 bg-[#f0b341]/10 p-4">
            <span
              aria-hidden="true"
              className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#f0b341] text-sm font-black text-[#2a1c00]"
            >
              !
            </span>
            <p className="text-sm font-semibold leading-snug text-[#f5d38a]">
              One group, one payment. Split payment isn&rsquo;t available here — your whole group
              pays together at the kiosk.
            </p>
          </div>
          <p className="text-sm text-white/50">
            Adults 18+ only. Anyone under 18 gets added at the kiosk, where an adult can sign for
            them.
          </p>
          <button
            type="button"
            className={primaryBtn}
            onClick={() => {
              engage("signing-in");
              setStep({ k: "returning" });
            }}
          >
            I&rsquo;ve been here before
          </button>
          <button
            type="button"
            className={outlineBtn}
            onClick={() => {
              engage("signing-in");
              setStep({ k: "newForm" });
            }}
          >
            I&rsquo;m new — set me up
          </button>
          <p className="text-center text-xs text-white/35">
            Takes about a minute. Your group can keep going at the kiosk.
          </p>
        </div>
      )}

      {step.k === "returning" && (
        <div className={card}>
          <ReturningRacerLookup
            onVerified={handleSingleVerified}
            onVerifiedMultiple={startBatch}
            onSwitchToNew={() => setStep({ k: "newForm" })}
            introText="Find your account — we'll text or email you a code"
            switchToNewLabel="Actually, I'm new here →"
          />
          <button
            type="button"
            className={`${ghostBtn} mt-3`}
            onClick={() => setStep({ k: "choose" })}
          >
            ← Back
          </button>
        </div>
      )}

      {step.k === "returningDob" && (
        <ReturningDobScreen
          firstName={step.person.fullName.split(/\s+/)[0]}
          onConfirm={(dob) => {
            const age = ageFromDob(dob);
            if (age === null) return "Enter your birthday as MM/DD/YYYY.";
            const fn = step.person.fullName.split(/\s+/)[0];
            if (age < 18) {
              // Batch: skip the minor and roll on to the next queued adult.
              if (batchRef.current.active) {
                batchRef.current.skipped.push(fn);
                advanceBatch();
                return null;
              }
              setStep({ k: "blockedMinor", firstName: fn });
              return null;
            }
            void onboardReturning(
              step.person,
              dob.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2"),
            );
            return null;
          }}
          onBack={() => setStep({ k: "choose" })}
        />
      )}

      {step.k === "newForm" && (
        <div className={card}>
          <h2 className="mb-4 text-lg font-bold text-white">Set yourself up</h2>
          <NewGuestForm
            busy={false}
            onSubmit={(fields) => void onboardNew(fields)}
            onMinor={(firstName) => setStep({ k: "blockedMinor", firstName })}
            onBack={() => setStep({ k: "choose" })}
          />
        </div>
      )}

      {step.k === "onboarding" && <Working label="Setting you up…" />}

      {step.k === "waiver" && (
        <div className={card}>
          <p className="mb-3 text-sm text-white/50">
            Signing for:{" "}
            <span className="font-bold text-white">
              {step.draft.firstName}
              {step.draft.lastName ? ` ${step.draft.lastName}` : ""}
            </span>
          </p>
          <WaiverSigning
            personId={step.draft.pandoraPersonId!}
            template={step.template}
            location={brandLocation}
            heading={stepKind === "race" ? "Racing Waiver" : "Activity Waiver"}
            subheading="Sign once — it covers your whole visit today."
            onComplete={() => void submit(step.draft)}
          />
        </div>
      )}

      {step.k === "submitting" && <Working label="Adding you to the group…" />}

      {step.k === "success" && (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 text-3xl font-black text-emerald-400">
            ✓
          </div>
          <h2 className="text-xl font-extrabold text-white">You&rsquo;re on the kiosk list!</h2>
          <p className="text-sm text-white/60">
            {step.firstName} has been added. Head back to your group — the kiosk shows you&rsquo;re
            in.
          </p>
          <p className="text-xs text-white/40">
            Reminder: your group pays together at the kiosk — split payment isn&rsquo;t available.
          </p>
          <button type="button" className={outlineBtn} onClick={() => setStep({ k: "choose" })}>
            Add another person
          </button>
        </div>
      )}

      {step.k === "batchDone" && (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 text-3xl font-black text-emerald-400">
            ✓
          </div>
          <h2 className="text-xl font-extrabold text-white">
            {step.added.length === 1
              ? "You're on the kiosk list!"
              : `${step.added.length} people added!`}
          </h2>
          <p className="text-sm text-white/60">
            <span className="font-bold text-white">{step.added.join(", ")}</span>
            {step.added.length === 1 ? " has" : " have"} been added. Head back to your group — the
            kiosk shows you&rsquo;re in.
          </p>
          {step.skipped.length > 0 && (
            <p className="text-xs text-[#f5d38a]">
              {step.skipped.join(", ")} {step.skipped.length === 1 ? "is" : "are"} under 18 — an
              adult can add {step.skipped.length === 1 ? "them" : "each of them"} at the kiosk.
            </p>
          )}
          <p className="text-xs text-white/40">
            Reminder: your group pays together at the kiosk — split payment isn&rsquo;t available.
          </p>
          <button type="button" className={outlineBtn} onClick={() => setStep({ k: "choose" })}>
            Add more people
          </button>
        </div>
      )}

      {step.k === "blockedMinor" && (
        <div className="space-y-4 text-center">
          <h2 className="text-xl font-extrabold text-white">Under 18? Head to the kiosk.</h2>
          <p className="text-sm text-white/60">
            Players under 18 are added at the kiosk so a parent or guardian can sign their waiver.
            Everyone 18+ can join right here.
          </p>
          <button type="button" className={outlineBtn} onClick={() => setStep({ k: "choose" })}>
            Add someone else instead
          </button>
        </div>
      )}

      {step.k === "error" && (
        <div className="space-y-4 text-center">
          <p className="text-base font-semibold text-amber-300">{step.message}</p>
          {step.retry && (
            <button type="button" className={primaryBtn} onClick={step.retry}>
              Try again
            </button>
          )}
          <button type="button" className={ghostBtn} onClick={() => setStep({ k: "choose" })}>
            Start over
          </button>
        </div>
      )}
    </>
  );

  return (
    <div
      className={`min-h-screen text-white ${
        brand === "headpinz" ? "brand-headpinz bg-[#0a1628]" : "bg-[#000418]"
      }`}
      style={{ "--accent": "#00E2E5" } as React.CSSProperties}
    >
      <main className="mx-auto max-w-md px-4 py-8">{body}</main>
      {reconnecting && !ended && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-4 py-1.5 text-xs font-semibold text-white/70">
          Reconnecting…
        </div>
      )}
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
      <p className="text-sm text-white/60">{label}</p>
    </div>
  );
}

function ReturningDobScreen({
  firstName,
  onConfirm,
  onBack,
}: {
  firstName: string;
  /** Returns an error string to show, or null when handled. */
  onConfirm: (dob: string) => string | null;
  onBack: () => void;
}) {
  const [dob, setDob] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={card}>
      <h2 className="text-lg font-bold text-white">Confirm your birthday</h2>
      <p className="mt-1 text-sm text-white/50">
        Hi {firstName} — we need it once for your waiver.
      </p>
      <input
        className="mt-4 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder-white/30 outline-none focus:border-[var(--accent)]"
        value={dob}
        onChange={(e) => setDob(formatDobInput(e.target.value))}
        placeholder="MM/DD/YYYY"
        inputMode="numeric"
        autoComplete="bday"
        aria-label="Birthday"
      />
      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-amber-300">
          {error}
        </p>
      )}
      <button
        type="button"
        className={`${primaryBtn} mt-4`}
        onClick={() => setError(onConfirm(dob))}
      >
        Continue
      </button>
      <button type="button" className={`${ghostBtn} mt-2`} onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}

function EndedScreen({ reason }: { reason: EndedReason }) {
  const copy: Record<EndedReason, { title: string; body: string }> = {
    "moved-on": {
      title: "The group moved on.",
      body: "The kiosk finished adding players before you were done. Flag your group down — they can add you right at the kiosk, or see the front desk.",
    },
    cancelled: {
      title: "This session was cancelled at the kiosk.",
      body: "Ask your group to start again, then scan the new QR code.",
    },
    expired: {
      title: "This QR code expired.",
      body: "Scan the code on the kiosk screen again to join.",
    },
    invalid: {
      title: "This link isn't valid.",
      body: "Scan the QR code on the kiosk to join your group.",
    },
  };
  const c = copy[reason];
  return (
    <div className="space-y-4 py-12 text-center">
      <h1 className="text-2xl font-extrabold text-white">{c.title}</h1>
      <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-white/60">{c.body}</p>
    </div>
  );
}
