"use client";

import { useEffect, useState } from "react";

export interface OfferRacer {
  personId: string;
  name: string;
  qr: string | null;
  isYou: boolean;
  addUrl: string | null;
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

async function load(billId: string): Promise<OfferRacer[]> {
  const hit = cache.get(billId);
  if (hit) return hit;
  const running = inflight.get(billId);
  if (running) return running;

  const p = fetch(`/api/racing/licence-offer?billId=${encodeURIComponent(billId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const racers: OfferRacer[] = Array.isArray(j?.racers) ? j.racers : [];
      cache.set(billId, racers);
      return racers;
    })
    .catch(() => [] as OfferRacer[])
    .finally(() => {
      inflight.delete(billId);
    });

  inflight.set(billId, p);
  return p;
}

/** `null` while unresolved — callers render nothing rather than flashing an
 *  offer that may turn out to be empty. */
export function useLicenceOffer(billId: string | null | undefined): OfferRacer[] | null {
  const [racers, setRacers] = useState<OfferRacer[] | null>(() =>
    billId ? (cache.get(billId) ?? null) : null,
  );

  useEffect(() => {
    if (!billId) return;
    let cancelled = false;
    load(billId).then((r) => {
      if (!cancelled) setRacers(r);
    });
    return () => {
      cancelled = true;
    };
  }, [billId]);

  return racers;
}
