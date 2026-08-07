"use client";

import { useEffect, useRef, useState } from "react";
import type { OfferRacer } from "~/features/racing/components/useLicenceOffer";
import { packQuery } from "~/features/racing/components/useLicenceOffer";

/**
 * A licence pack, optionally re-checked while the login codes arrive.
 *
 * ── The bug the polling mode exists for ─────────────────────────────────────
 * A racer's login code is written to BMI's on-prem Firebird within seconds of
 * the person being created — visible in the BMI Leisure client almost at once.
 * We read it from the Office CLOUD api, which trails Firebird. So the waiver
 * asked for the code at the single worst moment: seconds after creating the
 * person, when Office is guaranteed not to have it yet.
 *
 * `useLicenceOffer` answers once and caches, so that early "no code" answer was
 * final — the offer rendered nothing and never reconsidered, and a guest
 * standing right there with their phone out was told nothing was available.
 * (Measured 2026-08-06: a person created through the waiver had its code in
 * Firebird in ~30 s; Office lagged past that, and further while the BMI outage
 * backlog drained.)
 *
 * ── Polling is OPT-IN, and that is a hard requirement ───────────────────────
 * Only the waiver wants it. A KIOSK must never wait: it is a shared screen with
 * a queue behind it and it has to be fast, so it takes one look and shows
 * whatever is there. A new racer's licence turning up later in their visit is
 * fine (owner 2026-08-06). Default `poll: false` keeps that the easy path.
 *
 * ── Why not fix it server-side ──────────────────────────────────────────────
 * The offer endpoint runs inside a request. Holding it open to wait out a
 * vendor sync burns a serverless invocation, blocks the page, and still guesses
 * wrong when the sync is slower than the timeout. Polling from the client costs
 * nothing while it waits and lets the card fill in underneath the guest.
 *
 * Nothing here issues or bills anything — the endpoint is a read.
 */

/** Long enough to cover the propagation we have actually measured, short
 *  enough that a guest who genuinely has no code is not watched forever. */
const MAX_WAIT_MS = 90_000;
/** Gentle: the sync is seconds, not milliseconds, and every attempt is an
 *  Office round trip per uncoded racer. */
const INTERVAL_MS = 5_000;

/** Stable identity so consumers memoising on `eligible` do not rerun forever. */
const EMPTY_ROWS: OfferRacer[] = [];

export interface LicencePack {
  racers: OfferRacer[] | null;
  /** Racers who can be offered a licence right now. */
  eligible: OfferRacer[];
  /** Only ever true in polling mode: more codes are still expected. Surfaces as
   *  "setting up your licence…" rather than an empty card. */
  waiting: boolean;
}

export interface LicencePackOptions {
  /** Keep re-checking while codes are missing. See the header — kiosks must not. */
  poll?: boolean;
  /**
   * How many racers SHOULD end up with a code. Without it we cannot tell
   * "everyone who can have one, has one" from "Office is still catching up",
   * and would stop at the first partial answer.
   */
  expected?: number;
}

/** The result is stored WITH the key it belongs to, so a key change reads as
 *  "no answer yet" by derivation rather than a synchronous state reset (which
 *  is the cascading render the hooks lint flags). */
interface PackState {
  key: string;
  rows: OfferRacer[];
  settled: boolean;
}

export function useLicencePack(
  packKey: string | null | undefined,
  opts: LicencePackOptions = {},
): LicencePack {
  const { poll = false, expected } = opts;
  const [state, setState] = useState<PackState | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!packKey) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    startedAt.current = Date.now();

    const isDone = (rows: OfferRacer[]) => {
      if (!poll) return true; // one look, take what is there
      const withCode = rows.filter((r) => r.qr).length;
      const target = expected ?? rows.length;
      return (
        (rows.length > 0 && withCode >= target) || Date.now() - startedAt.current > MAX_WAIT_MS
      );
    };

    const tick = async () => {
      // A direct no-store fetch, NOT useLicenceOffer's module cache — that
      // cache is exactly what made the first empty answer permanent.
      let rows: OfferRacer[] = [];
      try {
        const res = await fetch(`/api/racing/licence-offer?${packQuery(packKey)}`, {
          cache: "no-store",
        });
        const json = res.ok ? await res.json() : null;
        rows = Array.isArray(json?.racers) ? json.racers : [];
      } catch {
        // A blip mid-wait is not an answer — keep waiting.
      }
      if (cancelled) return;

      const settled = isDone(rows);
      setState({ key: packKey, rows, settled });
      if (!settled) timer = setTimeout(tick, INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [packKey, expected, poll]);

  // Only trust an answer that belongs to the key we are being asked about.
  const current = state && packKey && state.key === packKey ? state : null;
  return {
    racers: current ? current.rows : null,
    eligible: current ? current.rows.filter((r) => r.qr) : EMPTY_ROWS,
    waiting: !!packKey && poll && !current?.settled,
  };
}
