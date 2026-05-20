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
  | { kind: "picking_reward" } // survey submitted, waiting on the user's reward pick
  | { kind: "issuing_reward"; kind2: RewardKind }
  | { kind: "reward_issued"; reward: RewardSummary }
  | { kind: "error"; message: string };

type RewardKind = "pinz" | "gift_card";

interface RewardSummary {
  kind: RewardKind;
  value: number;
  displayText: string;
  promoCode?: string;
  newBalance?: number;
}

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

  // Scroll to top on every step transition past the form (reward picker,
  // reward issued, error) so the user sees the new screen.
  useEffect(() => {
    if (
      submitState.kind === "picking_reward" ||
      submitState.kind === "reward_issued" ||
      submitState.kind === "error"
    ) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [submitState.kind]);

  async function pickReward(kind: RewardKind) {
    setSubmitState({ kind: "issuing_reward", kind2: kind });
    try {
      const res = await fetch(`/api/surveys/${encodeURIComponent(token)}/reward`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setSubmitState({
          kind: "error",
          message: errBody.error || `Reward request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as {
        reward: {
          kind: RewardKind;
          value: number;
          displayText: string;
          promoCode?: string;
          newBalance?: number;
        };
      };
      setSubmitState({ kind: "reward_issued", reward: data.reward });
    } catch (err) {
      setSubmitState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  const visible = useMemo(() => visibleQuestions(questions, answers), [questions, answers]);
  const answeredCount = visible.filter((q) => answers[String(q.id)] != null).length;
  const canSubmit = answeredCount > 0 && submitState.kind === "idle";

  function setAnswer(id: number, value: AnswerMap[string]) {
    setAnswers((prev) => ({ ...prev, [String(id)]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitState.kind !== "idle" && submitState.kind !== "error") return;
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
      setSubmitState({ kind: "picking_reward" });
    } catch (err) {
      setSubmitState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  if (submitState.kind === "picking_reward" || submitState.kind === "issuing_reward") {
    return (
      <Shell>
        <RewardPicker
          centerName={centerName}
          loading={submitState.kind === "issuing_reward"}
          loadingKind={submitState.kind === "issuing_reward" ? submitState.kind2 : null}
          onPick={pickReward}
        />
      </Shell>
    );
  }

  if (submitState.kind === "reward_issued") {
    return (
      <Shell>
        <RewardConfirmation reward={submitState.reward} centerName={centerName} />
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

// ─────────────────────────────────────────────────────────────────
// Reward picker (PR-GS3) — replaces the old "Thanks!" panel after submit
// ─────────────────────────────────────────────────────────────────

interface RewardPickerProps {
  centerName: string;
  loading: boolean;
  loadingKind: RewardKind | null;
  onPick: (kind: RewardKind) => void;
}

function RewardPicker({ centerName, loading, loadingKind, onPick }: RewardPickerProps) {
  return (
    <div>
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-bold leading-tight">Thanks for your feedback!</h1>
        <p className="text-sm mt-2" style={{ color: HP_TEXT_MUTED }}>
          Pick your reward — we&apos;ll send it as soon as you tap.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RewardCard
          title="500 Pinz"
          body="~$5 toward your next visit"
          subBody="We'll enroll you in HeadPinz Rewards if you're not already a member."
          disabled={loading}
          loading={loadingKind === "pinz"}
          onClick={() => onPick("pinz")}
        />
        <RewardCard
          title="$5 e-gift card"
          body="Redeem at the bar or front desk"
          subBody=" "
          disabled={loading}
          loading={loadingKind === "gift_card"}
          onClick={() => onPick("gift_card")}
        />
      </div>

      <p className="text-xs mt-6 text-center" style={{ color: HP_TEXT_MUTED }}>
        See you at {centerName} soon.
      </p>
    </div>
  );
}

function RewardCard(props: {
  title: string;
  body: string;
  subBody: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="w-full text-left rounded-xl p-5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        backgroundColor: HP_CARD,
        border: `2px solid ${props.loading ? HP_BORDER_ACTIVE : "rgba(255,255,255,0.12)"}`,
      }}
    >
      <div className="font-heading text-xl font-bold mb-1">{props.title}</div>
      <div className="text-sm text-white/85 leading-snug">{props.body}</div>
      {props.subBody.trim() ? (
        <div className="text-xs mt-3 leading-snug" style={{ color: HP_TEXT_MUTED }}>
          {props.subBody}
        </div>
      ) : null}
      {props.loading ? (
        <div
          className="text-xs mt-3 font-semibold"
          style={{ color: HP_BORDER_ACTIVE }}
          role="status"
        >
          Sending…
        </div>
      ) : null}
    </button>
  );
}

interface RewardConfirmationProps {
  reward: RewardSummary;
  centerName: string;
}

function RewardConfirmation({ reward, centerName }: RewardConfirmationProps) {
  if (reward.kind === "pinz") {
    return (
      <div>
        <h1 className="font-heading text-3xl font-bold mb-3">You got Pinz!</h1>
        <p className="text-white/85 leading-relaxed mb-2">
          <strong>{reward.value} Pinz</strong> added to your HeadPinz Rewards account.
        </p>
        {typeof reward.newBalance === "number" ? (
          <p className="text-white/70 text-sm">
            New balance: <strong className="text-white">{reward.newBalance} Pinz</strong>
          </p>
        ) : null}
        <p className="text-white/70 text-sm mt-4">
          Use them on a future visit at {centerName}. Thanks for the feedback!
        </p>
      </div>
    );
  }
  // gift_card
  return (
    <div>
      <h1 className="font-heading text-3xl font-bold mb-3">Your $5 e-gift card is on its way</h1>
      <p className="text-white/85 leading-relaxed mb-3">
        We just texted the card number and code to your phone — show it at the bar or front desk at{" "}
        {centerName}.
      </p>
      {reward.promoCode ? (
        <div
          className="rounded-lg p-4 text-center"
          style={{ backgroundColor: HP_CARD, border: `1px solid ${HP_BORDER_ACTIVE}` }}
        >
          <div className="text-xs uppercase tracking-wider mb-1" style={{ color: HP_TEXT_MUTED }}>
            Your reward code
          </div>
          <div
            className="font-heading text-2xl font-bold tracking-widest"
            style={{ color: HP_BORDER_ACTIVE }}
          >
            {reward.promoCode}
          </div>
        </div>
      ) : null}
    </div>
  );
}
