"use client";

import { useEffect, useMemo, useState } from "react";
import type { GuestSurveyQuestion } from "@/lib/guest-survey-db";
// Import gating from the leaf module (NOT the feature barrel) — the barrel
// re-exports service.ts which transitively pulls ioredis into the client
// bundle. ioredis uses Node-only modules (dns/fs/net/tls) and Turbopack
// fails the build.
import { visibleQuestions, type AnswerMap } from "~/features/guest-survey/gating";

const HP_BG = "#0a1628"; // matches body background set in root layout
const HP_CARD = "rgba(7,16,39,0.95)"; // deep navy panel
const HP_BORDER = "rgba(255,255,255,0.08)";
const HP_BORDER_ACTIVE = "#fd5b56"; // coral accent
const HP_TEXT_MUTED = "rgba(255,255,255,0.65)";

interface SurveyFormProps {
  token: string;
  centerName: string;
  questions: GuestSurveyQuestion[];
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Mobile-first guest survey form, HeadPinz-branded.
 *
 * Renders all currently-visible questions in a single scrollable column.
 * Gating runs live as the user answers — fnb_service Q2-5 reveal once Q1=Yes.
 * No reward picker yet — that ships in PR-GS3.
 */
export function SurveyForm({ token, centerName, questions }: SurveyFormProps) {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  // Scroll to top whenever the page transitions into a terminal state so the
  // user sees "Thanks!" instead of being stuck at the bottom near the submit
  // button after a long-scrolling form.
  useEffect(() => {
    if (submitState.kind === "done") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [submitState.kind]);

  const visible = useMemo(() => visibleQuestions(questions, answers), [questions, answers]);
  const answeredCount = visible.filter((q) => answers[String(q.id)] != null).length;
  const canSubmit = answeredCount > 0 && submitState.kind === "idle";

  function setAnswer(id: number, value: AnswerMap[string]) {
    setAnswers((prev) => ({ ...prev, [String(id)]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitState.kind === "submitting" || submitState.kind === "done") return;
    setSubmitState({ kind: "submitting" });
    try {
      const res = await fetch(`/api/surveys/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responses: answers }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setSubmitState({
          kind: "error",
          message: errBody.error || `Submit failed (${res.status})`,
        });
        return;
      }
      setSubmitState({ kind: "done" });
    } catch (err) {
      setSubmitState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  if (submitState.kind === "done") {
    return (
      <Shell>
        <h1 className="font-heading text-3xl font-bold mb-3">Thanks!</h1>
        <p className="text-white/80 leading-relaxed">
          Your feedback helps us make {centerName} better. We&apos;ll be in touch shortly with your
          reward.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-7">
        <h1 className="font-heading text-3xl font-bold leading-tight">How was your visit?</h1>
        <p className="text-sm mt-2" style={{ color: HP_TEXT_MUTED }}>
          {centerName} · 60 seconds · {visible.length} question{visible.length === 1 ? "" : "s"}
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        {visible.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={answers[String(q.id)]}
            onChange={(v) => setAnswer(q.id, v)}
          />
        ))}

        {submitState.kind === "error" ? (
          <p className="text-sm" style={{ color: HP_BORDER_ACTIVE }} role="alert">
            {submitState.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg font-heading font-bold py-3.5 text-base text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: HP_BORDER_ACTIVE }}
        >
          {submitState.kind === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  // pt-28 / sm:pt-36 clears the fixed HeadPinzNav rendered above — same
  // offset booking pages use (apps/web/app/hp/book/page.tsx). Without
  // this the nav overlaps the page heading "How was your visit?".
  return (
    <main
      className="text-white font-body pt-28 sm:pt-36"
      style={{ backgroundColor: HP_BG, paddingBottom: "16px" }}
    >
      <div className="w-full max-w-md mx-auto px-4">{children}</div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────
// Question renderers
// ─────────────────────────────────────────────────────────────────

interface QuestionFieldProps {
  question: GuestSurveyQuestion;
  value: AnswerMap[string];
  onChange: (v: AnswerMap[string]) => void;
}

function QuestionField({ question, value, onChange }: QuestionFieldProps) {
  return (
    <fieldset
      className="rounded-xl p-4 space-y-3"
      style={{ backgroundColor: HP_CARD, border: `1px solid ${HP_BORDER}` }}
    >
      <legend className="font-heading font-semibold text-base leading-snug px-1">
        {question.question}
      </legend>
      {question.kind === "rating_1_5" ? (
        <Rating1to5 value={value} onChange={onChange} />
      ) : question.kind === "yes_no" ? (
        <YesNo value={value} onChange={onChange} />
      ) : question.kind === "multi" ? (
        <MultiChoice choices={question.choices ?? []} value={value} onChange={onChange} />
      ) : (
        <TextInput value={value} onChange={onChange} />
      )}
    </fieldset>
  );
}

function pillClass(selected: boolean): string {
  return [
    "flex-1 py-3 rounded-lg font-heading font-semibold text-base",
    "transition-colors duration-150",
    selected ? "text-white" : "text-white/80",
  ].join(" ");
}

function pillStyle(selected: boolean): React.CSSProperties {
  return {
    border: `2px solid ${selected ? HP_BORDER_ACTIVE : "rgba(255,255,255,0.18)"}`,
    backgroundColor: selected ? "rgba(253,91,86,0.18)" : "transparent",
  };
}

function Rating1to5({
  value,
  onChange,
}: {
  value: AnswerMap[string];
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-2" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => {
        const selected = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(n)}
            className={pillClass(selected)}
            style={pillStyle(selected)}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

function YesNo({ value, onChange }: { value: AnswerMap[string]; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2" role="radiogroup">
      {["Yes", "No"].map((label) => {
        const selected = value === label;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(label)}
            className={pillClass(selected)}
            style={pillStyle(selected)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function MultiChoice({
  choices,
  value,
  onChange,
}: {
  choices: string[];
  value: AnswerMap[string];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2" role="radiogroup">
      {choices.map((choice) => {
        const selected = value === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(choice)}
            className={[
              "w-full text-left px-4 py-3 rounded-lg font-body text-base",
              "transition-colors duration-150",
              selected ? "text-white font-semibold" : "text-white/80",
            ].join(" ")}
            style={pillStyle(selected)}
          >
            {choice}
          </button>
        );
      })}
    </div>
  );
}

function TextInput({
  value,
  onChange,
}: {
  value: AnswerMap[string];
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      className="w-full rounded-lg px-3 py-2 text-base text-white placeholder-white/40 outline-none transition-colors"
      style={{
        backgroundColor: "rgba(255,255,255,0.04)",
        border: `2px solid rgba(255,255,255,0.18)`,
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = HP_BORDER_ACTIVE;
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)";
      }}
    />
  );
}
