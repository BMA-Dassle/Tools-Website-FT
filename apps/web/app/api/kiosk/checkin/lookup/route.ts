import { NextRequest, NextResponse } from "next/server";
import {
  isCenterSlug,
  rateLimited,
  resolveScanToBillId,
  loadSummary,
  listBindableParty,
  mintProof,
  mintRef,
  matchByPhone,
  phoneIsVerified,
  listBrowseRows,
  readProof,
  readRef,
  sendContactOtp,
  confirmContactOtp,
} from "~/features/kiosk/checkin/server";
import { isExpressBooking } from "~/features/kiosk/checkin/express";
import { kioskVoucherPrefillEnabled } from "~/features/kiosk/flags";
import type {
  CheckinConfirmOtpResponse,
  CheckinLookupResponse,
  CheckinPartyResponse,
  CheckinSendOtpResponse,
} from "~/features/kiosk/checkin/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/kiosk/checkin/lookup            — find a reservation (scan/phone/browse)
 * POST /api/kiosk/checkin/lookup?action=send-otp    — text the booking contact
 * POST /api/kiosk/checkin/lookup?action=confirm-otp — verify the texted code
 *
 * No device auth (kiosk-route posture). Everything beyond PII-lean browse rows
 * requires possession: a scanned code, a verified own-phone match, or an OTP to
 * the reservation's own contact. Rate-limited per IP (lax, fail-open).
 */

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  const ip = clientIp(req);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  const center = String(body.center ?? "");
  if (!isCenterSlug(center)) {
    return NextResponse.json<CheckinLookupResponse>(
      { ok: false, reason: "invalid", error: "Invalid center" },
      { status: 400 },
    );
  }

  // ── OTP to the booking contact (browse path) ──────────────────────────────
  if (action === "send-otp") {
    if (await rateLimited("send-otp", ip, 12)) {
      return NextResponse.json<CheckinSendOtpResponse>(
        { ok: false, reason: "rate-limited" },
        { status: 429 },
      );
    }
    const handle = await readRef(String(body.ref ?? ""));
    if (!handle || handle.center !== center) {
      return NextResponse.json<CheckinSendOtpResponse>(
        { ok: false, reason: "not-found" },
        { status: 404 },
      );
    }
    const last4 = String(body.last4 ?? "").replace(/\D/g, "");
    const res = await sendContactOtp(handle.billId, last4);
    return NextResponse.json<CheckinSendOtpResponse>(res, { status: res.ok ? 200 : 409 });
  }

  if (action === "confirm-otp") {
    if (await rateLimited("confirm-otp", ip, 20)) {
      return NextResponse.json<CheckinConfirmOtpResponse>({ ok: false }, { status: 429 });
    }
    const handle = await readRef(String(body.ref ?? ""));
    const code = String(body.code ?? "").trim();
    if (!handle || handle.center !== center || !code) {
      return NextResponse.json<CheckinConfirmOtpResponse>({ ok: false }, { status: 400 });
    }
    const res = await confirmContactOtp(handle.billId, center, code);
    return NextResponse.json<CheckinConfirmOtpResponse>(res, { status: res.ok ? 200 : 401 });
  }

  // ── bind-ready party (voucher-QR prefill) ─────────────────────────────────
  // Proof-gated: ids flow ONLY for a reservation the guest demonstrably holds
  // (same bar as the itinerary — which itself deliberately nulls person ids).
  if (action === "party") {
    if (!kioskVoucherPrefillEnabled()) {
      return NextResponse.json<CheckinPartyResponse>(
        { ok: false, reason: "disabled" },
        { status: 404 },
      );
    }
    if (await rateLimited("party", ip, 30)) {
      return NextResponse.json<CheckinPartyResponse>(
        { ok: false, reason: "rate-limited" },
        { status: 429 },
      );
    }
    const proof = await readProof(String(body.proofToken ?? ""));
    if (!proof || proof.center !== center) {
      return NextResponse.json<CheckinPartyResponse>(
        { ok: false, reason: "expired-proof" },
        { status: 401 },
      );
    }
    const members = await listBindableParty(proof.billId);
    return NextResponse.json<CheckinPartyResponse>({ ok: true, members });
  }

  // ── find ──────────────────────────────────────────────────────────────────
  if (await rateLimited("lookup", ip, 40)) {
    return NextResponse.json<CheckinLookupResponse>(
      { ok: false, reason: "rate-limited" },
      { status: 429 },
    );
  }

  // Browse — PII-lean list of today's reservations at this center.
  if (body.browse === true) {
    const rows = await listBrowseRows(center);
    return NextResponse.json<CheckinLookupResponse>({ ok: true, rows });
  }

  // Scan / typed code. A signature-carrying input (/s short link or a full
  // signed URL) is real possession and opens directly. An enumerable input
  // (native code / r{billId} / W-number) resolves the reservation but must be
  // OTP-confirmed to the booking's OWN contact first — so knowing a guessable
  // id only ever texts the real owner, never reveals their PII.
  if (typeof body.scan === "string" && body.scan.trim()) {
    const resolved = await resolveScanToBillId(center, body.scan);
    if (!resolved.billId) {
      return NextResponse.json<CheckinLookupResponse>(
        { ok: false, reason: resolved.reason ?? "not-found" },
        { status: 200 },
      );
    }
    const summary = await loadSummary(resolved.billId);
    if (!summary) {
      return NextResponse.json<CheckinLookupResponse>({ ok: false, reason: "not-found" });
    }
    if (summary.cancelled) {
      return NextResponse.json<CheckinLookupResponse>({ ok: false, reason: "cancelled" });
    }
    if (resolved.proven) {
      const proofToken = await mintProof(resolved.billId, center, "code");
      return NextResponse.json<CheckinLookupResponse>({
        ok: true,
        matches: [
          {
            proofToken,
            label: summary.label,
            timeLabel: summary.timeLabel,
            activitiesLabel: summary.activitiesLabel,
          },
        ],
      });
    }
    // Unproven → hand back an OTP-gated row (client runs send-otp → confirm-otp),
    // unless it's Express Lane: that party skips check-in entirely, so the row
    // carries the flag and the client shows them where to go instead of texting
    // a code. Same eligibility rule as the browse list.
    const ref = await mintRef({ billId: resolved.billId, center });
    const kind = summary.activitiesLabel.includes("+")
      ? "mixed"
      : summary.activitiesLabel.startsWith("Racing")
        ? "racing"
        : summary.activitiesLabel.startsWith("Bowling")
          ? "bowling"
          : "attraction";
    return NextResponse.json<CheckinLookupResponse>({
      ok: true,
      reason: "needs-otp",
      rows: [
        {
          ref,
          label: summary.label,
          timeLabel: summary.timeLabel,
          activitiesLabel: summary.activitiesLabel,
          kind,
          express: isExpressBooking({ record: summary.record, racingOnly: kind === "racing" }),
        },
      ],
    });
  }

  // Phone — the guest verified their OWN number via /api/sms-verify first.
  if (typeof body.phone === "string" && body.phone.trim()) {
    if (!(await phoneIsVerified(body.phone))) {
      return NextResponse.json<CheckinLookupResponse>({ ok: false, reason: "needs-otp" });
    }
    const matches = await matchByPhone(center, body.phone);
    if (matches.length === 0) {
      return NextResponse.json<CheckinLookupResponse>({ ok: false, reason: "not-found" });
    }
    return NextResponse.json<CheckinLookupResponse>({ ok: true, matches });
  }

  return NextResponse.json<CheckinLookupResponse>(
    { ok: false, reason: "invalid", error: "Provide scan, phone, or browse" },
    { status: 400 },
  );
}
