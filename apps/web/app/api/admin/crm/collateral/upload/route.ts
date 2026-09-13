import type { NextRequest } from "next/server";
import { isAdminApiRequest } from "@/lib/admin-request-auth";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { apiError, gateNotFound, json } from "~/features/crm/core/http";
import { crmUserFromRequest, isDirector } from "~/features/crm/core/identity";
import {
  BLOB_NOT_CONFIGURED,
  CollateralUploadError,
  UPLOAD_ERRORS,
  blobConfigured,
  collateralTypeFromName,
  createCollateral,
  deleteCollateralFile,
  normaliseTags,
  parseTagInput,
  titleFromFilename,
  uploadCollateralFile,
} from "~/features/crm/collateral";
import { isCentreCode } from "~/features/crm/core/centres";

/**
 * POST /api/admin/crm/collateral/upload — multipart: `file`, plus optional
 * `title`, `centre`, `tags`, `validFrom`, `validUntil`.
 *   → `{ok:true, item}` · `{ok:false, error:"blob_not_configured"}` (503)
 *
 * WHY THIS ONE ROUTE DOES NOT USE `withCrmRoute`. That wrapper reads the body
 * first (`req.json()`) so it can zod-parse it and find a body `token`. A
 * multipart body cannot survive that: the stream is consumed, and
 * `req.formData()` afterwards gets nothing. So this handler runs the SAME
 * chain by hand, in the same order, from the same exports — credential →
 * session → DIRECTOR → service → audit — and takes its credential from the
 * header only (`crmFetch` always sends `x-admin-token`; a file upload has no
 * JSON body to carry one). The refusal shapes are byte-identical to
 * `withCrmRoute`'s: `gateNotFound()` for a bad credential, `apiError(401|403,
 * "session")` for a bad session, `apiError(403, "director_only")` for a rep.
 * `route.test.ts` drives every one of those, because a hand-rolled chain that
 * nothing tests is a chain that drifts.
 *
 * DIRECTOR-ONLY, like every other write on this screen. Reps share; directors
 * curate (`collateral/[id]/route.ts` says the same). Hiding the Upload button
 * from a rep is a UI claim; this is what backs it — otherwise any session with
 * `sales` could put an arbitrary file into the library every other rep then
 * sends to guests.
 *
 * WITHOUT A BLOB TOKEN (brief C6): `blob_not_configured` comes back BEFORE the
 * body is read, so a deployment with no store never buffers 25 MB to refuse
 * it, and the screen keeps "Add by URL" as the way in. The token is read by
 * name only — never logged, never echoed.
 *
 * ORDERING AND THE ORPHAN (R2). `crm_collateral.blob_url` is NOT NULL, so the
 * bytes must exist before the row can. When the insert then fails, the object
 * we just stored is deleted again (`deleteCollateralFile`) rather than left
 * public, unreferenced and billable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UPLOAD_STATUS: Record<string, number> = {
  [UPLOAD_ERRORS.notConfigured]: 503,
  [UPLOAD_ERRORS.noFile]: 400,
  [UPLOAD_ERRORS.tooBig]: 413,
  [UPLOAD_ERRORS.badType]: 415,
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ymd(form: FormData, name: string): string | null {
  const value = field(form, name);
  return value && YMD.test(value) ? value : null;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!(await isAdminApiRequest(req))) return gateNotFound();
  const who = await crmUserFromRequest();
  if (!who.ok) return apiError(who.status, "session");
  if (!isDirector(who.user)) return apiError(403, "director_only");

  if (!blobConfigured()) return apiError(503, BLOB_NOT_CONFIGURED);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, UPLOAD_ERRORS.noFile);
  }

  const raw = form.get("file");
  const file = raw instanceof File ? raw : null;

  let stored: string | null = null;
  try {
    const uploaded = await uploadCollateralFile(file);
    stored = uploaded.url;
    const name = file?.name ?? "file";
    const centre = field(form, "centre");
    const item = await createCollateral({
      title: field(form, "title") ?? titleFromFilename(name),
      centre: isCentreCode(centre) ? centre : null,
      type: collateralTypeFromName(name) ?? uploaded.type,
      blobUrl: uploaded.url,
      blobPathname: uploaded.pathname,
      contentType: uploaded.contentType,
      sizeBytes: uploaded.sizeBytes,
      tags: normaliseTags(parseTagInput(field(form, "tags") ?? "")),
      validFrom: ymd(form, "validFrom"),
      validUntil: ymd(form, "validUntil"),
      uploadedBy: who.user.email,
    });
    stored = null;
    await writeAudit({
      entity: "collateral",
      entityId: item.id,
      action: "upload",
      actorEmail: who.user.email,
      after: { id: item.id, title: item.title, pathname: uploaded.pathname },
    });
    return json({ ok: true, item });
  } catch (err) {
    // The bytes are stored but the row is not: delete the object rather than
    // leave a public orphan nothing points at.
    if (stored) await deleteCollateralFile(stored);
    if (err instanceof CollateralUploadError) {
      return apiError(UPLOAD_STATUS[err.code] ?? 400, err.code);
    }
    console.error("[crm] collateral upload failed", {
      actor_email: who.user.email,
      blob_cleaned_up: Boolean(stored),
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(500, "unexpected");
  }
}
