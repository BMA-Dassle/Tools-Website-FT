"use client";

/**
 * Turns a raw entry-screen scan into a destination.
 *
 * Shared by the two hosts that mount `EntryScanListener` — `AttractScreen`
 * (its own route) and the `KioskFlow` branch that renders `KioskCategories` —
 * because the decision is identical on both and only the *navigation* differs.
 * The host supplies three `go*` callbacks; this hook owns classification, the
 * one conditional lookup, flag gating, and the toast.
 *
 * HOW MANY ROUND TRIPS. Most routable outcomes need ZERO network: a game card,
 * a BMI voucher, and a structurally-certain reservation handle (signed URL, /s
 * link, W-number) all go straight to their screen. A certain reservation
 * deliberately does NOT pre-resolve — the check-in flow runs the same lookup on
 * arrival and already has proper copy for every failure (not found / cancelled
 * / needs OTP) plus the phone and browse fallbacks, so pre-flighting it here
 * would only add latency and duplicate that copy.
 *
 * TWO outcomes must spend a lookup, both for the same reason — the payload's
 * DESTINATION is a database fact, not a code shape:
 *
 *   resolve-then-code-entry  an `HPW` voucher (does it carry a `bill_id`?) or a
 *                            bare 6–16-char token (reservation short code, or a
 *                            coupon that merely looks like one). `ok === true`
 *                            means it IS a reservation — including
 *                            `reason: "needs-otp"`, an unproven-but-real
 *                            booking — so that is the whole test.
 *   racer                    a licence/member code identifies a PERSON. Whether
 *                            that person has a booking here today decides
 *                            between check-in and sign-in, and only the server
 *                            knows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyEntryScan, type UnsupportedReason } from "./classify-entry";
import { stashEntryScan } from "./handoff";
import { lookupByScan } from "../checkin/service";
import { accountFromScan, cardIsKnown } from "../service/scanned-card";
import { gameZoneCapability, type KioskConfig } from "../config";
import { kioskCheckinEnabled, kioskPromoEnabled } from "../flags";
import { voucherRedeemEnabled } from "~/features/booking/service/voucher-redeem";

/** What the toast says — every outcome that does NOT change the screen, since
 *  a screen change is its own feedback. Mostly misses; one success. */
export type EntryScanMiss =
  | UnsupportedReason
  /** Recognised, but its destination is turned off on this kiosk. */
  | "no-destination"
  /** The lookup was rate-limited; the guest should just try again. */
  | "try-again"
  /** A racer scanned on the chooser itself: their identity is stashed for the
   *  people step, but they are already looking at the screen they need. */
  | "racer-signed-in";

export interface EntryScanRouterHost {
  config: KioskConfig | null;
  /** Override the coupon/voucher gate. Defaults to the SAME condition that
   *  opens the door elsewhere — `kioskPromoEnabled() || voucherRedeemEnabled()`
   *  (see KioskFlow's `onOpenCodeEntry`). Getting this wrong is not theoretical:
   *  defaulting to the promo flag alone made the attract screen refuse a voucher
   *  on kiosks where the code screen was perfectly reachable, because voucher
   *  redemption is on by default and promo (then) was not. `KioskFlow` passes
   *  its own value so the `?kioskPromo=1` preview opt-in is honoured too. */
  codeEntryAvailable?: boolean;
  /** Navigate to `/kiosk/checkin` (the payload is already stashed). */
  goCheckin: () => void;
  /** Open the coupon/voucher screen (the payload is already stashed). */
  goCodeEntry: () => void;
  /** Open Game Zone (the payload is already stashed). */
  goGameCard: () => void;
  /** A racer identified themselves but has no booking here today — open the
   *  activity flow so the people step can sign them in with the stashed code.
   *  Omit on hosts that have nowhere to send them; the scan then just toasts. */
  goRacerSignIn?: () => void;
}

