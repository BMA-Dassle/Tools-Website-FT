/**
 * Pure collateral helpers — file kind, season validity, size label.
 *
 * CLIENT-SAFE (no Neon, no `@vercel/blob`): the upload sheet uses the same
 * extension table the route enforces, so a file the browser accepts is a file
 * the server accepts, and the card's "PDF · 310 KB" is computed once.
 */

import { COLLATERAL_MAX_BYTES, type CollateralType, type CollateralValidity } from "../contracts";

export { COLLATERAL_MAX_BYTES };

/**
 * Extension → the label the card shows, and the only kinds the upload route
 * accepts. Anything else is refused BEFORE it reaches Blob: a rep sharing a
 * `.exe` or an `.html` from a guest link is not a use case, and a public blob
 * URL serving arbitrary content is a liability.
 */
export const COLLATERAL_EXTENSIONS: Readonly<Record<string, CollateralType>> = {
  pdf: "PDF",
  pptx: "PPTX",
  ppt: "PPTX",
  docx: "DOCX",
  doc: "DOCX",
  xlsx: "XLSX",
  xls: "XLSX",
  png: "PNG",
  jpg: "JPG",
  jpeg: "JPG",
};

/** What the file input offers, so the picker filters before a rep chooses. */
export const COLLATERAL_ACCEPT = Object.keys(COLLATERAL_EXTENSIONS)
  .map((e) => "." + e)
  .join(",");

export function extensionOf(filename: string): string {
  const bare = filename.split(/[?#]/)[0] ?? "";
  const dot = bare.lastIndexOf(".");
  return dot < 0 ? "" : bare.slice(dot + 1).toLowerCase();
}

/** `null` when the extension is not one we accept. */
export function collateralTypeFromName(filename: string): CollateralType | null {
  return COLLATERAL_EXTENSIONS[extensionOf(filename)] ?? null;
}

/** A URL a director pasted: the same table, defaulting to the generic kind. */
export function collateralTypeFromUrl(url: string): CollateralType {
  return collateralTypeFromName(url) ?? "FILE";
}

/** A title a rep can read, from a filename nobody chose carefully. */
export function titleFromFilename(filename: string): string {
  const bare = (filename.split(/[\\/]/).pop() ?? filename).trim();
  const dot = bare.lastIndexOf(".");
  const stem = dot > 0 ? bare.slice(0, dot) : bare;
  return stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || bare;
}

/**
 * Where this item sits against an ET calendar day.
 *   upcoming  valid_from is still in the future — a rep should not send it yet
 *   expired   valid_until has passed — last autumn's flyer, still on file
 *   current   everything else, including a row with no dates at all
 */
export function validityOf(
  item: { validFrom: string | null; validUntil: string | null },
  todayYmd: string,
): CollateralValidity {
  if (item.validFrom && item.validFrom > todayYmd) return "upcoming";
  if (item.validUntil && item.validUntil < todayYmd) return "expired";
  return "current";
}

/** "310 KB", "2.4 MB" — the shape the prototype's cards print (crm-data.js:366-372). */
export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1000) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "2.4 MB" for the upload sheet's over-size refusal. */
export function tooBigMessage(bytes: number): string {
  return `That file is ${sizeLabel(bytes)}. The limit is ${sizeLabel(COLLATERAL_MAX_BYTES)}.`;
}

const TAG_RE = /^[a-z0-9][a-z0-9 -]{0,28}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Tags are the folder strip, so they are lowercased and de-duplicated at the
 * door; a library with "Pricing", "pricing" and "PRICING " in it has three
 * folders for one idea.
 */
export function normaliseTags(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (!tag || !TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out.slice(0, 8);
}

/** The comma / space separated string the upload sheet's tag input holds. */
export function parseTagInput(value: string): string[] {
  return normaliseTags(value.split(/[,\n]/));
}
