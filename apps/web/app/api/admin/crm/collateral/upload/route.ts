import type { NextRequest } from "next/server";
import { isAdminApiRequest } from "@/lib/admin-request-auth";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { apiError, gateNotFound, json } from "~/features/crm/core/http";
import { crmUserFromRequest } from "~/features/crm/core/identity";
import {
  BLOB_NOT_CONFIGURED,
  CollateralUploadError,
  UPLOAD_ERRORS,
  blobConfigured,
  collateralTypeFromName,
  createCollateral,
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
 * session → service → audit — and takes its credential from the header only
 * (`crmFetch` always sends `x-admin-token`; a file upload has no JSON body to
 * carry one). The refusal shapes are byte-identical to `withCrmRoute`'s:
 * `gateNotFound()` for a bad credential, `apiError(401|403, "session")` for a
 * bad session.
 *
 * WITHOUT A BLOB TOKEN (brief C6): `blob_not_configured` comes back BEFORE the
 * body is read, so a deployment with no store never buffers 25 MB to refuse
 * it, and the screen keeps "Add by URL" as the way in. The token is read by
 * name only — never logged, never echoed.
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

  if (!blobConfigured()) return apiError(503, BLOB_NOT_CONFIGURED);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, UPLOAD_ERRORS.noFile);
  }

  const raw = form.get("file");
  const file = raw instanceof File ? raw : null;

  try {
    const uploaded = await uploadCollateralFile(file);
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
    await writeAudit({
      entity: "collateral",
      entityId: item.id,
      action: "upload",
      actorEmail: who.user.email,
      after: { id: item.id, title: item.title, pathname: uploaded.pathname },
    });
    return json({ ok: true, item });
  } catch (err) {
    if (err instanceof CollateralUploadError) {
      return apiError(UPLOAD_STATUS[err.code] ?? 400, err.code);
    }
    console.error("[crm] collateral upload failed", {
      actor_email: who.user.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(500, "unexpected");
  }
}
