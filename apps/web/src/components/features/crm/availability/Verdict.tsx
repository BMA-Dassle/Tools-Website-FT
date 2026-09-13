"use client";

import { IconAlertTriangle, IconCheck, IconLayersSubtract } from "@tabler/icons-react";
import Link from "next/link";
import {
  AVAILABILITY_HOLD_LABEL,
  AVAILABILITY_TEST_IDS,
  type AvailabilityAlternate,
  type AvailabilityPlacement,
} from "~/features/crm/availability/contracts";
import { fmtMin } from "~/features/crm/availability/service/engine";
import { Banner } from "../primitives/Banner";
import { ICON } from "../primitives/icon-props";
import { durationLabel, holdHref, runLabel, windowLabel } from "./model";

/**
 * The verdict banner (`crm-shared.js:513`), word for word:
 *
 *   Fits. <section> lanes <a>–<b> are free <from>–<to> (<n> contiguous free in
 *   that block). Starts on an odd lane so QAMF books them as pairs.
 *
 *   Does not fit at <time>. No <need> contiguous lanes are free for <n> hours.
 *   Nearest that works: <time> (<section> <a>–<b>) · …
 *   — or "Try a shorter block or another day." when nothing within three hours
 *   works. It says nothing rather than something false.
 *
 * "Hold these lanes in BMI" opens the builder (C5), carrying the pick in the
 * URL. The builder is not built yet, so today that link lands on the CRM's own
 * "coming later" screen — which is the honest thing for it to do, and means the
 * link needs no change when C5 ships. Without a lead there is no project to
 * hold against, so the button is absent rather than dead.
 */

export interface VerdictProps {
  fits: boolean;
  need: number;
  start: number;
  dur: number;
  placement: AvailabilityPlacement | null;
  alternates: AvailabilityAlternate[];
  leadPublicId: string | null;
  crmBase: string;
  onPickStart: (start: number) => void;
}

export function Verdict({
  fits,
  need,
  start,
  dur,
  placement,
  alternates,
  leadPublicId,
  crmBase,
  onPickStart,
}: VerdictProps) {
  if (fits && placement) {
    return (
      <Banner
        tone="good"
        icon={<IconCheck {...ICON} />}
        testId={AVAILABILITY_TEST_IDS.verdict}
        className="avail-verdict"
        actions={
          leadPublicId ? (
            <Link
              className="btn btn-primary btn-sm"
              href={holdHref(crmBase, leadPublicId, placement, start)}
            >
              <IconLayersSubtract {...ICON} />{" "}
              <span className="lbl">{AVAILABILITY_HOLD_LABEL}</span>
            </Link>
          ) : undefined
        }
      >
        <b>Fits.</b> {placement.section} lanes <b>{runLabel(placement.lanes)}</b> are free{" "}
        {windowLabel(start, dur)} ({placement.run.length} contiguous free in that block). Starts on
        an odd lane so QAMF books them as pairs.
      </Banner>
    );
  }

  return (
    <Banner
      tone="warn"
      icon={<IconAlertTriangle {...ICON} />}
      testId={AVAILABILITY_TEST_IDS.verdict}
      className="avail-verdict"
    >
      <b>Does not fit at {fmtMin(start)}.</b> No {need} contiguous lanes are free for{" "}
      {durationLabel(dur)}.
      {alternates.length > 0 ? (
        <>
          {" "}
          Nearest that works:{" "}
          {alternates.map((alt, i) => (
            <span key={`${alt.start}-${alt.placement.section}`}>
              {i > 0 ? " · " : null}
              <button type="button" className="linkish" onClick={() => onPickStart(alt.start)}>
                <b>{fmtMin(alt.start)}</b>
              </button>{" "}
              ({alt.placement.section} {runLabel(alt.placement.lanes)})
            </span>
          ))}
          .
        </>
      ) : (
        " Try a shorter block or another day."
      )}
    </Banner>
  );
}
