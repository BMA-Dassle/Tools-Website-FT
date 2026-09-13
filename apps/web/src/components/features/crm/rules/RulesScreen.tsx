"use client";

import { IconPlus, IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPortal } from "react-dom";
import { CENTRE_LIST } from "~/features/crm/core/centres";
import { shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import type { ScreenProps } from "~/features/crm/core/screens";
import type { AssignmentRule, CentreCode, EventType } from "~/features/crm/core/types";
import { RULES_TEST_IDS, type RulesPostBody } from "~/features/crm/rules/contracts";
import { rulesKeys } from "~/features/crm/rules/queries";
import { errorMessage } from "../lib/crm-fetch";
import { useUrlQuery } from "../lib/use-url-query";
import {
  useCrmFetch,
  useCrmSheet,
  useCrmToast,
  useCrmUser,
  useTopbarSlot,
} from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { GuestServicesCard } from "./GuestServicesCard";
import { RosterCard } from "./RosterCard";
import { RuleSheet } from "./RuleSheet";
import { RulesList } from "./RulesList";
import { SweepCard } from "./SweepCard";
import { TryLead } from "./TryLead";
import {
  applyTryPatch,
  ruleCode,
  tryFieldsFromQuery,
  tryUrlPatch,
  type CentreOption,
  type TryFields,
} from "./model";
import { fetchRules, postRules } from "./queries";

/**
 * `/admin/crm/rules` (B2) — ported from the prototype's `rules` screen
 * (crm-shared.js:445-473): the rules list (reorder · toggle · edit), the
 * roster from `crm_shifts` with the off-today override, "Try a lead" against
 * the live engine, and the sweep settings. Director-only by the nav; every
 * control is also gated on the role.
 *
 * The prototype's topbar "Save" button only toasted — here every change saves
 * as it happens, so the topbar carries "Add rule" alone.
 */

/** The prototype's default scenario (crm-shared.js:446): 42 corporate guests at HP Fort Myers. */
const TRY_DEFAULTS = { guests: "42", type: "corporate" as EventType, centre: "HPFM" as CentreCode };

const CENTRES: CentreOption[] = CENTRE_LIST.map((c) => ({ code: c.code, short: c.short }));

export default function RulesScreen({ query }: ScreenProps) {
  const { isDirector } = useCrmUser();
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const { openSheet, closeSheet } = useCrmSheet();
  const slot = useTopbarSlot();
  const qc = useQueryClient();
  const [, setUrlQuery] = useUrlQuery(query);
  // The "Try a lead" fields are COMPONENT state seeded from the URL once, and
  // mirrored back to it. Reading them straight from the query made the guests
  // box snap back to "42" the moment it was cleared — the URL helper drops an
  // empty key — so backspacing to retype a number was impossible.
  const [tryFields, setTryFields] = useState<TryFields>(() =>
    tryFieldsFromQuery(
      query,
      { ...TRY_DEFAULTS, eventDate: shiftYmd(todayEasternYmd(), 30) },
      CENTRES,
    ),
  );

  const rulesQ = useQuery({
    queryKey: rulesKeys.list(),
    queryFn: () => fetchRules(crmFetch),
  });

  const post = useMutation({
    mutationFn: (body: RulesPostBody) => postRules(crmFetch, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: rulesKeys.all }),
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const rules = rulesQ.data?.rules ?? [];
  const reps = rulesQ.data?.reps ?? [];
  const canEdit = isDirector;
  const busy = post.isPending;
  const todayYmd = todayEasternYmd();

  const onTryChange = (patch: Partial<TryFields>) => {
    const next = applyTryPatch(tryFields, patch);
    setTryFields(next);
    setUrlQuery(tryUrlPatch(next));
  };

  const openForm = (initial?: AssignmentRule) =>
    openSheet({
      title: initial ? `Edit ${ruleCode(initial)}` : "New rule",
      icon: <IconSettings {...ICON} />,
      testId: RULES_TEST_IDS.ruleSheet,
      body: (
        <RuleSheet
          initial={initial}
          reps={reps}
          centres={CENTRES}
          todayYmd={todayYmd}
          onCancel={closeSheet}
          onSubmit={async (rule) => {
            await post.mutateAsync({ action: "upsert", rule });
            closeSheet();
            toast("Rule saved");
          }}
        />
      ),
    });

  const onToggle = (rule: AssignmentRule, enabled: boolean) =>
    post.mutate(
      { action: "toggle", id: rule.id, enabled },
      { onSuccess: () => toast(`${ruleCode(rule)} ${enabled ? "on" : "off"}`) },
    );

  const onReorder = (ids: string[]) => post.mutate({ action: "reorder", ids });

  return (
    <>
      {slot && canEdit
        ? createPortal(
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => openForm()}
              disabled={!rulesQ.data}
            >
              <IconPlus {...ICON} /> <span className="lbl">Add rule</span>
            </button>,
            slot,
          )
        : null}

      <div className="rules-grid">
        <div className="stack" style={{ gap: 12 }}>
          <div className="card">
            <div className="card-h">
              <h2>Rules</h2>
              <div className="right xs muted">drag to reorder</div>
            </div>
            {rulesQ.isPending ? <LoadingState label="Loading rules…" /> : null}
            {rulesQ.isError ? (
              <div className="pad">
                <ErrorState
                  message={errorMessage(rulesQ.error)}
                  onRetry={() => void rulesQ.refetch()}
                />
              </div>
            ) : null}
            {rulesQ.data && rules.length === 0 ? (
              <EmptyState>No rules yet — run the seed from Statuses, or add one.</EmptyState>
            ) : null}
            {rulesQ.data && rules.length > 0 ? (
              <RulesList
                rules={rules}
                reps={reps}
                centres={CENTRES}
                canEdit={canEdit}
                busy={busy}
                onToggle={onToggle}
                onEdit={openForm}
                onReorder={onReorder}
              />
            ) : null}
          </div>
          <RosterCard canEdit={canEdit} />
          <GuestServicesCard canEdit={canEdit} />
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <TryLead centres={CENTRES} values={tryFields} onChange={onTryChange} />
          <SweepCard canEdit={canEdit} />
        </div>
      </div>
    </>
  );
}
