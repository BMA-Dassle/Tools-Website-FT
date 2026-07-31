import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  gameZoneItem,
  getVoucherStatus,
  mintVouchers,
  voidNativeVoucher,
  NATIVE_GRANT_DENOMINATIONS,
} from "~/features/game-cards/service/native-voucher";
import { getVoucher, listVoucherBatch } from "~/features/game-cards/data/vouchers-db";
import {
  emailMintBatch,
  sendVoucherToGuest,
} from "~/features/game-cards/service/voucher-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin: mint / send / void / inspect OUR Game Zone vouchers.
 *
 *   POST { action: "mint",  count, bonusTokens, batchLabel?, expiresAt?, emailTo? }
 *   POST { action: "send",  code, email?, phone?, name? }
 *   POST { action: "void",  code, reason }
 *   GET  ?code=HPW…        → per-item redemption state
 *   GET  ?batchId=…        → every code in a batch
 *
 * MINT ALWAYS EMAILS THE BATCH (owner 2026-07-29: "I also need voucher codes
 * emailed to me"). The codes are only readable in this response and in that
 * mail; if the mail fails the mint still stands (the rows are durable) and the
 * response says so explicitly rather than letting someone assume their inbox
 * has the list.
 *
 * Token-gated with the same shared admin token as the other admin routes. Game
 * Zone items only for now — attraction/race items are mintable in the service
 * but have no redemption rail, so this surface won't offer them yet.
 */

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

const MintSchema = z.object({
  action: z.literal("mint"),
  token: z.string(),
  count: z.number().int().min(1).max(500),
  bonusTokens: z.number().int(),
  batchLabel: z.string().trim().max(120).optional(),
  /** ISO date; the voucher stops being redeemable after this instant. Must
   *  PARSE — a malformed string used to mint a never-expiring voucher, because
   *  Date.parse(garbage) is NaN and `NaN <= now` is false forever. */
  expiresAt: z
    .string()
    .trim()
    .max(40)
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: "expiresAt must be a valid date" })
    .optional(),
  /** Where to send the batch. Falls back to VOUCHER_MINT_EMAIL. */
  emailTo: z.string().trim().email().optional(),
  createdBy: z.string().trim().max(80).optional(),
});

const SendSchema = z
  .object({
    action: z.literal("send"),
    token: z.string(),
    code: z.string().trim().min(8).max(64),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().max(40).optional(),
    name: z.string().trim().max(80).optional(),
  })
  .refine((v) => !!v.email || !!v.phone, { message: "email or phone required" });

const VoidSchema = z.object({
  action: z.literal("void"),
  token: z.string(),
  code: z.string().trim().min(8).max(64),
  reason: z.string().trim().min(1).max(200),
});

const BodySchema = z.discriminatedUnion("action", [MintSchema, SendSchema, VoidSchema]);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!ADMIN_TOKEN || parsed.data.token !== ADMIN_TOKEN) return unauthorized();

  try {
    if (parsed.data.action === "mint") {
      const { count, bonusTokens, batchLabel, expiresAt, createdBy } = parsed.data;
      if (!(NATIVE_GRANT_DENOMINATIONS as readonly number[]).includes(bonusTokens)) {
        return NextResponse.json(
          { ok: false, error: `bonusTokens must be one of ${NATIVE_GRANT_DENOMINATIONS.join(", ")}` },
          { status: 400 },
        );
      }
      const items = [gameZoneItem(bonusTokens)];
      const { batchId, vouchers } = await mintVouchers({
        count,
        items,
        batchLabel: batchLabel ?? null,
        expiresAt: expiresAt ?? null,
        issuedSource: "admin",
        createdBy: createdBy ?? null,
      });
      const codes = vouchers.map((v) => v.code);

      // The mint is already durable — mail is reported, never fatal.
      const to = parsed.data.emailTo || process.env.VOUCHER_MINT_EMAIL || "";
      let mail: { ok: boolean; error?: string } = { ok: false, error: "no recipient configured" };
      if (to) {
        mail = await emailMintBatch({ to, codes, items, batchLabel, batchId, expiresAt });
      }
      return NextResponse.json({
        ok: true,
        batchId,
        codes,
        emailedTo: mail.ok ? to : null,
        emailError: mail.ok ? undefined : mail.error,
      });
    }

    if (parsed.data.action === "send") {
      const voucher = await getVoucher(parsed.data.code.trim().toUpperCase().replace(/-/g, ""));
      if (!voucher) return NextResponse.json({ ok: false, error: "unknown_code" }, { status: 404 });
      const res = await sendVoucherToGuest({
        code: voucher.code,
        items: voucher.items,
        email: parsed.data.email,
        phone: parsed.data.phone,
        name: parsed.data.name,
        expiresAt: voucher.expiresAt,
      });
      return NextResponse.json({ ok: !!(res.emailOk || res.smsOk), ...res });
    }

    await voidNativeVoucher(parsed.data.code, parsed.data.reason);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/vouchers]", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (!ADMIN_TOKEN || url.searchParams.get("token") !== ADMIN_TOKEN) return unauthorized();

  const code = url.searchParams.get("code");
  if (code) {
    const status = await getVoucherStatus(code);
    if (!status) return NextResponse.json({ ok: false, error: "unknown_code" }, { status: 404 });
    return NextResponse.json({ ok: true, status });
  }

  const batchId = url.searchParams.get("batchId");
  if (batchId) {
    const rows = await listVoucherBatch(batchId);
    return NextResponse.json({
      ok: true,
      vouchers: rows.map((r) => ({
        code: r.code,
        items: r.items,
        issuedTo: r.issuedTo,
        expiresAt: r.expiresAt,
        voidedAt: r.voidedAt,
      })),
    });
  }
  return NextResponse.json({ ok: false, error: "code or batchId required" }, { status: 400 });
}
