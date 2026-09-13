/**
 * Share links: mint one, record an open, expire the due ones.
 *
 * THE PATH IS A CONSTANT, PINNED BY A TEST (`share.test.ts`, the way
 * `lib/waiver-short-link.test.ts` pins the waiver one). `CRM_SHARE_PATH` lives
 * in `../contracts` and is `/api/crm/share/` — NOT `/s/`, `/c/` or any other
 * top-level letter:
 *   · `app/s/[code]/page.tsx` is already the guest booking-confirmation short
 *     link (`lib/booking-confirmation-link.ts:71`). Next refuses two different
 *     slug names at one level, so `/s/[token]` cannot coexist, and renaming it
 *     would merge confirmations and collateral into one resolver;
 *   · any NEW top-level segment (`/l`, `/c`, `/share`) needs an
 *     `isSharedTopLevelRoute` / `SHARED_TOP_LEVEL_ROUTES` entry or HeadPinz
 *     visitors 404 (CLAUDE.md hard rule), and this programme edits no
 *     middleware;
 *   · `/api/*` is already served on every host with no middleware change
 *     (`middleware.ts:216-226`, `:1024`).
 * A link in a delivered text or email outlives every refactor, so moving this
 * constant later breaks links already in guests' phones. It does not move.
 *
 * THE TOKEN IS THE CREDENTIAL. There is no shared secret to check: 128 bits
 * from `crypto.randomBytes` is the capability, and the route is the third
 * documented public `/api/crm/**` exception (brief R3). It fails CLOSED —
 * an unknown token is a 404, an expired or revoked one a 410, and neither
 * answer reveals whether a file exists.
 *
 * WHAT EXPIRY CANNOT DO. The blob is stored `access: "public"`, so the URL the
 * 302 points at is permanent. Expiry, revoke and archive close the TOKENISED
 * HOP — they do not reach a guest who already opened the link, or a rep who
 * forwarded the card's Preview URL. The ShareSheet says so in those words;
 * making revocation real would mean streaming the bytes through this route
 * instead of redirecting, which is a deliberate trade nobody has asked for.
 *
 * R2 (Neon first): the row is written before anything is handed to a guest, so
 * a link that reaches a phone always has a row behind it.
 */

import { randomBytes, createHash } from "node:crypto";
import { CRM_SHARE_PATH, type ShareChannel, type ShareLink } from "../contracts";
import { bumpCollateralShares, getCollateral } from "../data/collateral-db";
import { findShareLead, type ShareLeadRef } from "./lead-ref";
import {
  expireDueShareLinks,
  getShareLinkForOpen,
  insertShareLink,
  listShareLinks,
  mapShareLinkRow,
  revokeShareLink,
  type ShareLinkForOpen,
  type ShareLinkRowRaw,
} from "../data/share-links-db";

export { CRM_SHARE_PATH };

/** 16 bytes → 22 base64url characters. Not guessable, not enumerable. */
export const SHARE_TOKEN_BYTES = 16;
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export const DEFAULT_SHARE_DAYS = 30;
export const MAX_SHARE_DAYS = 365;

export function mintShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/** The path a guest opens. Relative — the caller adds the origin it serves on. */
export function sharePathFor(token: string): string {
  return CRM_SHARE_PATH + encodeURIComponent(token);
}

/**
 * The absolute link a rep copies. Always PRODUCTION-shaped: a share sent from
 * a preview would carry a `*.vercel.app` host that sits behind Vercel
 * Authentication, so the guest would meet a Vercel login instead of a flyer.
 * `CRM_SHARE_ORIGIN` overrides it for a local probe; nothing else does.
 */
export const DEFAULT_SHARE_ORIGIN = "https://headpinz.com";

export function shareOrigin(): string {
  const raw = (process.env.CRM_SHARE_ORIGIN || "").trim();
  if (!raw) return DEFAULT_SHARE_ORIGIN;
  return raw.replace(/\/+$/, "");
}

