"use client";

import { IconPower } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TEST_IDS, type SettingsPostBody } from "~/features/crm/core/contracts";
import type { BmiWritesSetting } from "~/features/crm/core/types";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { Pill } from "../primitives/Pill";
import { ErrorState, LoadingState } from "../primitives/States";
import type { ClientKeyColumn } from "./model";
import { fetchSettings, postSetting, settingsKeys } from "./queries";

/**
 * "BMI Office writes" (crm-shared.js:478): the kill switch. The toggle is
 * labelled PAUSE — never "Enable" — because writes are ON unless somebody
 * pauses them (R4: a missing `crm_settings` row means on). Per-tenant pills
 * pause one Office server at a time (`offCentres` holds clientKeys).
 */
export interface BmiWritesCardProps {
  columns: ClientKeyColumn[];
  canEdit: boolean;
}

export function BmiWritesCard({ columns, canEdit }: BmiWritesCardProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();

  const settingsQ = useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => fetchSettings(crmFetch),
  });

  const save = useMutation({
    mutationFn: (value: BmiWritesSetting) => {
      const body: SettingsPostBody = { key: "bmi_writes", value };
      return postSetting(crmFetch, body);
    },
    onSuccess: (data, value) => {
      qc.setQueryData(settingsKeys.all, data);
      toast(
        value.enabled
          ? value.offCentres.length
            ? `BMI Office writes ON · paused at ${value.offCentres.length} centre${value.offCentres.length === 1 ? "" : "s"}`
            : "BMI Office writes ON"
          : "BMI Office writes PAUSED for all centres",
      );
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const current: BmiWritesSetting | null = settingsQ.data?.settings.bmiWrites ?? null;
  const paused = current ? !current.enabled : false;
  const busy = save.isPending;

  const setPausedAll = (next: boolean) => {
    if (!current) return;
    save.mutate({ enabled: !next, offCentres: current.offCentres });
  };

  const toggleCentre = (clientKey: string) => {
    if (!current) return;
    const off = new Set(current.offCentres);
    if (off.has(clientKey)) off.delete(clientKey);
    else off.add(clientKey);
    save.mutate({ enabled: current.enabled, offCentres: [...off] });
  };

  return (
    <div className="card">
      <div className="card-h">
        <h2>BMI Office writes</h2>
        <div className="right">
          <span className="small muted" id="crm-bmi-writes-label">
            Pause BMI writes
          </span>
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={paused}
            aria-labelledby="crm-bmi-writes-label"
            data-testid={TEST_IDS.bmiWritesToggle}
            disabled={!canEdit || !current || busy}
            onClick={() => setPausedAll(!paused)}
          />
        </div>
      </div>
      <div className="pad small stack">
        {settingsQ.isPending ? <LoadingState label="Loading the switch…" /> : null}
        {settingsQ.isError ? (
          <ErrorState
            message={errorMessage(settingsQ.error)}
            onRetry={() => void settingsQ.refetch()}
          />
        ) : null}
        {current ? (
          <>
            {paused ? (
              <Banner tone="crit" icon={<IconPower {...ICON} />}>
                BMI Office writes are paused by admin. Reps see a banner and their changes queue as
                notes until writes are back on.
              </Banner>
            ) : null}
            <div>
              When off, the CRM stops writing states, products and schedules to BMI Office. Reps see
              a banner and their changes queue as notes. Reads keep working.
            </div>
            <div className="hstack">
              {columns.map((c) => {
                const off = current.offCentres.includes(c.clientKey);
                const label = `${c.label}: ${off ? "paused" : "on"}`;
                return canEdit ? (
                  <button
                    key={c.clientKey}
                    type="button"
                    className="pill"
                    aria-pressed={off}
                    aria-label={`${off ? "Resume" : "Pause"} BMI writes at ${c.label}`}
                    disabled={busy}
                    onClick={() => toggleCentre(c.clientKey)}
                  >
                    {label}
                  </button>
                ) : (
                  <Pill key={c.clientKey}>{label}</Pill>
                );
              })}
              <span className="xs muted">Per-center switches are separate</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