export function useEntryScanRouter(host: EntryScanRouterHost) {
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState<EntryScanMiss | null>(null);
  /** Guards against a second scan landing mid-navigation. A ref, not `busy` —
   *  state wouldn't have flushed before the next burst arrives. */
  const routingRef = useRef(false);

  // Latest host callbacks without re-creating handleScan on every render (the
  // hosts pass inline closures). Synced in an effect, not during render —
  // `handleScan` only ever reads it from a scan callback, long after commit.
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  }, [host]);

  const clearMiss = useCallback(() => setMiss(null), []);

  const handleScan = useCallback(async (raw: string) => {
    if (routingRef.current) return;
    const h = hostRef.current;

    const checkinOn = kioskCheckinEnabled();
    const codeEntryOn = h.codeEntryAvailable ?? (kioskPromoEnabled() || voucherRedeemEnabled());
    const gameZoneOn = gameZoneCapability(h.config) !== "none";

    // NEVER log `raw` — a scan is a bearer credential (PCI-adjacent house rule
    // shared with wedge.ts and gift-card-qr.ts).
    const route = classifyEntryScan(raw);

    const toCheckin = () => {
      stashEntryScan({ target: "checkin", raw: route.raw, value: route.raw });
      h.goCheckin();
    };
    const toCodeEntry = (value: string) => {
      stashEntryScan({ target: "code-entry", raw: route.raw, value });
      h.goCodeEntry();
    };

    routingRef.current = true;
    setMiss(null);
    try {
      switch (route.kind) {
        case "unsupported":
          setMiss(route.reason);
          return;

        case "game-card": {
          if (!gameZoneOn) return setMiss("no-destination");
          // KNOWN cards only (owner 2026-08-28). The attract screen must not
          // move a guest anywhere on a card it cannot account for: an unknown
          // number used to land on the balance screen, fail there, and — on an
          // MSR kiosk — read as "looks like a new card", offering to SELL a
          // card off an unrecognised scan. Setting a new card up is now reached
          // deliberately from the New cards screen and nowhere else, so this
          // resolves and verifies FIRST and simply says "not recognised" when
          // it cannot. One lookup, and only for a card-shaped payload.
          setBusy(true);
          try {
            const acct = await accountFromScan(route.value);
            if (!acct) return setMiss("unknown");
            const known = await cardIsKnown(acct, h.config);
            if (known === "no") return setMiss("unknown");
            // "unsure" (Intercard unreachable) still routes: a lookup outage
            // must not turn a guest with a real card away at the door — the
            // balance screen re-runs it and owns the failure copy.
            stashEntryScan({ target: "game-card", raw: route.raw, value: acct });
            h.goGameCard();
          } finally {
            setBusy(false);
          }
          return;
        }

        case "code-entry":
          if (!codeEntryOn) return setMiss("no-destination");
          toCodeEntry(route.value);
          return;

        case "reservation":
          if (!checkinOn) return setMiss("no-destination");
          toCheckin();
          return;

        case "racer": {
          // A licence/member code resolves to a PERSON, so it has two possible
          // destinations and only the server can pick: check-in if they have a
          // booking here today, sign-in if they don't. `no-reservation` is the
          // second case — we know exactly who they are and they simply have
          // nothing booked, which is not a failure.
          //
          // With check-in switched off there is only one destination, so skip
          // the round trip and let the people step be the authority on whether
          // the code is real (it has its own copy for a code that resolves to
          // nobody). That is also why the sign-in toast below stays neutral.
          setBusy(true);
          const center = h.config?.center ?? "";
          const res =
            checkinOn && center
              ? await lookupByScan(center, route.raw)
              : { ok: false as const, reason: "no-reservation" as const };
          setBusy(false);

          if (res.ok) return toCheckin();
          // A cancelled booking IS theirs — check-in says so plainly.
          if (res.reason === "cancelled") return toCheckin();
          if (res.reason === "rate-limited") return setMiss("try-again");
          if (res.reason !== "no-reservation") return setMiss("unknown");

          // Known racer, nothing booked → carry the identity into the flow so
          // the people step signs them in without a second scan.
          stashEntryScan({ target: "racer", raw: route.raw, value: route.value });
          if (h.goRacerSignIn) h.goRacerSignIn();
          // No `goRacerSignIn` means the host IS the activity chooser, so there
          // is nothing to navigate to and the screen change can't be the
          // feedback — the toast has to be.
          else setMiss("racer-signed-in");
          return;
        }

        case "resolve-then-code-entry": {
          // Both possible destinations are off — don't spend a lookup.
          if (!checkinOn && !codeEntryOn) return setMiss("no-destination");

          if (checkinOn) {
            setBusy(true);
            const center = h.config?.center ?? "";
            const res = center
              ? await lookupByScan(center, route.raw)
              : { ok: false as const, reason: "invalid" as const };
            setBusy(false);

            // ok === true covers BOTH a proven match and an OTP-gated row.
            if (res.ok) return toCheckin();
            // A cancelled booking IS a reservation — send them to check-in so
            // it can say so plainly rather than quietly offering redemption.
            if (res.reason === "cancelled") return toCheckin();
            if (res.reason === "rate-limited") return setMiss("try-again");
          }

          // Not a reservation → it's a voucher or a coupon code.
          if (!codeEntryOn) return setMiss("no-destination");
          toCodeEntry(route.value);
          return;
        }
      }
    } finally {
      setBusy(false);
      routingRef.current = false;
    }
  }, []);

  /** A driver's licence went under the scanner. */
  const handleLicense = useCallback(() => {
    if (routingRef.current) return;
    setMiss("license");
  }, []);

  return { handleScan, handleLicense, busy, miss, clearMiss };
}
