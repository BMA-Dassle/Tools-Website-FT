/**
 * QAMF center registry — SINGLE SOURCE OF TRUTH for the numeric QubicaAMF center
 * id ⇄ Square location code ⇄ brand mapping.
 *
 * Historically each of ~17 files carried its own 2-entry {9172,3148} table. That
 * duplication is why adding a third center (FastTrax duckpin, 11542) touches so
 * many files. New code should import from here; the legacy inline maps are being
 * migrated to reference these constants.
 *
 * IMPORTANT — the FastTrax/HeadPinz-FM overlap: FastTrax and HeadPinz Fort Myers
 * are the SAME physical complex. `CenterCode` ("fort-myers") therefore CANNOT
 * distinguish them — a FastTrax duckpin booking is identified by the item-level
 * `isDuckpin` marker, which resolves to 11542 regardless of session.center. Never
 * derive 11542 from `CenterCode` alone.
 */

/** HeadPinz Fort Myers. */
export const HEADPINZ_FM_CENTER_ID = 9172;
/** HeadPinz Naples. */
export const HEADPINZ_NAPLES_CENTER_ID = 3148;
/** FastTrax duckpin (Fort Myers complex, FastTrax Square entity). */
export const FASTTRAX_QAMF_CENTER_ID = 11542;

/** Square location ids (also used as the Neon `center_code` for bowling rows). */
export const HEADPINZ_FM_CENTER_CODE = "TXBSQN0FEKQ11";
export const HEADPINZ_NAPLES_CENTER_CODE = "PPTR5G2N0QXF7";
/** FastTrax's own Square location (Lee County). Doubles as the duckpin center_code. */
export const FASTTRAX_CENTER_CODE = "LAB52GY480CJF";

/** Lee County (FastTrax) sales-tax catalog object id, for the day-of order / quote. */
export const FASTTRAX_TAX_CATALOG_ID = "UBPQTR3W6ZKVRYFC7DXN2SJN";

/** numeric QAMF center id → Square location code (= Neon center_code). */
export const QAMF_ID_TO_CENTER_CODE: Record<number, string> = {
  [HEADPINZ_FM_CENTER_ID]: HEADPINZ_FM_CENTER_CODE,
  [HEADPINZ_NAPLES_CENTER_ID]: HEADPINZ_NAPLES_CENTER_CODE,
  [FASTTRAX_QAMF_CENTER_ID]: FASTTRAX_CENTER_CODE,
};

/** Square location code (= Neon center_code) → numeric QAMF center id. */
export const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  [HEADPINZ_FM_CENTER_CODE]: HEADPINZ_FM_CENTER_ID,
  [HEADPINZ_NAPLES_CENTER_CODE]: HEADPINZ_NAPLES_CENTER_ID,
  [FASTTRAX_CENTER_CODE]: FASTTRAX_QAMF_CENTER_ID,
};

/** Resolve a numeric QAMF center id to its Square location / center_code. */
export function qamfCenterCode(centerId: number | null | undefined): string | undefined {
  return centerId == null ? undefined : QAMF_ID_TO_CENTER_CODE[centerId];
}

/**
 * Whether a center rents/collects bowling shoes. FastTrax duckpin (11542) does
 * NOT — no shoe step, no shoe-size capture, no shoe roster/notes. Every shoe
 * surface keys off this so HeadPinz (9172/3148) is unaffected.
 */
export const centerHasShoeRental = (centerId: number | null | undefined): boolean =>
  centerId !== FASTTRAX_QAMF_CENTER_ID;

/** True for the FastTrax duckpin QAMF center. */
export const isFastTraxDuckpinCenter = (centerId: number | null | undefined): boolean =>
  centerId === FASTTRAX_QAMF_CENTER_ID;
