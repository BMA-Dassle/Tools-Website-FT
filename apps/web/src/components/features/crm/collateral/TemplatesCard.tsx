"use client";

import { IconAlertTriangle, IconEdit, IconMail, IconMessage } from "@tabler/icons-react";
import type { MessageTemplate } from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS } from "~/features/crm/collateral/contracts";
import { Pill } from "../primitives/Pill";
import { EmptyState } from "../primitives/States";
import { ICON } from "../primitives/icon-props";
import { gsm7Offenders, templatePreview } from "./model";

/**
 * "Message templates" — the prototype's list at `crm-shared.js:486`: the
 * channel glyph, the name with its kind pill, and the subject-plus-body
 * preview. Tapping a row opens the editor.
 *
 * One addition the prototype could not have: a row whose SMS body is not plain
 * ASCII carries a warning triangle, and the card's header counts them. A
 * director should not have to open six templates to find the one that doubles
 * the bill — and one of the six seeded ones does.
 */
export interface TemplatesCardProps {
  templates: MessageTemplate[];
  canEdit: boolean;
  onEdit: (t: MessageTemplate) => void;
}

export function TemplatesCard({ templates, canEdit, onEdit }: TemplatesCardProps) {
  const offenders = gsm7Offenders(templates);

  return (
    <div className="card" data-testid={COLLATERAL_TEST_IDS.templatesCard}>
      <div className="card-h">
        <h2>Message templates</h2>
        {offenders.length > 0 ? (
          <div className="right">
            <span className="xs muted">
              <IconAlertTriangle {...ICON} /> {offenders.length} text
              {offenders.length === 1 ? "" : "s"} would cost double
            </span>
          </div>
        ) : null}
      </div>
      {templates.length === 0 ? (
        <EmptyState>No templates yet — run the seed, or add one.</EmptyState>
      ) : (
        <div className="list">
          {templates.map((t) => {
            const unsafe = t.kind === "sms" && t.gsm7 && !t.gsm7.ok;
            const row = (
              <>
                <span
                  className="avatar"
                  style={{ background: "var(--card2)", color: "var(--muted)" }}
                >
                  {t.kind === "sms" ? <IconMessage {...ICON} /> : <IconMail {...ICON} />}
                </span>
                <div>
                  <div className="title">
                    {t.name} <Pill>{t.kind.toUpperCase()}</Pill>
                    {unsafe ? (
                      <Pill title={`${t.gsm7?.offending} is not a plain text character`}>
                        <IconAlertTriangle {...ICON} /> costs double
                      </Pill>
                    ) : null}
                  </div>
                  <div className="meta">
                    <span style={{ whiteSpace: "normal" }}>{templatePreview(t)}</span>
                  </div>
                </div>
                {canEdit ? (
                  <div className="right">
                    <span className="btn btn-sm">
                      <IconEdit {...ICON} /> Edit
                    </span>
                  </div>
                ) : null}
              </>
            );
            return canEdit ? (
              <button
                key={t.id}
                type="button"
                className="row"
                style={{ textAlign: "left", width: "100%" }}
                onClick={() => onEdit(t)}
              >
                {row}
              </button>
            ) : (
              <div key={t.id} className="row">
                {row}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