export function shareUrlFor(token: string, origin: string = shareOrigin()): string {
  return origin.replace(/\/+$/, "") + sharePathFor(token);
}

export function expiresAtFor(days: number, now: Date): Date {
  const clamped = Math.max(1, Math.min(MAX_SHARE_DAYS, Math.floor(days)));
  return new Date(now.getTime() + clamped * 24 * 60 * 60 * 1000);
}

function toShareLink(row: ShareLinkRowRaw): ShareLink {
  return mapShareLinkRow(row, shareUrlFor(row.token));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateShareInput {
  collateralId: string;
  /** A numeric lead id or an `L-1042` public id; anything else resolves to null. */
  lead?: string | null;
  contactId?: string | null;
  repId?: string | null;
  channel?: ShareChannel;
  expiresInDays?: number;
  actorEmail: string;
  now?: Date;
}

export interface CreateShareResult {
  share: ShareLink;
  lead: ShareLeadRef | null;
}

export class ShareError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ShareError";
    this.code = code;
  }
}

/** Dependencies so the tests can drive the whole flow without Neon. */
export interface ShareDeps {
  getCollateral: typeof getCollateral;
  findShareLead: typeof findShareLead;
  insertShareLink: typeof insertShareLink;
  bumpCollateralShares: typeof bumpCollateralShares;
  recordActivity: (input: ShareActivityInput) => Promise<void>;
}

