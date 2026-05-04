import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { voxSend } from "@/lib/sms-retry";
import { sendEmail as sendGridEmail } from "@/lib/sendgrid";
import { canonicalizePhone } from "@/lib/participant-contact";
import { logSms } from "@/lib/sms-log";

/**
 * POST /api/admin/pov-codes/issued/resend
 *
 * Re-deliver a customer's POV codes via SMS / email. Pulls the codes
 * from `pov:used` by either billId or personId+sessionId, composes a
 * short ASCII-only SMS body and a branded email, sends via the same
 * voxSend / sendgrid helpers the rest of the system uses. Logs SMS
 * with `source: "admin-resend"` so audits distinguish ops resends
 * from cron deliveries.
 *
 * Body:
 *   {
 *     billId?: string,        // either billId
 *     personId?: string,      // OR personId (+ optional sessionId)
 *     sessionId?: string,
 *     channel: "sms" | "email" | "both",
 *     overridePhone?: string,
 *     overrideEmail?: string,
 *     bodyOverride?: string   // optional — replaces the default SMS body verbatim
 *   }
 *
 * The default SMS body is a single 1-segment-friendly format:
 *
 *   FastTrax POV codes:
 *   ABCD123456
 *   WXYZ789012
 *
 *   Redeem at vt3.io — paste the code on the site to unlock your video.
 *
 * Codes are listed inline so the customer doesn't have to dig back
 * into their booking confirmation. ASCII-only.
 *
 * Auth: same `x-api-key` (SALES_API_KEYS) as the rest of the admin
 * surface; falls back to the operator admin token. See middleware.ts.
 */

const POV_USED_KEY = "pov:used";

interface PovUsedMeta {
  usedAt?: string;
  billId?: string;
  email?: string;
  personId?: string | number;
  sessionId?: string | number;
  locationId?: string;
  source?: string;
}

interface ResendBody {
  billId?: string;
  personId?: string | number;
  sessionId?: string | number;
  channel?: "sms" | "email" | "both";
  overridePhone?: string;
  overrideEmail?: string;
  bodyOverride?: string;
}

/** HSCAN pov:used and return every code whose metadata matches the
 *  provided lookup. Single pass — no per-code roundtrip. */
async function findCodesForCustomer(opts: {
  billId?: string;
  personId?: string | number;
  sessionId?: string | number;
}): Promise<{ codes: string[]; firstMeta: PovUsedMeta | null }> {
  const codes: string[] = [];
  let firstMeta: PovUsedMeta | null = null;
  let cursor = "0";
  let scanCount = 0;
  do {
    const [next, fields] = await redis.hscan(POV_USED_KEY, cursor, "COUNT", 500);
    cursor = next;
    scanCount++;
    for (let i = 0; i < fields.length; i += 2) {
      const code = fields[i];
      const raw = fields[i + 1];
      let meta: PovUsedMeta = {};
      try { meta = JSON.parse(raw); } catch { /* skip */ }

      const billMatch = opts.billId && meta.billId === opts.billId;
      const personMatch =
        opts.personId != null &&
        meta.personId != null &&
        String(meta.personId) === String(opts.personId) &&
        (opts.sessionId == null || String(meta.sessionId) === String(opts.sessionId));

      if (billMatch || personMatch) {
        codes.push(code);
        if (!firstMeta) firstMeta = meta;
      }
    }
    if (scanCount > 200) break;
  } while (cursor !== "0");
  return { codes, firstMeta };
}

function buildSmsBody(codes: string[]): string {
  return [
    "FastTrax POV codes:",
    ...codes,
    "",
    "Redeem at vt3.io - paste the code on the site to unlock your video.",
  ].join("\n");
}

