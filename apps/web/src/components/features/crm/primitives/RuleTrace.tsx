import type { ReactNode } from "react";
import type { RuleTraceStep } from "~/features/crm/core/types";

/**
 * `.rule-trace` (crm-shared.js:236, 460): one row per rule the engine ran —
 * id pill, label, and the note ("matched" / "did not apply" when the engine
 * left none). The rule that decided is `.final`; hits are `.hit`.
 */
export interface RuleTraceRow extends RuleTraceStep {
  /** The rule's label ("Big groups go to Marketing"). */
  label: string;
}

export interface RuleTraceProps {
  steps: RuleTraceRow[];
  finalRuleId?: string;
  /** "Why Kelsea" — the eyebrow above the rows. */
  heading?: ReactNode;
  /** Rendered under the rows (the prototype's "Edit rules ↗" link). */
  footer?: ReactNode;
  className?: string;
}

export function traceNote(step: RuleTraceStep): string {
  if (step.note) return step.note;
  return step.hit ? "matched" : "did not apply";
}

export function RuleTrace({ steps, finalRuleId, heading, footer, className }: RuleTraceProps) {
  return (
    <div className={["rule-trace", className ?? ""].filter(Boolean).join(" ")}>
      {heading ? (
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          {heading}
        </div>
      ) : null}
      {steps.map((s) => (
        <div
          key={s.ruleId}
          className={["tr-row", s.hit ? "hit" : "", finalRuleId === s.ruleId ? "final" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <span className="tr-id">{s.ruleId}</span>
          <span className="tr-l">{s.label}</span>
          <span className="tr-n">{traceNote(s)}</span>
        </div>
      ))}
      {footer ?? null}
    </div>
  );
}
