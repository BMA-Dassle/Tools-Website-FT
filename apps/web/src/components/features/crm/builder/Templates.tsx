"use client";

import { IconArchive, IconDeviceFloppy, IconTemplate } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BUILDER_TEST_IDS, type QuoteTemplate } from "~/features/crm/bmi/contracts";
import { builderKeys } from "~/features/crm/bmi/queries";
// By PATH, not through the `bmi` barrel (§5.7b): `service/templates.ts` is
// pure — its only import is a type — so it bundles for the browser cleanly,
// whereas the barrel drags in `@ft/db`, `ioredis` and `node:https`.
import { templateSummary, usageLabel } from "~/features/crm/bmi/service/templates";
import { useCrmFetch, useCrmUser } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { EmptyState } from "../primitives/States";
import { fetchTemplates } from "./queries";

/**
 * Quote templates — "start from" and "save as".
 *
 * A template carries WHAT and HOW MANY, never how much: applying one scales
 * its lines to this lead's guest count and then asks Office for each price ON
 * THIS EVENT'S DATE. A package that remembered a price would quote last
 * season's rate the first time the catalogue moved.
 *
 * `uses` is on every card on purpose. Sales asked to be able to SEE which
 * packages are stale, and "Never used" beside "Used 34 times" is the whole
 * feature — a list sorted by popularity with the count hidden tells you which
 * is first, not which is dead.
 */

export interface TemplatesProps {
  centre: string;
  guests: number;
  busy: boolean;
  canSave: boolean;
  onApply: (templateId: string) => void;
  onSave: () => void;
  onArchive: (templateId: string) => void;
}

export function Templates({
  centre,
  guests,
  busy,
  canSave,
  onApply,
  onSave,
  onArchive,
}: TemplatesProps) {
  const crmFetch = useCrmFetch();
  const { isDirector } = useCrmUser();
  const [confirming, setConfirming] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: builderKeys.templates(centre),
    queryFn: () => fetchTemplates(crmFetch, centre),
  });

  const templates: QuoteTemplate[] = templatesQ.data?.templates ?? [];

  return (
    <div className="card">
      <div className="card-h">
        <h2>Templates</h2>
        <div className="right">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canSave || busy}
            onClick={onSave}
            title={canSave ? "Save this quote as a template" : "Add a line first"}
          >
            <IconDeviceFloppy {...ICON} />
            <span className="lbl">Save as template</span>
          </button>
        </div>
      </div>

      <div className="pad stack" data-testid={BUILDER_TEST_IDS.templates}>
        {templates.length === 0 ? (
          <EmptyState icon={<IconTemplate {...ICON} />}>
            No templates yet. Build a quote and save it as one.
          </EmptyState>
        ) : (
          <div className="tpl-grid">
            {templates.map((t) => (
              <div key={t.id} className="stack" style={{ gap: 4 }}>
                <button
                  type="button"
                  className="tplc"
                  disabled={busy}
                  onClick={() => onApply(t.id)}
                  title={`Scale to ${guests} guests and price for this event's date`}
                >
                  <span className="strong">{t.name}</span>
                  <span className="xs muted">{templateSummary(t)}</span>
                  <span className="xs muted">{usageLabel(t.uses)}</span>
                  {t.centre === null ? <span className="pill">All centres</span> : null}
                </button>
                {isDirector ? (
                  confirming === t.id ? (
                    <div className="hstack" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          setConfirming(null);
                          onArchive(t.id);
                        }}
                      >
                        <span className="lbl">Confirm retire</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setConfirming(null)}
                      >
                        <span className="lbl">Cancel</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirming(t.id)}
                    >
                      <IconArchive {...ICON} />
                      <span className="lbl">Retire</span>
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="xs muted">
          Starting from a template scales its lines to {guests} guests and prices every one of them
          for this event&rsquo;s own date — weekday and weekend are different numbers, so no price
          is ever stored in a template.
        </div>
      </div>
    </div>
  );
}