function buildEmailHtml(codes: string[], firstName?: string): string {
  const safe = (s: string) => s.replace(/[<>]/g, "");
  const greet = firstName ? safe(firstName) : "Racer";
  const codeRows = codes
    .map((c) => `<tr><td style="padding:8px 12px;border:1px solid #E0E0E0;font-family:Courier,monospace;font-size:18px;letter-spacing:2px;font-weight:bold;text-align:center;color:#1A1A1A;background:#F8F8F8;">${safe(c)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Your FastTrax POV codes</title></head>
<body style="margin:0;padding:0;background:#F2F3F5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F2F3F5;">
<tr><td align="center" style="padding:20px 10px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#FFF;border-radius:8px;border:1px solid #E0E0E0;">
  <tr><td align="center" style="padding:28px 40px;background:#000418;">
    <img src="https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png" alt="FastTrax" style="max-width:180px;display:block"/>
  </td></tr>
  <tr><td align="center" style="padding:28px 40px 8px 40px;">
    <p style="margin:0 0 10px 0;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#004AAD;font-weight:bold;">Your POV Video Codes</p>
    <h1 style="margin:0 0 6px 0;font-size:24px;color:#1A1A1A;letter-spacing:1px;text-transform:uppercase;">Hey ${greet}!</h1>
    <p style="margin:0;font-size:15px;color:#555;line-height:1.6;">Use these codes at <a href="https://vt3.io" style="color:#004AAD;">vt3.io</a> to unlock your race video${codes.length > 1 ? "s" : ""}.</p>
  </td></tr>
  <tr><td align="center" style="padding:24px 40px;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${codeRows}</table>
  </td></tr>
  <tr><td align="center" style="padding:0 40px 24px 40px;">
    <a href="https://vt3.io" style="display:inline-block;padding:14px 28px;background:#004AAD;color:#FFF;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;">Redeem at vt3.io</a>
  </td></tr>
  <tr><td style="padding:20px 40px;background:#000418;">
    <p style="margin:0;font-size:11px;color:#8A8FA0;text-align:center;">
      <strong style="color:#FFF;">FastTrax Entertainment</strong> — 14501 Global Parkway, Fort Myers, FL 33913
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export async function POST(req: NextRequest) {
  let body: ResendBody;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const channel = body.channel;
  if (channel !== "sms" && channel !== "email" && channel !== "both") {
    return NextResponse.json({ error: "channel must be sms|email|both" }, { status: 400 });
  }
  if (!body.billId && !body.personId) {
    return NextResponse.json({ error: "billId OR personId required" }, { status: 400 });
  }

  // Look up codes
  const { codes, firstMeta } = await findCodesForCustomer({
    billId: body.billId,
    personId: body.personId,
    sessionId: body.sessionId,
  });

  if (codes.length === 0) {
    return NextResponse.json(
      { error: "no codes found for that billId/personId" },
      { status: 404 },
    );
  }

  // Resolve recipient — override > stored on the booking record
  let storedPhone: string | null = null;
  let storedEmail: string | null = firstMeta?.email ?? null;
  let storedFirstName: string | undefined;
  if (body.billId) {
    try {
      const raw = await redis.get(`bookingrecord:${body.billId}`);
      if (raw) {
        const b = JSON.parse(raw) as {
          contact?: { firstName?: string; email?: string; phone?: string };
        };
        if (b.contact?.phone) storedPhone = b.contact.phone;
        if (b.contact?.email && !storedEmail) storedEmail = b.contact.email;
        if (b.contact?.firstName) storedFirstName = b.contact.firstName;
      }
    } catch { /* ignore */ }
  }

  const smsBody = body.bodyOverride || buildSmsBody(codes);
  const emailHtml = buildEmailHtml(codes, storedFirstName);
  const ts = new Date().toISOString();

  const result: {
    sms?: { ok: boolean; status: number | null; sentTo?: string; error?: string };
    email?: { ok: boolean; status: number | null; sentTo?: string; error?: string };
  } = {};

  // ── SMS ──────────────────────────────────────────────────────────
  if (channel === "sms" || channel === "both") {
    const rawPhone = (body.overridePhone || storedPhone || "").trim();
    const phone = canonicalizePhone(rawPhone);
    if (!phone) {
      result.sms = { ok: false, status: null, error: `Invalid phone: ${rawPhone || "(none on file)"}` };
    } else {
      try {
        const send = await voxSend(phone, smsBody);
        result.sms = {
          ok: send.ok,
          status: send.status,
          sentTo: phone,
          error: send.ok ? undefined : send.error,
        };
        await logSms({
          ts, phone,
          source: "admin-resend",
          status: send.status, ok: send.ok,
          error: send.ok ? undefined : (send.error || "").slice(0, 500),
          body: smsBody,
          // pov-codes audit fields — stash billId/personId in the
          // shortCode slot so the SMS log entry is locatable later
          shortCode: body.billId
            ? `pov-bill-${body.billId}`
            : `pov-person-${body.personId}`,
          memberCount: 1,
          provider: send.provider,
          providerMessageId: send.voxId,
        });
      } catch (err) {
        result.sms = { ok: false, status: null, error: err instanceof Error ? err.message : "send error" };
      }
    }
  }

  // ── Email ────────────────────────────────────────────────────────
  if (channel === "email" || channel === "both") {
    const to = (body.overrideEmail || storedEmail || "").trim();
    if (!to) {
      result.email = { ok: false, status: null, error: "No email on file; supply overrideEmail" };
    } else {
      try {
        const send = await sendGridEmail({
          to,
          subject: `Your FastTrax POV ${codes.length > 1 ? "codes" : "code"}`,
          html: emailHtml,
          bcc: "vendorcases@dassle.us",
        });
        result.email = {
          ok: send.ok,
          status: send.status,
          sentTo: to,
          error: send.ok ? undefined : send.error,
        };
      } catch (err) {
        result.email = { ok: false, status: null, error: err instanceof Error ? err.message : "email error" };
      }
    }
  }

  return NextResponse.json({
    ok: !!(result.sms?.ok || result.email?.ok),
    codes,
    codeCount: codes.length,
    result,
    lookup: {
      billId: body.billId ?? null,
      personId: body.personId != null ? String(body.personId) : null,
      sessionId: body.sessionId != null ? String(body.sessionId) : null,
    },
  });
}
