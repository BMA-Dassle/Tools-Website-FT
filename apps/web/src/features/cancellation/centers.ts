/**
 * Center identity normalization for the cancellation cascade.
 *
 * bowling_reservations.center_code is INCONSISTENT across eras:
 *   v1 bowling rows store Square location ids ("TXBSQN0FEKQ11"/"PPTR5G2N0QXF7");
 *   v2 unified-reserve rows store slugs ("fort-myers"/"naples").
 * Downstream systems each want a different shape: QAMF wants its numeric center
 * id, cancelBmiAttractions wants the Square location id, setProjectState wants a
 * slug — and for RACE rows the Pandora location is FastTrax (LAB52GY480CJF),
 * not the HeadPinz building the slug would resolve to. This module accepts any
 * historical center_code and hands each caller the shape it needs.
 *
 * Square location_id for order/gift-card mutations is deliberately NOT here —
 * always take it from the freshly fetched Square object (close-out rule).
 */
import type { ReservationProductKind } from "@/lib/bowling-db";
import { FASTTRAX_CENTER_CODE, FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

export type CenterSlug = "fort-myers" | "naples";

export interface CenterIdentity {
  slug: CenterSlug;
  /** QAMF numeric center id for deleteReservation. */
  qamfCenterId: number;
  /** BMI Office client key. */
  bmiClientKey: "headpinzftmyers" | "headpinznaples";
  /**
   * The slug to hand setProjectState for THIS row's BMI project. Race projects
   * live under the FastTrax Pandora location; everything else under the
   * center's HeadPinz location. (setProjectState falls back to the Office API,
   * which is location-agnostic, so a wrong-location Pandora attempt degrades
   * gracefully rather than failing the cancel.)
   */
  pandoraStateSlug: "fort-myers" | "fasttrax" | "naples";
  /** The value cancelBmiAttractions expects (a Square location id). */
  attractionCancelCenterCode: "TXBSQN0FEKQ11" | "PPTR5G2N0QXF7";
}

const SLUG_BY_CENTER_CODE: Record<string, CenterSlug> = {
  // Square location ids (v1 rows)
  TXBSQN0FEKQ11: "fort-myers", // HeadPinz Fort Myers
  LAB52GY480CJF: "fort-myers", // FastTrax (racing brand, Fort Myers building)
  PPTR5G2N0QXF7: "naples", // HeadPinz Naples
  // slugs (v2 rows)
  "fort-myers": "fort-myers",
  fasttrax: "fort-myers",
  naples: "naples",
};

export function resolveCenter(
  centerCode: string,
  productKind: ReservationProductKind,
): CenterIdentity {
  // FastTrax duckpin: QAMF-backed bowling at the FastTrax Square location. It
  // shares the FM building with HeadPinz, so center_code alone (LAB52GY480CJF)
  // collapses to fort-myers→9172 below — which would send a duckpin cancel to
  // the WRONG QAMF center. Duckpin is the only 'open' (bowling) row that uses
  // the FastTrax center_code (racing/attraction rows there are 'race'/
  // 'attraction'), so that pair uniquely identifies it → QAMF center 11542.
  if (centerCode === FASTTRAX_CENTER_CODE && productKind === "open") {
    return {
      slug: "fort-myers",
      qamfCenterId: FASTTRAX_QAMF_CENTER_ID,
      bmiClientKey: "headpinzftmyers",
      pandoraStateSlug: "fasttrax",
      attractionCancelCenterCode: "TXBSQN0FEKQ11",
    };
  }

  const slug = SLUG_BY_CENTER_CODE[centerCode];
  if (!slug) {
    console.warn(
      `[cancellation/centers] unknown center_code=${centerCode} — defaulting fort-myers`,
    );
  }
  const resolved: CenterSlug = slug ?? "fort-myers";
  if (resolved === "naples") {
    return {
      slug: "naples",
      qamfCenterId: 3148,
      bmiClientKey: "headpinznaples",
      pandoraStateSlug: "naples",
      attractionCancelCenterCode: "PPTR5G2N0QXF7",
    };
  }
  return {
    slug: "fort-myers",
    qamfCenterId: 9172,
    bmiClientKey: "headpinzftmyers",
    pandoraStateSlug: productKind === "race" ? "fasttrax" : "fort-myers",
    attractionCancelCenterCode: "TXBSQN0FEKQ11",
  };
}
