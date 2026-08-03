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
 * HOW MANY ROUND TRIPS. Three of the four routable outcomes need ZERO network:
 * a game card, a BMI voucher, and a structurally-certain reservation handle
 * (signed URL, /s link, W-number) all go straight to their screen. A certain
 * reservation deliberately does NOT pre-resolve — the check-in flow runs the
 * same lookup on arrival and already has proper copy for every failure
 * (not found / cancelled / needs OTP) plus the phone and browse fallbacks, so
 * pre-flighting it here would only add latency and duplicate that copy.
 *
 * The single lookup is for `resolve-then-code-entry`: an `HPW` voucher (does it
 * carry a `bill_id`?) or a bare 6–16-char token (reservation short code, or a
 * coupon that merely looks like one). `ok === true` from the lookup means it IS
 * a reservation — including `reason: "needs-otp"`, which is an unproven-but-real
 * booking — so that is the whole test.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyEntryScan, type UnsupportedReason } from "./classify-entry";
import { stashEntryScan } from "./handoff";
import { lookupByScan } from "../checkin/service";
import { gameZoneCapability, type KioskConfig } from "../config";
import { kioskCheckinEnabled, kioskPromoEnabled } from "../flags";
import { voucherRedeemEnabled } from "~/features/booking/service/voucher-redeem";

/** Why the scan produced nothing — picks the toast copy. */
export type EntryScanMiss =
  | UnsupportedReason
  /** Recognised, but its destination is turned off on this kiosk. */
  | "no-destination"
  /** The lookup was rate-limited; the guest should just try again. */
  | "try-again";

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

        case "game-card":
          if (!gameZoneOn) return setMiss("no-destination");
          stashEntryScan({ target: "game-card", raw: route.raw, value: route.value });
          h.goGameCard();
          return;

        case "code-entry":
          if (!codeEntryOn) return setMiss("no-destination");
          toCodeEntry(route.value);
          return;

        case "reservation":
          if (!checkinOn) return setMiss("no-destination");
          toCheckin();
          return;

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
