"use client";

import { useMemo, useState } from "react";
import type { GuestSurveyQuestion } from "@/lib/guest-survey-db";
import { visibleQuestions, type AnswerMap } from "~/features/guest-survey";

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
 * Mobile-first guest survey form.
 *
 * Renders all currently-visible questions in a single scrollable column.
 * Gating runs live as the user answers — fnb_service Q2-5 reveal once Q1=Yes.
 * No reward picker yet — that ships in PR-GS3.
 */
export function SurveyForm({ token, centerName, questions }: SurveyFormProps) {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

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
        <h1 className="text-2xl font-semibold mb-2">Thanks!</h1>
        <p className="text-neutral-300">
          Your feedback helps us make {centerName} better. We&apos;ll be in touch shortly with your
          reward.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">How was your visit?</h1>
        <p className="text-sm text-neutral-400 mt-1">
          {centerName} • 60 seconds • {visible.length} question
          {visible.length === 1 ? "" : "s"}
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-6">
        {visible.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={answers[String(q.id)]}
            onChange={(v) => setAnswer(q.id, v)}
          />
        ))}

        {submitState.kind === "error" ? (
          <p className="text-red-400 text-sm" role="alert">
            {submitState.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-yellow-500 text-neutral-900 font-semibold py-3 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitState.kind === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-900 text-white px-4 py-8 flex flex-col items-center">
      <div className="w-full max-w-md">{children}</div>
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
    <fieldset className="space-y-2">
      <legend className="text-base font-medium">{question.question}</legend>
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
            className={`flex-1 py-3 rounded-md border-2 ${
              selected
                ? "bg-yellow-500 border-yellow-500 text-neutral-900 font-semibold"
                : "border-neutral-700 text-neutral-200"
            }`}
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
            className={`flex-1 py-3 rounded-md border-2 ${
              selected
                ? "bg-yellow-500 border-yellow-500 text-neutral-900 font-semibold"
                : "border-neutral-700 text-neutral-200"
            }`}
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
            className={`w-full text-left px-4 py-3 rounded-md border-2 ${
              selected
                ? "bg-yellow-500 border-yellow-500 text-neutral-900 font-semibold"
                : "border-neutral-700 text-neutral-200"
            }`}
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
      className="w-full rounded-md bg-neutral-800 border-2 border-neutral-700 px-3 py-2 text-base focus:border-yellow-500 focus:outline-none"
    />
  );
}
