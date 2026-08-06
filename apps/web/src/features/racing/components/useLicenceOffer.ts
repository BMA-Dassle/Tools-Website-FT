"use client";

import { useEffect, useState } from "react";

export interface OfferRacer {
  personId: string;
  name: string;
  qr: string | null;
  isYou: boolean;
  addUrl: string | null;
  hubUrl: string | null;
}

/**
 * One fetch of the booking's licence offer, shared by every component that
 * needs it.
 *
 * The express-lane banner sits at the TOP of the page and says "below", while
 * the card it points at sits under the heat tiles — so both have to agree on
 * whether there is anything to offer, or the banner promises something that
 * isn't there. They are far apart in a 3,600-line page, so rather than thread
 * state through it, both call this and the module-level cache collapses them
 * into a single request.
 *
 * In-flight requests are deduped too: mounting the banner and the card in the
 * same tick must not warm the login-code cache twice.
 */
const cache = new Map<string, OfferRacer[]>();
const inflight = new Map<string, Promise<OfferRacer[]>>();
/** Whether the booking has race participants at all — see the endpoint. */
const racingCache = new Map<string, boolean>();

/**
 * A pack key is EITHER a booking id (all digits) or signed waiver grants
 * (`g=…`, minted by the signature route — see licence-grant.ts). Callers that
 * have a booking keep passing a bare billId and nothing about them changes.
 */
export function packQuery(key: string): string {
  return key.startsWith("g=") ? key : `billId=${encodeURIComponent(key)}`;
}

async function load(key: string): Promise<OfferRacer[]> {
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const p = fetch(`/api/racing/licence-offer?${packQuery(key)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const racers: OfferRacer[] = Array.isArray(j?.racers) ? j.racers : [];
      cache.set(key, racers);
      racingCache.set(key, j?.isRacing === true);
      return racers;
    })
    .catch(() => [] as OfferRacer[])
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/** `null` while unresolved — callers render nothing rather than flashing an
 *  offer that may turn out to be empty.
 *
 *  `key` is a booking id or a `g=…` grant bundle; see `packQuery`. */
export function useLicenceOffer(key: string | null | undefined): OfferRacer[] | null {
  const [racers, setRacers] = useState<OfferRacer[] | null>(() =>
    key ? (cache.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    load(key).then((r) => {
      if (!cancelled) setRacers(r);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return racers;
}

/** Data-driven "is this a racing booking", for surfaces that would otherwise
 *  rely on a sessionStorage flag written during checkout. Always false for a
 *  waiver pack — signing a waiver says nothing about whether you are racing. */
export function useIsRacingBooking(key: string | null | undefined): boolean {
  const racers = useLicenceOffer(key);
  if (!key || !racers) return false;
  return racingCache.get(key) === true;
}
