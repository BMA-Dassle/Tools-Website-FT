"use client";

import { IconAlertTriangle, IconCalendarPlus, IconShieldExclamation } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BUILDER_TEST_IDS, type QuoteLine, type ScheduleBlock } from "~/features/crm/bmi/contracts";
import { availabilityKeys } from "~/features/crm/availability/queries";
import { useCrmFetch } from "../lib/use-crm-user";
import { fetchHeats } from "../availability/queries";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { EmptyState, LoadingState } from "../primitives/States";
import { Sheet } from "../shell/Sheet";
import { heatClass, stampFor } from "./model";

/**
 * Put one quote line onto its heats — and the screen that has to be honest
 * about a refusal.
 *
 * THE 403 IS THE WHOLE POINT OF THIS COMPONENT. Office answers an
 * over-capacity `linkSchedule` with a soft refusal —
 * `{IsQuestion:false, Kind:4, Message:"Total persons (12) is higher than the
 * capacity (0) in HP Arena…"}` — which is NOT an error page and NOT something
 * to retry. It means the heat is full. So:
 *
 *   - full heats are drawn `.full` (struck through, not clickable) BEFORE
 *     anyone presses anything, straight from `dayPlanner`'s `freePlaces`;
 *   - a refusal that comes back anyway is shown with Office's own sentence,
 *     and the picker stays open on the heats so the rep picks another;
 *   - a DIRECTOR, and only a director, gets "Force (overbook)", which re-sends
 *     the identical body with `confirm:true`. A rep never sees that button.
 *
 * Availability is the same `dayPlanner` read the availability screen uses, so
 * the two screens cannot disagree about which heat is full.
 */

export interface SchedulePickerProps {
  open: boolean;
  line: QuoteLine | null;
  centre: string;
  date: string;
  guests: number;
  lead: string;
  canForce: boolean;
  busy: boolean;
  /** Office's refusal for the last attempt, when there was one. */
  refusal: string | null;
  onClose: () => void;
  onLink: (blocks: ScheduleBlock[], force: boolean) => void;
}

export function SchedulePicker({
  open,
  line,
  centre,
  date,
  guests,
  lead,
  canForce,
  busy,
  refusal,
  onClose,
  onLink,
}: SchedulePickerProps) {
  const crmFetch = useCrmFetch();
  const [chosen, setChosen] = useState<Record<string, ScheduleBlock>>({});
  const [resourceId, setResourceId] = useState<string | undefined>(undefined);

  const heatsParams = { centre, date, guests, resourceId, lead };
  const heatsQ = useQuery({
    queryKey: availabilityKeys.heats(heatsParams),
    queryFn: () => fetchHeats(crmFetch, heatsParams),
    enabled: open,
  });

  const data = heatsQ.data;
  const selected =
    data?.resources.find((r) => r.resourceId === (resourceId ?? data.selectedResourceId)) ?? null;
  const blocks = Object.values(chosen).sort((a, b) => a.start.localeCompare(b.start));

  const toggle = (start: string, stop: string, resource: string, free: number) => {
    if (free <= 0) return;
    setChosen((prev) => {
      const next = { ...prev };
      if (next[start]) delete next[start];
      else next[start] = { resourceId: resource, start, stop, persons: guests };
      return next;
    });
  };

  return (
    <Sheet
      open={open}
      title={line ? `Schedule ${line.nameOverride ?? line.productName}` : "Schedule"}
      icon={<IconCalendarPlus {...ICON} />}
      wide
      onClose={onClose}
      testId={BUILDER_TEST_IDS.heats}
      foot={
        <div className="hstack between">
          <span className="xs muted">
            {blocks.length === 0
              ? "Pick one or more back-to-back heats"
              : `${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${guests} guests`}
          </span>
          <div className="hstack">
            {refusal && canForce ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy || blocks.length === 0}
                onClick={() => onLink(blocks, true)}
                title="Re-send with confirm:true — this overbooks the heat"
              >
                <IconShieldExclamation {...ICON} />
                <span className="lbl">Force (overbook)</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || blocks.length === 0}
              onClick={() => onLink(blocks, false)}
            >
              <span className="lbl">Link in BMI</span>
            </button>
          </div>
        </div>
      }
    >
      <div className="stack">
        {refusal ? (
          <Banner tone="warn" icon={<IconAlertTriangle {...ICON} />}>
            <b>This heat is full — pick another.</b> BMI said: {refusal}
          </Banner>
        ) : null}

        {heatsQ.isPending ? <LoadingState label="Reading the heat grid…" /> : null}

        {data && data.resources.length > 1 ? (
          <div className="field avail-field">
            <label htmlFor="builder-resource">Resource</label>
            <select
              id="builder-resource"
              className="select"
              style={{ width: "auto" }}
              value={resourceId ?? data.selectedResourceId ?? ""}
              onChange={(e) => {
                setResourceId(e.target.value);
                setChosen({});
              }}
            >
              {data.resources.map((r) => (
                <option key={r.resourceId} value={r.resourceId}>
                  {r.resourceName}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {selected && selected.capacity > 0 ? (
          <div className="hstack">
            <Chip kind={data?.firstRun ? "won" : "warn"}>
              {data?.firstRun
                ? `First run with room: ${data.firstRun[0].label} · ${data.firstRun.length} heats`
                : `No run of back-to-back heats has room for ${guests}`}
            </Chip>
          </div>
        ) : null}

        {selected && selected.blocks.length > 0 ? (
          <div className="heatgrid">
            {selected.blocks.map((b) => {
              const cls = heatClass(b.freePlaces, b.capacity);
              // `dayPlanner` reports minutes from midnight, centre-local; the
              // stamp Office wants back is the same clock with no offset.
              const startStamp = stampFor(date, b.start);
              const stopStamp = stampFor(date, b.stop);
              const picked = Boolean(chosen[startStamp]);
              return (
                <button
                  key={b.start}
                  type="button"
                  className={`heat ${cls}${picked ? " pick" : ""}`}
                  disabled={cls === "full" || busy}
                  aria-pressed={picked}
                  onClick={() => toggle(startStamp, stopStamp, selected.resourceId, b.freePlaces)}
                >
                  <b>{b.label}</b>
                  <small>
                    {b.freePlaces === 0 ? "Full" : `${b.freePlaces} of ${b.capacity} free`}
                  </small>
                </button>
              );
            })}
          </div>
        ) : heatsQ.isPending ? null : (
          <EmptyState>
            No heats are published for this day. Check the centre&rsquo;s Office day planner.
          </EmptyState>
        )}

        <div className="xs muted">
          Capacity is live from Office dayPlanner. Full heats cannot be picked; if BMI still refuses
          the link it means the heat filled between the read and the write, and the quote line keeps
          its refusal until another heat is chosen.
        </div>
      </div>
    </Sheet>
  );
}
