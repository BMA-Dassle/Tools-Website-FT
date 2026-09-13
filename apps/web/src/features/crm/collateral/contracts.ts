/**
 * The collateral sub's WIRE CONTRACT (C6) — what `/api/admin/crm/collateral/**`,
 * `/api/admin/crm/share` and the public `/api/crm/share/[token]` exchange with
 * the client. Lives here rather than in `core/contracts.ts` so this PR never
 * edits a shared core file; client components import it by path.
 *
 * DEPENDENCY-FREE except for types from `core/types`. Ids are strings on the
 * wire (Neon bigints as text), dates are ISO instants or `YYYY-MM-DD`.
 */

import type { CentreCode } from "../core/types";

/** The public redirect path; pinned by `service/share.test.ts` (brief C6). */
export const CRM_SHARE_PATH = "/api/crm/share/";

/** `crm_collateral.type` — the file-kind label the card shows ("PDF · 310 KB"). */
export type CollateralType = "PDF" | "PPTX" | "DOCX" | "XLSX" | "PNG" | "JPG" | "FILE";
export const COLLATERAL_TYPES = [
  "PDF",
  "PPTX",
  "DOCX",
  "XLSX",
  "PNG",
  "JPG",
  "FILE",
] as const satisfies readonly CollateralType[];

/** Where a piece of collateral sits against today's date (season validity). */
export type CollateralValidity = "current" | "upcoming" | "expired";