export interface ShareActivityInput {
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  actorEmail: string;
  subject: string;
  body: string;
  externalRef: string;
  meta: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Neon first, guest second (R2): `crm_share_links` is written, the share count
 * is bumped, and a `crm_activities` row is filed BEFORE the URL is returned to
 * the rep — so a link that exists in a phone always has a row and a timeline
 * entry behind it. The activity is `kind:'reachout'` with `direction:'out'`:
 * sharing a flyer is a touch, and C7's accountability counts touches.
 *
 * The activity write is the ONE step allowed to fail quietly. It is a timeline
 * nicety; refusing the share because the timeline insert failed would lose the
 * link the rep is about to paste. It is logged with the actor either way.
 */
export async function createShare(
  input: CreateShareInput,
  deps: ShareDeps = liveShareDeps(),
): Promise<CreateShareResult> {
  const now = input.now ?? new Date();
  const item = await deps.getCollateral(input.collateralId);
  if (!item) throw new ShareError("collateral_not_found");
  if (item.archivedAt) throw new ShareError("collateral_archived");

  const lead = input.lead ? await deps.findShareLead(input.lead) : null;
  const token = mintShareToken();
  const channel: ShareChannel = input.channel ?? "link";
  const row = await deps.insertShareLink({
    token,
    collateralId: item.id,
    leadId: lead?.id ?? null,
    contactId: input.contactId ?? null,
    repId: input.repId ?? null,
    channel,
    expiresAt: expiresAtFor(input.expiresInDays ?? DEFAULT_SHARE_DAYS, now),
    createdBy: input.actorEmail,
  });
  await deps.bumpCollateralShares(item.id);

  const share = toShareLink(row);
  try {
    await deps.recordActivity({
      leadId: lead?.id ?? null,
      contactId: input.contactId ?? null,
      repId: input.repId ?? null,
      actorEmail: input.actorEmail,
      subject: `Shared ${item.title}`,
      body: share.url,
      externalRef: token,
      meta: {
        collateralId: item.id,
        title: item.title,
        type: item.type,
        channel,
        expiresAt: share.expiresAt,
      },
      occurredAt: now,
    });
  } catch (err) {
    console.error("[crm] share activity not recorded", {
      actor_email: input.actorEmail,
      token,
      collateralId: item.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { share, lead };
}

// ---------------------------------------------------------------------------
// Opening (the public route)
// ---------------------------------------------------------------------------

/**
 * An open is counted ONCE PER VIEWER-MINUTE. A mail client pre-fetching the
 * link, a double tap, and the browser's own retry after a redirect are all one
 * human looking at one flyer; counting each of them would make "41 shares, 38
 * opens" a number nobody trusts. The key is a salted hash of the viewer's IP
 * and user agent plus the minute — it identifies repeats without storing
 * anything that identifies a person.
 */
export function openKeyFor(input: {
  token: string;
  ip: string | null;
  userAgent: string | null;
  now: Date;
}): string {
  const minute = Math.floor(input.now.getTime() / 60000);
  return createHash("sha256")
    .update(`${input.token}|${input.ip ?? ""}|${input.userAgent ?? ""}|${minute}`)
    .digest("base64url")
    .slice(0, 32);
}

export type ShareOpenOutcome =
  | { kind: "redirect"; url: string; title: string; openCount: number }
  | { kind: "gone" }
  | { kind: "not_found" };

export function isShareExpired(
  row: Pick<ShareLinkForOpen, "expired_at" | "expires_at" | "collateral_archived_at">,
  now: Date,
): boolean {
  if (row.expired_at) return true;
  if (row.collateral_archived_at) return true;
  if (!row.expires_at) return false;
  const at = Date.parse(row.expires_at);
  return Number.isFinite(at) && at <= now.getTime();
}

export interface OpenShareDeps {
  getShareLinkForOpen: typeof getShareLinkForOpen;
  recordShareOpen: (token: string, openKey: string) => Promise<number>;
}

/**
 * The guest path. Cheap by design: ONE select, ONE update, then a 302 to the
 * blob URL. Nothing here reads a session, a cookie or a header beyond the two
 * used for the open key.
 */
export async function openShare(
  token: string,
  ctx: { ip: string | null; userAgent: string | null; now?: Date },
  deps: OpenShareDeps,
): Promise<ShareOpenOutcome> {
  if (!SHARE_TOKEN_RE.test(token)) return { kind: "not_found" };
  const now = ctx.now ?? new Date();
  const row = await deps.getShareLinkForOpen(token);
  if (!row) return { kind: "not_found" };
  if (isShareExpired(row, now)) return { kind: "gone" };

  const openCount = await deps.recordShareOpen(
    token,
    openKeyFor({ token, ip: ctx.ip, userAgent: ctx.userAgent, now }),
  );
  return { kind: "redirect", url: row.blob_url, title: row.title, openCount };
}

// ---------------------------------------------------------------------------
// Listing / revoking / expiring
// ---------------------------------------------------------------------------

export async function listSharesFor(filter: {
  collateralId?: string | null;
  leadId?: string | null;
  limit?: number | null;
}): Promise<ShareLink[]> {
  const rows = await listShareLinks(filter);
  return rows.map(toShareLink);
}

export async function revokeShare(token: string): Promise<boolean> {
  return revokeShareLink(token);
}

export async function expireShareLinks(now: Date = new Date()): Promise<number> {
  return expireDueShareLinks(now);
}

function liveShareDeps(): ShareDeps {
  return {
    getCollateral,
    findShareLead,
    insertShareLink,
    bumpCollateralShares,
    /**
     * The timeline row goes through the activities sub's OWN writer
     * (`recordActivity`, B3) — one writer per table, so the
     * `(external_kind, external_ref)` idempotency and the `actor_email`
     * requirement (R9) live in one place rather than in every sub that files a
     * touch. Imported lazily so the collateral barrel does not pull the leads
     * graph in for callers that never share.
     */
    recordActivity: async (a) => {
      const { recordActivity } = await import("~/features/crm/activities");
      await recordActivity({
        leadId: a.leadId,
        contactId: a.contactId,
        repId: a.repId,
        actorEmail: a.actorEmail,
        kind: "reachout",
        direction: "out",
        occurredAt: a.occurredAt,
        subject: a.subject,
        body: a.body,
        externalKind: "crm-share",
        externalRef: a.externalRef,
        meta: a.meta,
      });
    },
  };
}
