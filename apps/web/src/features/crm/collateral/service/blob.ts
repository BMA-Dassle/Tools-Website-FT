/**
 * Vercel Blob, for collateral files only.
 *
 * REUSE, not a new rail: `put` from `@vercel/blob` is already how this app
 * stores contract PDFs (`lib/contract-pdf-generate.ts:1`), DR-14 tax letters
 * (`app/api/group-function/upload-tax-doc/route.ts:2`) and briefing room
 * photos (`src/features/signage/briefing/room-photo.server.ts:36`). The same
 * helper, the same `access: "public"`, a `crm/collateral/` prefix of our own.
 *
 * DEGRADING HONESTLY (brief C6). `BLOB_READ_WRITE_TOKEN` is read by NAME only
 * — never logged, never returned. When it is absent the upload route answers
 * `{ok:false, error:"blob_not_configured"}` and the screen says so in a
 * sentence, with "Add by URL" still working; the library is not dark because
 * one env var is missing. `blobConfigured()` is evaluated per call, not at
 * module load, so setting the variable on Vercel takes effect on the next
 * request rather than the next deploy.
 *
 * `allowOverwrite` is deliberately NOT set: every path carries a random
 * suffix, so two reps uploading "pricing.pdf" get two blobs rather than one
 * silently replacing the other's.
 */

import { put } from "@vercel/blob";
import { BLOB_NOT_CONFIGURED, COLLATERAL_MAX_BYTES, type CollateralType } from "../contracts";
import { collateralTypeFromName, extensionOf } from "./library";

export const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

/** Where every CRM collateral object lives in the store. */
export const COLLATERAL_BLOB_PREFIX = "crm/collateral/";

export { BLOB_NOT_CONFIGURED };

export function blobConfigured(): boolean {
  return Boolean(process.env[BLOB_TOKEN_ENV]);
}

/** Thrown by `uploadCollateralFile`; the route turns it into its error code. */
export class CollateralUploadError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CollateralUploadError";
    this.code = code;
  }
}

export const UPLOAD_ERRORS = {
  notConfigured: BLOB_NOT_CONFIGURED,
  noFile: "no_file",
  tooBig: "file_too_big",
  badType: "unsupported_file_type",
} as const;

/**
 * A safe object key: the extension we already validated, the ET-free ISO day
 * for browsability, and a slug of the original name so a human can recognise
 * the object in the Blob dashboard. Everything outside `[a-z0-9-]` is dropped
 * — a filename is guest-adjacent input and must never steer a path.
 */
export function blobPathFor(filename: string, now: Date = new Date()): string {
  const ext = extensionOf(filename);
  const stem = (filename.split(/[\\/]/).pop() ?? filename)
    .slice(0, 60)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const day = now.toISOString().slice(0, 10);
  return `${COLLATERAL_BLOB_PREFIX}${day}/${stem || "file"}${ext ? "." + ext : ""}`;
}

export interface UploadedCollateral {
  url: string;
  pathname: string;
  contentType: string;
  sizeBytes: number;
  type: CollateralType;
}

export interface BlobPutDeps {
  put: typeof put;
  now: () => Date;
}

export function liveBlobDeps(): BlobPutDeps {
  return { put, now: () => new Date() };
}

/**
 * Validate then store. Validation order matters: a missing token is reported
 * before anything is read from the request, so a deployment without Blob never
 * buffers a 25 MB body just to refuse it.
 */
export async function uploadCollateralFile(
  file: File | null,
  deps: BlobPutDeps = liveBlobDeps(),
): Promise<UploadedCollateral> {
  if (!blobConfigured()) throw new CollateralUploadError(UPLOAD_ERRORS.notConfigured);
  if (!file || typeof file.arrayBuffer !== "function" || !file.name) {
    throw new CollateralUploadError(UPLOAD_ERRORS.noFile);
  }
  if (file.size > COLLATERAL_MAX_BYTES) {
    throw new CollateralUploadError(UPLOAD_ERRORS.tooBig);
  }
  const type = collateralTypeFromName(file.name);
  if (!type) throw new CollateralUploadError(UPLOAD_ERRORS.badType);

  const blob = await deps.put(blobPathFor(file.name, deps.now()), file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type || undefined,
  });
  return {
    url: blob.url,
    pathname: blob.pathname,
    contentType: blob.contentType || file.type || "application/octet-stream",
    sizeBytes: file.size,
    type,
  };
}
