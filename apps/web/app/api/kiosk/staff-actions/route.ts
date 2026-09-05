import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyStaffToken } from "~/features/kiosk/staff-mode/staff-token.server";
import {
  grantStaffComp,
  grantStaffMembership,
  isPersonLocal,
  readStaffAccount,
} from "~/features/kiosk/staff-mode/service.server";
import { MAX_COMP_QTY } from "~/features/kiosk/staff-mode/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kiosk STAFF-ACTIONS API — what an identified staff member may do to a guest's
 * BMI account from a kiosk. Gated by the signed staff token
 * (`x-kiosk-staff-token`, minted by /api/kiosk/staff-card), which is where the
 * acting employee comes from — never the body.
 *
 * Separate from /api/kiosk/staff on purpose: that route is READ-ONLY by owner
 * decision (2026-09-02) and PIN-gated; this one writes, and every write names
 * its author.
 *
 * GET  ?action=account&personId=&location=  → memberships + credit balances +
 *                                            every finished heat (Office personStats/races)
 *      ?action=local&personId=&location=    → { local: true|false|null } — is this person on
 *                                            the on-site server yet? Greys Membership / Comp.
 * POST { action:"membership", personId, pandoraPersonId?, personName?, kindKey,
 *        activates?, expires, location, kioskId? }
 *      { action:"comp", personId, pandoraPersonId?, personName?, kindKey, qty,
 *        reason?, location, kioskId? }
 * Both writes are persist-first into kiosk_staff_actions (service.server.ts).
 */

const ID_RE = /^\d{1,20}$/;
const LocationSchema = z.enum(["fasttrax", "headpinz", "naples"]);

const PersonSchema = {
  personId: z.string().regex(ID_RE),
  pandoraPersonId: z.string().regex(ID_RE).optional(),
  personName: z.string().trim().max(120).optional(),
  location: LocationSchema,
  kioskId: z.string().max(40).optional(),
};

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("membership"),
    ...PersonSchema,
    kindKey: z.string().max(40),
    activates: z.string().datetime().optional(),
    expires: z.string().datetime(),
  }),
  z.object({
    action: z.literal("comp"),
    ...PersonSchema,
    kindKey: z.string().max(40),
    qty: z.number().int().min(1).max(MAX_COMP_QTY),
    reason: z.string().trim().max(300).optional(),
  }),
]);

function employeeFrom(req: NextRequest) {
  return verifyStaffToken(req.headers.get("x-kiosk-staff-token"));
}

export async function GET(req: NextRequest) {
  const employee = employeeFrom(req);
  if (!employee) return NextResponse.json({ error: "Staff token required" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  if (action !== "account" && action !== "local") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const personId = searchParams.get("personId") || "";
  const location = LocationSchema.safeParse(searchParams.get("location"));
  if (!ID_RE.test(personId) || !location.success) {
    return NextResponse.json({ error: "personId + location required" }, { status: 400 });
  }
  try {
    if (action === "local") {
      const status = await isPersonLocal(personId, location.data);
      return NextResponse.json(status);
    }
    const account = await readStaffAccount(personId, location.data);
    return NextResponse.json({ account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Account read failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const employee = employeeFrom(req);
  if (!employee) return NextResponse.json({ error: "Staff token required" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid staff action" }, { status: 400 });
  }
  const input = parsed.data;
  const ctx = { employee, kioskId: input.kioskId ?? null, location: input.location };
  try {
    if (input.action === "membership") {
      const out = await grantStaffMembership(ctx, input);
      return NextResponse.json({ ok: true, ...out });
    }
    const out = await grantStaffComp(ctx, input);
    return NextResponse.json({ ok: true, ...out });
  } catch (err) {
    // The service already settled the audit row; tell the sheet what happened.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Staff action failed" },
      { status: 500 },
    );
  }
}
