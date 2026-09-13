/**
 * The three centres, in one record.
 *
 * THE FOURTH COPY of these constants, and a test keeps it honest. The other
 * three, each owned by the stack that reads it:
 *   1. `lib/qamf-centers.ts` — QAMF centre ids ⇄ Square location codes
 *      (HEADPINZ_FM_CENTER_ID 9172, FASTTRAX_QAMF_CENTER_ID 11542,
 *      HEADPINZ_NAPLES_CENTER_ID 3148; codes TXBSQN0FEKQ11 / LAB52GY480CJF /
 *      PPTR5G2N0QXF7).
 *   2. `lib/pandora-locations.ts` — PANDORA_LOCATION_MAP (keys `headpinz` /
 *      `fasttrax` / `naples`; the same three alphanumeric ids).
 *   3. `src/features/daily-events/constants.ts` — LOCATION_TO_CLIENT_KEY
 *      (332160, 467486 → headpinzftmyers; 332145 → headpinznaples) and
 *      LOCATION_NAMES; `lib/bmi-office-actions.ts` CLIENT_KEYS /
 *      PANDORA_LOCATION_IDS hold the same values keyed by the `fort-myers` /
 *      `fasttrax` / `naples` slug (module-private, exported only through
 *      `officeClientKeyForCenter`).
 * `centres.test.ts` asserts this file agrees with 1–3 value for value.
 *
 * FT AND HPFM SHARE ONE OFFICE TENANT (`headpinzftmyers`). A clientKey
 * therefore does NOT identify a centre; anything keyed by clientKey (the BMI
 * state map, the writes pause list) covers both Fort Myers centres at once and
 * the UI says so.
 */

import type { Centre, CentreCode, OfficeClientKey } from "./types";

export const CENTRES: Record<CentreCode, Centre> = {
  HPFM: {
    code: "HPFM",
    name: "HeadPinz Fort Myers",
    short: "HP Fort Myers",
    locationId: 332160,
    clientKey: "headpinzftmyers",
    centerCode: "fort-myers",
    pandoraLocationId: "TXBSQN0FEKQ11",
    qamfCenterId: 9172,
    sevenShiftsLocationId: 332160,
  },
  FT: {
    code: "FT",
    name: "FastTrax Fort Myers",
    short: "FastTrax",
    locationId: 467486,
    clientKey: "headpinzftmyers",
    centerCode: "fasttrax",
    pandoraLocationId: "LAB52GY480CJF",
    qamfCenterId: 11542,
    sevenShiftsLocationId: 467486,
  },
  HPN: {
    code: "HPN",
    name: "HeadPinz Naples",
    short: "HP Naples",
    locationId: 332145,
    clientKey: "headpinznaples",
    centerCode: "naples",
    pandoraLocationId: "PPTR5G2N0QXF7",
    qamfCenterId: 3148,
    sevenShiftsLocationId: 332145,
  },
};

/** Display order everywhere: Fort Myers bowling, FastTrax, Naples. */
export const CENTRE_CODES: readonly CentreCode[] = ["HPFM", "FT", "HPN"];

export const CENTRE_LIST: readonly Centre[] = CENTRE_CODES.map((c) => CENTRES[c]);

export function isCentreCode(value: unknown): value is CentreCode {
  return typeof value === "string" && (CENTRE_CODES as readonly string[]).includes(value);
}

export function centreByCode(code: CentreCode): Centre {
  return CENTRES[code];
}

/** Both Fort Myers centres for `headpinzftmyers`; Naples alone for `headpinznaples`. */
export function centresForClientKey(clientKey: OfficeClientKey | string): Centre[] {
  return CENTRE_LIST.filter((c) => c.clientKey === clientKey);
}

export function centreByLocationId(locationId: number): Centre | null {
  return CENTRE_LIST.find((c) => c.locationId === locationId) ?? null;
}

export function centreByPandoraLocationId(id: string): Centre | null {
  return CENTRE_LIST.find((c) => c.pandoraLocationId === id) ?? null;
}

/** The distinct Office tenants, in centre order. */
export const OFFICE_CLIENT_KEYS: readonly OfficeClientKey[] = ["headpinzftmyers", "headpinznaples"];
