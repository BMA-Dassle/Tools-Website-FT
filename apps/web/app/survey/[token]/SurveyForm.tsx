"use client";

import { useEffect, useMemo, useState } from "react";
import type { GuestSurveyQuestion } from "@/lib/guest-survey-db";
// Import gating from the leaf module (NOT the feature barrel) — the barrel
// re-exports service.ts which transitively pulls ioredis into the client
// bundle. ioredis uses Node-only modules (dns/fs/net/tls) and Turbopack
// fails the build.
import { visibleQuestions, type AnswerMap } from "~/features/guest-survey/gating";

/**
 * Survey brand. "headpinz" (bowling, the original/live path) and "fasttrax"
 * (racing). The form is identical in structure — only the palette, the
 * fixed-nav clearance, and a couple of loyalty-program labels differ.
 */
export type SurveyBrand = "headpinz" | "fasttrax";

interface Theme {
  /** Page background — matches the body bg the root layout sets per brand. */
  bg: string;
  /** Question / reward card panel. */
  card: string;
  /** Hairline border on cards + inputs. */
  border: string;
  /** Accent: selected pills, primary button, error text. */
  accent: string;
  /** Translucent accent fill behind selected pills. */
  accentFill: string;
  /** Muted secondary text. */
  muted: string;
  /** Tailwind top-padding that clears the brand's fixed nav. */
  navClear: string;
  /** Loyalty program name shown on the Pinz reward. */
  rewardsProgram: string;
}

const THEMES: Record<SurveyBrand, Theme> = {
  headpinz: {
    bg: "#0a1628",
    card: "rgba(7,16,39,0.95)",
    border: "rgba(255,255,255,0.08)",
    accent: "#fd5b56", // coral
    accentFill: "rgba(253,91,86,0.18)",
    muted: "rgba(255,255,255,0.65)",
    navClear: "pt-36 sm:pt-44",
    rewardsProgram: "HeadPinz Rewards",
  },
  fasttrax: {
    bg: "#000418",
    card: "rgba(10,16,36,0.92)",
    border: "rgba(255,255,255,0.08)",
    accent: "#E53935", // ft-red
    accentFill: "rgba(229,57,53,0.18)",
    muted: "rgba(255,255,255,0.65)",
    navClear: "pt-28 sm:pt-36",
    rewardsProgram: "FastTrax Rewards",
  },
};

interface SurveyFormProps {
  token: string;
  centerName: string;
  questions: GuestSurveyQuestion[];
  /** Defaults to "headpinz" so the live bowling survey is unchanged. */
  brand?: SurveyBrand;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "picking_reward"; errorMessage?: string } // survey submitted, waiting on pick (errorMessage when a prior pick failed)
  | { kind: "issuing_reward"; kind2: RewardKind }
  | { kind: "reward_issued"; reward: RewardSummary }
  | { kind: "error"; message: string };

type RewardKind = "pinz" | "gift_card";

interface RewardSummary {
  kind: RewardKind;
  value: number;
  displayText: string;
  // Pinz path
  newBalance?: number;
  // Gift-card path
  promoCode?: string;
  gan?: string;
  balanceUrl?: string;
  walletUrl?: string;
  walletShortUrl?: string;
  qrDataUrl?: string;
}

/**
 * Mobile-first guest survey form. Brand-aware (HeadPinz bowling / FastTrax
 * racing) via the `brand` prop — see THEMES above.
 *
 * Renders all currently-visible questions in a single scrollable column.
 * Gating runs live as the user answers — e.g. food_drink Q2-5 reveal once
 * Q1=Yes, and the racing slow-down explainer reveals only when the racer
 * says they didn't understand.
 */
