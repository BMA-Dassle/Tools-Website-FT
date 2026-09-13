"use client";

import {
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconGripVertical,
  IconPencil,
} from "@tabler/icons-react";
import { useState, type DragEvent } from "react";
import type { PublicRep } from "~/features/crm/core/contracts";
import type { AssignmentRule } from "~/features/crm/core/types";
import { RULES_TEST_IDS } from "~/features/crm/rules/contracts";
import { RULE_KIND_CHIP } from "~/features/crm/rules/labels";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import {
  moveIndex,
  reorderByDrop,
  ruleCode,
  ruleThenLabel,
  ruleWhenLabel,
  type CentreOption,
} from "./model";

/**
 * The "Rules" card body (crm-shared.js:453): one `.rule` row per rule — grip,
 * code, label + kind chip, why, when → then pills, the on/off switch, edit.
 * "drag to reorder" is real (HTML5 drag between rows) AND every row has
 * move-up / move-down buttons, so the order is reachable from the keyboard
 * (R13: no drag-only interaction). Presentational: every change is a callback.
 */
export interface RulesListProps {
  rules: AssignmentRule[];
  reps: PublicRep[];
  centres: CentreOption[];
  canEdit: boolean;
  busy: boolean;
  onToggle: (rule: AssignmentRule, enabled: boolean) => void;
  onEdit: (rule: AssignmentRule) => void;
  onReorder: (ids: string[]) => void;
}

export function RulesList({
  rules,
  reps,
  centres,
  canEdit,
  busy,
  onToggle,
  onEdit,
  onReorder,
}: RulesListProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const ids = rules.map((r) => r.id);
  const draggable = canEdit && !busy;

  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDragId(id);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overId !== id) setOverId(id);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    const from = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    setOverId(null);
    if (!from || from === id) return;
    const next = reorderByDrop(ids, from, id);
    if (next.join("|") !== ids.join("|")) onReorder(next);
  };
  const onDragEnd = () => {
    setDragId(null);
    setOverId(null);
  };
  const move = (rule: AssignmentRule, dir: -1 | 1) => {
    const next = moveIndex(ids, rule.id, dir);
    if (next.join("|") !== ids.join("|")) onReorder(next);
  };

  return (
    <div className="list" data-testid={RULES_TEST_IDS.rulesList}>
      {rules.map((r, i) => {
        const code = ruleCode(r);
        const chip = RULE_KIND_CHIP[r.kind];
        return (
          <div
            key={r.id}
            className={r.enabled ? "rule" : "rule off"}
            data-testid={RULES_TEST_IDS.rule(r.id)}
            data-dragging={dragId === r.id ? "true" : undefined}
            data-drop={overId === r.id && dragId !== r.id ? "true" : undefined}
            draggable={draggable}
            onDragStart={draggable ? (e) => onDragStart(e, r.id) : undefined}
            onDragOver={draggable ? (e) => onDragOver(e, r.id) : undefined}
            onDrop={draggable ? (e) => onDrop(e, r.id) : undefined}
            onDragEnd={draggable ? onDragEnd : undefined}
          >
            <span className="grab" aria-hidden="true">
              <IconGripVertical {...ICON} />
            </span>
            <span className="tr-id">{code}</span>
            <div className="rule-main">
              <div className="hstack">
                <b>{r.label}</b>
                <Chip kind={chip.kind}>{chip.label}</Chip>
              </div>
              {r.why ? <div className="xs muted">{r.why}</div> : null}
              <div className="hstack" style={{ marginTop: 6 }}>
                <Pill>{ruleWhenLabel(r.when, centres)}</Pill>
                <IconArrowRight {...ICON} />
                <Pill>{ruleThenLabel(r.then, reps)}</Pill>
              </div>
            </div>
            {canEdit ? (
              <span className="rule-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Move ${code} up`}
                  disabled={busy || i === 0}
                  onClick={() => move(r, -1)}
                >
                  <IconArrowUp {...ICON} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label={`Move ${code} down`}
                  disabled={busy || i === rules.length - 1}
                  onClick={() => move(r, 1)}
                >
                  <IconArrowDown {...ICON} />
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={r.enabled}
              aria-label={`Enable ${code}`}
              data-testid={RULES_TEST_IDS.ruleToggle(r.id)}
              disabled={!canEdit || busy}
              onClick={() => onToggle(r, !r.enabled)}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label={`Edit ${code}`}
              disabled={!canEdit || busy}
              onClick={() => onEdit(r)}
            >
              <IconPencil {...ICON} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
