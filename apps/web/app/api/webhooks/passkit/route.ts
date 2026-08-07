import { NextRequest, NextResponse } from "next/server";
import { applyPassEvent } from "~/features/racing/wallet/licence-reconcile";
import { verifyPassKitWebhook } from "~/features/racing/wallet/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PassKit pass-lifecycle events — install, uninstall, delete.
 *
 * ── Read this before wiring it up ───────────────────────────────────────────
 * PassKit's REST API exposes NO way to register a webhook. Every spelling 404s
 * (`/webhooks`, `/webhook`, `/eventSubscriptions`, `/subscriptions`, `/events`,
 * and the per-program variant), measured 2026-08-06 — the same story as
 * free-text push messages, which are portal or gRPC only. So this endpoint
 * exists to be POINTED AT from the PassKit portal; nothing we can call will
 * subscribe it for us.
 *
 * Until that is configured, `api/cron/passkit-reconcile` polls
 * `passMetaData.status` daily and is the authoritative path. This is the faster
 * half, not the only half — and both share `applyPassEvent`/the same rules, so
 * push and poll can never disagree about what is safe to delete.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * PASSKIT MINTS THE SECRET, WE DO NOT — see webhook-auth.ts. The first version
 * of this file checked a bearer token of OUR choosing, which no real delivery
 * could ever have carried, and it rejected BEFORE logging, so a misconfigured
 * webhook would have looked identical to a silent one forever.
 *
 * Put PassKit's generated secret in `PASSKIT_WEBHOOK_SECRET`. Unset = nothing is
 * ever acted on, because a verified delivery deletes a guest's credential.
 *
 * ── Why an unverified delivery still answers 200 ────────────────────────────
 * It is ACKNOWLEDGED, never ACTED ON. A sender that gets a 4xx retries and can
 * eventually disable the subscription — and while the exact signature scheme is
 * still being confirmed, a wrong guess on our side must not cost us the
 * subscription. Nothing is deleted, nothing is recorded, and the delivery is
 * logged loudly with the header names so the real scheme is knowable from ONE
 * event rather than a deploy-and-guess cycle.
 */

/**
 * PassKit's payload shape is not documented for our region and the portal only
 * offers a URL field, so this reads defensively: pull the externalId (our BMI
 * personId) and a status from any of the spellings we have seen, then map the
 * portal's own event vocabulary — Created / Updated / Installed / Uninstalled /
 * Deleted — onto the `passMetaData.status` values the polling sweep already
 * understands, so push and poll cannot disagree.
 *
 * Anything unrecognised is logged with the raw body rather than guessed at. The
 * first real event will tell us the true shape; until then this is deliberately
 * generous about where it looks.
 */
function normaliseStatus(raw: string): string {
  const v = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (/UNINSTALL|DELET|REMOV/.test(v)) return "PASS_DELETED";
  if (/INSTALL/.test(v)) return "PASS_INSTALLED";
  if (/ISSUE|CREAT/.test(v)) return "PASS_ISSUED";
  return v;
}

/** A licence externalId is a BMI personId (all digits). A VOUCHER's is its HPW
 *  code, so the two programs are told apart by shape alone. */
function looksLikeVoucherCode(v: string): boolean {
  return /^[A-Za-z0-9-]{6,32}$/.test(v) && !/^\d+$/.test(v);
}

function extract(body: unknown): { personId: string; status: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const member = (b.member ?? b.data ?? b.pass ?? b) as Record<string, unknown>;
  const meta = (member.passMetaData ?? {}) as Record<string, unknown>;

  const personId = String(
    member.externalId ?? b.externalId ?? member.externalID ?? "",
  ).trim();
  const rawStatus = String(
    b.event ?? b.eventType ?? b.type ?? meta.status ?? member.status ?? b.status ?? "",
  ).trim();

  if (!/^\d+$/.test(personId) || !rawStatus) return null;
  return { personId, status: normaliseStatus(rawStatus) };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RAW TEXT, NOT req.json(). The signature is computed over the bytes PassKit
  // sent; re-serialising parsed JSON changes key order and whitespace, and the
  // HMAC then never matches a sender that is working perfectly.
  const rawBody = await req.text();
  const auth = verifyPassKitWebhook(req.headers, req.url, rawBody);

  // Logged on EVERY delivery, verified or not — the portal documents neither the
  // signature scheme nor the payload shape, and one real event settles both.
  console.log(
    `[passkit-webhook] verified=${auth.verified} via=${auth.via ?? "-"} headers=${auth.headerNames.join(",")}`,
  );
  console.log("[passkit-webhook] payload:", rawBody.slice(0, 800));

  if (!auth.verified) {
    // Acknowledged, never acted on. See the header note on why this is not a 401.
    console.warn(
      "[passkit-webhook] UNVERIFIED — no action taken." +
        (process.env.PASSKIT_WEBHOOK_SECRET
          ? " Secret is set, so the signature scheme above did not match any form we accept."
          : " PASSKIT_WEBHOOK_SECRET is UNSET."),
    );
    return NextResponse.json({ ok: true, verified: false, action: "none" });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // BOTH PROGRAMS POST HERE. A voucher event is legitimate and must not be
  // logged as "unrecognised" — that noise would bury a real parsing failure.
  //
  // But there is nothing to DO with one: a single-use coupon is billed once at
  // ISSUANCE, so an uninstall costs us nothing, and PassKit cannot delete a
  // coupon at all (DELETE answers 501, measured 2026-08-06). The licence reaper
  // exists precisely because MULTI-use records are the ones that keep billing.
  const rawExternal = String(
    (body as Record<string, unknown>)?.externalId ??
      ((body as Record<string, unknown>)?.member as Record<string, unknown>)?.externalId ??
      "",
  ).trim();
  if (looksLikeVoucherCode(rawExternal)) {
    console.log(`[passkit-webhook] voucher ${rawExternal} event — recorded, no billing action`);
    return NextResponse.json({ ok: true, program: "voucher", action: "none" });
  }

  const event = extract(body);
  if (!event) {
    // 200, not 4xx: a webhook sender that gets an error retries forever, and an
    // event shape we do not understand is our problem to fix, not theirs. Logged
    // so an unrecognised payload is visible rather than silently dropped.
    console.warn("[passkit-webhook] unrecognised payload:", JSON.stringify(body).slice(0, 400));
    return NextResponse.json({ ok: true, ignored: true });
  }

  const result = await applyPassEvent(event.personId, event.status);
  if (result.reaped) {
    console.log(
      `[passkit-webhook] ${event.personId} reported ${event.status} — PassKit record deleted, billing stopped`,
    );
  }
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