export function SurveyForm({ token, centerName, questions, brand = "headpinz" }: SurveyFormProps) {
  const t = THEMES[brand];
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
        // Keep the user on the reward picker so they can retry the same
        // (or other) reward without losing context.
        setSubmitState({
          kind: "picking_reward",
          errorMessage: errBody.error || `Reward request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as { reward: RewardSummary };
      setSubmitState({ kind: "reward_issued", reward: data.reward });
    } catch (err) {
      setSubmitState({
        kind: "picking_reward",
        errorMessage: err instanceof Error ? err.message : "Network error",
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
      <Shell t={t}>
        <RewardPicker
          t={t}
          centerName={centerName}
          loading={submitState.kind === "issuing_reward"}
          loadingKind={submitState.kind === "issuing_reward" ? submitState.kind2 : null}
          errorMessage={
            submitState.kind === "picking_reward" ? submitState.errorMessage : undefined
          }
          onPick={pickReward}
        />
      </Shell>
    );
  }

  if (submitState.kind === "reward_issued") {
    return (
      <Shell t={t}>
        <RewardConfirmation
          t={t}
          reward={submitState.reward}
          centerName={centerName}
          token={token}
        />
      </Shell>
    );
  }

  return (
    <Shell t={t}>
      <header className="mb-7">
        <h1 className="font-heading text-3xl font-bold leading-tight">How was your visit?</h1>
        <p className="text-sm mt-2" style={{ color: t.muted }}>
          {centerName} · 60 seconds · {visible.length} question{visible.length === 1 ? "" : "s"}
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        {visible.map((q) => (
          <QuestionField
            key={q.id}
            t={t}
            question={q}
            value={answers[String(q.id)]}
            onChange={(v) => setAnswer(q.id, v)}
          />
        ))}

        {submitState.kind === "error" ? (
          <p className="text-sm" style={{ color: t.accent }} role="alert">
            {submitState.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg font-heading font-bold py-3.5 text-base text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: t.accent }}
        >
          {submitState.kind === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ t, children }: { t: Theme; children: React.ReactNode }) {
  // navClear pads past the brand's fixed nav so it doesn't overlap the page
  // heading "How was your visit?" (HeadPinzNav and the FastTrax Nav have
  // different heights — see THEMES).
  return (
    <main
      className={`text-white font-body ${t.navClear}`}
      style={{ backgroundColor: t.bg, paddingBottom: "16px" }}
    >
      <div className="w-full max-w-md mx-auto px-4">{children}</div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────
// Question renderers
// ─────────────────────────────────────────────────────────────────

interface QuestionFieldProps {
  t: Theme;
  question: GuestSurveyQuestion;
  value: AnswerMap[string];
  onChange: (v: AnswerMap[string]) => void;
}

function QuestionField({ t, question, value, onChange }: QuestionFieldProps) {
  // Plain <div> rather than <fieldset>/<legend>: the default legend
  // styling positions the label BREAKING the top border (sticking out
  // above the card) instead of sitting inside. Eric reported "questions
  // go above the question boxes" — that's this exact behavior. We get
  // grouping semantics via role + aria-labelledby on the inputs container.
  const headingId = `q-${question.id}`;
  return (
    <div
      className="rounded-xl p-4"
      style={{ backgroundColor: t.card, border: `1px solid ${t.border}` }}
    >
      <div id={headingId} className="font-heading font-semibold text-base leading-snug mb-3">
        {question.question}
      </div>
      <div role="group" aria-labelledby={headingId}>
        {question.kind === "rating_1_5" ? (
          <Rating1to5 t={t} value={value} onChange={onChange} />
        ) : question.kind === "yes_no" ? (
          <YesNo t={t} value={value} onChange={onChange} />
        ) : question.kind === "multi" ? (
          <MultiChoice t={t} choices={question.choices ?? []} value={value} onChange={onChange} />
        ) : (
          <TextInput t={t} value={value} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function pillClass(selected: boolean): string {
  return [
    "flex-1 py-3 rounded-lg font-heading font-semibold text-base",
    "transition-colors duration-150",
    selected ? "text-white" : "text-white/80",
  ].join(" ");
}

function pillStyle(t: Theme, selected: boolean): React.CSSProperties {
  return {
    border: `2px solid ${selected ? t.accent : "rgba(255,255,255,0.18)"}`,
    backgroundColor: selected ? t.accentFill : "transparent",
  };
}

function Rating1to5({
  t,
  value,
  onChange,
}: {
  t: Theme;
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
            style={pillStyle(t, selected)}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

function YesNo({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value: AnswerMap[string];
  onChange: (v: string) => void;
}) {
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
            style={pillStyle(t, selected)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function MultiChoice({
  t,
  choices,
  value,
  onChange,
}: {
  t: Theme;
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
            style={pillStyle(t, selected)}
          >
            {choice}
          </button>
        );
      })}
    </div>
  );
}

function TextInput({
  t,
  value,
  onChange,
}: {
  t: Theme;
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
        e.currentTarget.style.borderColor = t.accent;
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
  t: Theme;
  centerName: string;
  loading: boolean;
  loadingKind: RewardKind | null;
  errorMessage?: string;
  onPick: (kind: RewardKind) => void;
}

function RewardPicker({
  t,
  centerName,
  loading,
  loadingKind,
  errorMessage,
  onPick,
}: RewardPickerProps) {
  return (
    <div>
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-bold leading-tight">Thanks for your feedback!</h1>
        <p className="text-sm mt-2" style={{ color: t.muted }}>
          Pick your reward — we&apos;ll send it as soon as you tap.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-lg p-3 mb-4 text-sm"
          style={{
            backgroundColor: t.accentFill,
            border: `1px solid ${t.accent}`,
            color: "#ffd6d4",
          }}
        >
          <strong className="font-semibold">Couldn&apos;t issue that reward.</strong> {errorMessage}{" "}
          Tap again to retry, or pick the other option.
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RewardCard
          t={t}
          title="500 Pinz"
          body="~$5 toward your next visit"
          subBody={`We'll enroll you in ${t.rewardsProgram} if you're not already a member.`}
          disabled={loading}
          loading={loadingKind === "pinz"}
          onClick={() => onPick("pinz")}
        />
        <RewardCard
          t={t}
          title="$5 e-gift card"
          body="Redeem at the bar or front desk"
          subBody=" "
          disabled={loading}
          loading={loadingKind === "gift_card"}
          onClick={() => onPick("gift_card")}
        />
      </div>

      <p className="text-xs mt-6 text-center" style={{ color: t.muted }}>
        See you at {centerName} soon.
      </p>
    </div>
  );
}

function RewardCard(props: {
  t: Theme;
  title: string;
  body: string;
  subBody: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const { t } = props;
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="w-full text-left rounded-xl p-5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        backgroundColor: t.card,
        border: `2px solid ${props.loading ? t.accent : "rgba(255,255,255,0.12)"}`,
      }}
    >
      <div className="font-heading text-xl font-bold mb-1">{props.title}</div>
      <div className="text-sm text-white/85 leading-snug">{props.body}</div>
      {props.subBody.trim() ? (
        <div className="text-xs mt-3 leading-snug" style={{ color: t.muted }}>
          {props.subBody}
        </div>
      ) : null}
      {props.loading ? (
        <div className="text-xs mt-3 font-semibold" style={{ color: t.accent }} role="status">
          Sending…
        </div>
      ) : null}
    </button>
  );
}

interface RewardConfirmationProps {
  t: Theme;
  reward: RewardSummary;
  centerName: string;
  token: string;
}

function RewardConfirmation({ t, reward, centerName, token }: RewardConfirmationProps) {
  if (reward.kind === "pinz") {
    return (
      <div>
        <h1 className="font-heading text-3xl font-bold mb-3">You got Pinz!</h1>
        <p className="text-white/85 leading-relaxed mb-2">
          <strong>{reward.value} Pinz</strong> added to your {t.rewardsProgram} account.
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
  return <GiftCardConfirmation t={t} reward={reward} centerName={centerName} token={token} />;
}

function GiftCardConfirmation({
  t,
  reward,
  centerName,
  token,
}: {
  t: Theme;
  reward: RewardSummary;
  centerName: string;
  token: string;
}) {
  const [smsState, setSmsState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [smsError, setSmsError] = useState<string | undefined>();

  async function textMe() {
    if (smsState === "sending" || smsState === "sent") return;
    setSmsState("sending");
    setSmsError(undefined);
    try {
      const res = await fetch(`/api/surveys/${encodeURIComponent(token)}/reward/send-sms`, {
        method: "POST",
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setSmsError(errBody.error || `Send failed (${res.status})`);
        setSmsState("error");
        return;
      }
      setSmsState("sent");
    } catch (err) {
      setSmsError(err instanceof Error ? err.message : "Network error");
      setSmsState("error");
    }
  }

  return (
    <div>
      <h1 className="font-heading text-3xl font-bold mb-2">Your $5 e-gift card</h1>
      <p className="text-white/70 text-sm mb-5">
        Show this at the bar or front desk at {centerName}. We&apos;ll keep it on file too —
        screenshot, add to Wallet, or text it to yourself below.
      </p>

      {/* QR + GAN — bundled in one card so the GAN sits directly under
          the QR (cashier scans QR for balance check, or hand-enters the
          GAN below it at POS). */}
      {reward.qrDataUrl || reward.gan ? (
        <div
          className="rounded-xl p-5 mb-4 flex flex-col items-center"
          style={{ backgroundColor: t.card, border: `1px solid ${t.border}` }}
        >
          {reward.qrDataUrl ? (
            <>
              <div
                className="text-[10px] uppercase tracking-[0.2em] mb-3"
                style={{ color: t.muted }}
              >
                Scan to view balance
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={reward.qrDataUrl}
                alt="Gift card QR code"
                width={224}
                height={224}
                className="rounded-md bg-white p-2"
              />
            </>
          ) : null}
          {reward.gan ? (
            <div
              className="w-full mt-4 pt-4 text-center"
              style={{ borderTop: `1px solid ${t.border}` }}
            >
              <div
                className="text-[10px] uppercase tracking-[0.2em] mb-2"
                style={{ color: t.muted }}
              >
                Gift card number
              </div>
              <div className="font-mono text-xl sm:text-2xl font-semibold tracking-wider text-white">
                {reward.gan}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Promo code */}
      {reward.promoCode ? (
        <div
          className="rounded-xl p-4 mb-4 text-center"
          style={{ backgroundColor: t.accentFill, border: `1px solid ${t.accent}` }}
        >
          <div className="text-[10px] uppercase tracking-[0.2em] mb-1" style={{ color: t.muted }}>
            Reward code
          </div>
          <div
            className="font-heading text-2xl font-bold tracking-widest"
            style={{ color: t.accent }}
          >
            {reward.promoCode}
          </div>
        </div>
      ) : null}

      {/* Action buttons */}
      <div className="space-y-3">
        {reward.walletUrl ? (
          <a
            href={reward.walletUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg font-heading font-bold py-3.5 text-base text-center text-white"
            style={{ backgroundColor: t.accent }}
          >
            Add to Apple Wallet
          </a>
        ) : null}
        <button
          type="button"
          onClick={textMe}
          disabled={smsState === "sending" || smsState === "sent"}
          className="block w-full rounded-lg font-heading font-bold py-3.5 text-base text-center text-white disabled:opacity-60"
          style={{
            backgroundColor: "transparent",
            border: `2px solid ${smsState === "sent" ? "rgba(120,200,140,0.6)" : "rgba(255,255,255,0.25)"}`,
            color: smsState === "sent" ? "rgb(160,220,170)" : "white",
          }}
        >
          {smsState === "sending"
            ? "Sending…"
            : smsState === "sent"
              ? "Sent — check your texts ✓"
              : "Text this to my phone"}
        </button>
        {smsError ? (
          <p className="text-sm text-center" style={{ color: t.accent }} role="alert">
            {smsError}
          </p>
        ) : null}
      </div>

      {reward.balanceUrl ? (
        <p className="text-xs text-center mt-5" style={{ color: t.muted }}>
          Or check balance later at{" "}
          <a
            href={reward.balanceUrl}
            className="underline hover:text-white"
            target="_blank"
            rel="noopener noreferrer"
          >
            squareup.com
          </a>
        </p>
      ) : null}
    </div>
  );
}