export interface CollateralItem {
  id: string;
  title: string;
  /** null = every centre ("All" in the prototype). */
  centre: CentreCode | null;
  type: CollateralType;
  blobUrl: string;
  blobPathname: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  tags: string[];
  /** YYYY-MM-DD or null */
  validFrom: string | null;
  validUntil: string | null;
  /** Lifetime share count (`crm_collateral.shares`). */
  shares: number;
  uploadedBy: string | null;
  updatedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollateralTagCount {
  tag: string;
  n: number;
}

/** GET /collateral */
export interface CollateralListResponse {
  ok: true;
  items: CollateralItem[];
  /** Pass back as `?cursor=` for the next page; null when this was the last. */
  nextCursor: string | null;
  tags: CollateralTagCount[];
  /** False → the Upload button says so and "Add by URL" is the only way in. */
  blobConfigured: boolean;
}

/** POST /collateral — create the metadata row (after a client upload, or for an existing public URL). */
export interface CollateralCreateBody {
  title: string;
  centre?: CentreCode | null;
  type?: CollateralType;
  blobUrl: string;
  blobPathname?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  tags?: string[];
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface CollateralCreateResponse {
  ok: true;
  item: CollateralItem;
}

/** POST /collateral/[id] */
export type CollateralItemPostBody =
  | {
      action: "update";
      patch: Partial<
        Pick<
          CollateralCreateBody,
          "title" | "centre" | "type" | "tags" | "validFrom" | "validUntil" | "blobUrl"
        >
      >;
    }
  | { action: "archive" }
  | { action: "restore" };

export interface CollateralItemResponse {
  ok: true;
  item: CollateralItem;
  shares: ShareLink[];
}

export type ShareChannel = "link" | "sms" | "email";

export interface ShareLink {
  token: string;
  /** The absolute guest URL (`<origin>/api/crm/share/<token>`). */
  url: string;
  collateralId: string;
  leadId: string | null;
  contactId: string | null;
  repId: string | null;
  channel: ShareChannel | null;
  openedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  expiresAt: string | null;
  /** Set by the sweep or a revoke; the public route answers 410. */
  expiredAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** POST /share */
export interface ShareCreateBody {
  collateralId: string;
  /** `L-1042` style public id, or a numeric lead id. Optional. */
  lead?: string | null;
  contactId?: string | null;
  channel?: ShareChannel;
  /** 1–365; default `DEFAULT_SHARE_DAYS`. */
  expiresInDays?: number;
}

export interface ShareCreateResponse {
  ok: true;
  share: ShareLink;
  /** What the seam resolved the `lead` input to, if anything. */
  lead: { id: string; publicId: string; label: string } | null;
  /** Text / email delivery is C1 / C2's; until then the sheet shows why. */
  delivery: { sms: "unavailable"; email: "unavailable"; reason: string };
}

/** GET /share?lead=<id>|collateralId=<id> */
export interface ShareListResponse {
  ok: true;
  shares: ShareLink[];
}

/** POST /share — revoke. */
export interface ShareRevokeBody {
  action: "revoke";
  token: string;
}

// ---------------------------------------------------------------------------
// Message templates (crm_templates)
// ---------------------------------------------------------------------------

export type TemplateKind = "sms" | "email";

export interface Gsm7Verdict {
  ok: boolean;
  /** The first non-GSM-7 character found, when `ok` is false. */
  offending: string | null;
}

export interface MessageTemplate {
  id: string;
  kind: TemplateKind;
  name: string;
  subject: string | null;
  body: string;
  mergeFields: string[];
  centre: CentreCode | null;
  position: number;
  updatedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only for `kind: "sms"` — null for email. */
  gsm7: Gsm7Verdict | null;
}

/** GET /collateral/templates */
export interface TemplatesListResponse {
  ok: true;
  templates: MessageTemplate[];
  /** The 12 merge fields the editor offers, with the sample value the preview uses. */
  mergeFields: { key: string; sample: string; label: string }[];
}

export interface TemplateUpsertInput {
  /** Omit to create. */
  id?: string;
  kind: TemplateKind;
  name: string;
  subject?: string | null;
  body: string;
  centre?: CentreCode | null;
  position?: number;
}

/** POST /collateral/templates */
export type TemplatesPostBody =
  | { action: "upsert"; template: TemplateUpsertInput }
  | { action: "archive"; id: string }
  | { action: "restore"; id: string }
  | { action: "reorder"; ids: string[] };

export interface TemplatesPostResponse {
  ok: true;
  templates: MessageTemplate[];
  template?: MessageTemplate;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * The ONE error code the upload route answers with when Vercel Blob has no
 * token in this environment (brief C6). The screen prints it as a plain
 * sentence and keeps "Add by URL" working, so a missing token degrades the
 * feature instead of breaking it.
 */
export const BLOB_NOT_CONFIGURED = "blob_not_configured";

/** What the screen says when `blobConfigured` is false. */
export const BLOB_NOT_CONFIGURED_MESSAGE =
  "File upload is off: BLOB_READ_WRITE_TOKEN is not set for this deployment. You can still add a file by pasting its public URL.";

/** Upload cap — the biggest thing in the prototype's library is an 8.2 MB deck. */
export const COLLATERAL_MAX_BYTES = 25 * 1024 * 1024;

/** POST /collateral/upload (multipart: `file`, plus the metadata fields). */
export interface CollateralUploadResponse {
  ok: true;
  item: CollateralItem;
}

// ---------------------------------------------------------------------------
// Sharing by text / email — C1 and C2 own those rails
// ---------------------------------------------------------------------------

/**
 * Why the ShareSheet's Text and Email buttons are disabled today. VERBATIM
 * from the build brief's C6 block; the buttons flip on when C1 (`crm/sms`) and
 * C2 (`crm/email`) land, and this constant is what they delete.
 */
export const SHARE_DELIVERY_REASON = "arrives with texting and email";

// ---------------------------------------------------------------------------
// DOM test ids for this screen's pieces
// ---------------------------------------------------------------------------

export const COLLATERAL_TEST_IDS = {
  screen: "crm-collateral-screen",
  search: "crm-collateral-search",
  grid: "crm-collateral-grid",
  loadMore: "crm-collateral-load-more",
  card: (id: string) => "crm-collateral-card-" + id,
  uploadSheet: "crm-collateral-upload",
  shareSheet: "crm-collateral-share",
  templateEditor: "crm-template-editor",
  templatesCard: "crm-templates-card",
  blobBanner: "crm-collateral-blob-banner",
} as const;
