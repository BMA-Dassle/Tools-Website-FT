import { NextRequest, NextResponse } from "next/server";
import { applyPassEvent } from "~/features/racing/wallet/licence-reconcile";

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
 * A shared secret in `PASSKIT_WEBHOOK_SECRET`, accepted as a bearer token or a
 * `?secret=` query param because portal UIs vary in what they let you set. When
 * the variable is UNSET the endpoint refuses everything rather than defaulting
 * open: it can delete a guest's credential, so an unauthenticated caller must
 * never reach it.
 */
function authorised(req: NextRequest): boolean {
  const secret = process.env.PASSKIT_WEBHOOK_SECRET;
  if (!secret) return false; // closed until deliberately configured
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}` || auth === secret) return true;
  return new URL(req.url).searchParams.get("secret") === secret;
}

/** PassKit's event shape is not documented for our region, so read defensively:
 *  take the externalId (our BMI personId) and a status from any of the spellings
 *  we have seen on the member record. */
function extract(body: unknown): { personId: string; status: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const member = (b.member ?? b.data ?? b) as Record<string, unknown>;
  const meta = (member.passMetaData ?? {}) as Record<string, unknown>;

  const personId = String(member.externalId ?? b.externalId ?? "").trim();
  const status = String(
    meta.status ?? member.status ?? b.event ?? b.type ?? b.status ?? "",
  ).trim();

  if (!/^\d+$/.test(personId) || !status) return null;
  return { personId, status };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorised(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
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
