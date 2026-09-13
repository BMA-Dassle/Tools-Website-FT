import type {
  CollateralItem,
  CollateralTagCount,
  MessageTemplate,
} from "~/features/crm/collateral/contracts";
import { BLOB_NOT_CONFIGURED } from "~/features/crm/collateral/contracts";
import { sizeLabel, validityOf } from "~/features/crm/collateral/service/library";
import { CENTRES, CENTRE_CODES } from "~/features/crm/core/centres";
import { ET } from "~/features/crm/core/dates";
import type { CentreCode } from "~/features/crm/core/types";
import type { SegOption } from "../primitives/Seg";

/**
 * Pure model for the Collateral screen — every decision the JSX makes, made
 * here so it is testable without rendering (brief R12: component tests are
 * pure modules). Helper consts stay at MODULE scope, never in a render body
 * (memory `feedback_tdz_component_const_helpers`).
 */

export const ALL_FOLDER = "all";

/**
 * `Sep 1, 2026` — the prototype's own `fDateY` (crm-shared.js:72), which is
 * month-day-year with NO weekday. `core/dates.ts`'s `fDateY` prints
 * "Tue, Sep 1, 2026"; that extra word is fine on a timeline row and too long
 * for a 3-up card's meta line and for an "Expired …" chip, and the prototype
 * is the acceptance spec here. ET, like every date this CRM renders (R10).
 */
const F_LIBRARY_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function fLibraryDate(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : F_LIBRARY_DATE.format(d);
}

/**
 * The folder strip, ported from `crm-shared.js:482`:
 *   All · HP Fort Myers · FastTrax · HP Naples · <tags, most used first>
 * The centres come from the registry (their real short names), the tags from
 * the library itself — the prototype's hard-coded "Pricing · Birthday ·
 * Corporate · Holiday" are simply the tags its seed data happened to hold.
 */
export function folderOptions(tags: readonly CollateralTagCount[]): SegOption<string>[] {
  return [
    { value: ALL_FOLDER, label: "All" },
    ...CENTRE_CODES.map((c) => ({ value: `centre:${c}`, label: CENTRES[c].short })),
    ...tags.map((t) => ({ value: `tag:${t.tag}`, label: titleCase(t.tag), badge: t.n })),
  ];
}

export function titleCase(tag: string): string {
  return tag.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export interface FolderSelection {
  centre: CentreCode | null;
  tag: string | null;
}

export function folderValue(sel: FolderSelection): string {
  if (sel.centre) return `centre:${sel.centre}`;
  if (sel.tag) return `tag:${sel.tag}`;
  return ALL_FOLDER;
}

export function selectionFromFolder(value: string): FolderSelection {
  if (value.startsWith("centre:")) {
    const code = value.slice(7);
    return {
      centre: (CENTRE_CODES as readonly string[]).includes(code) ? (code as CentreCode) : null,
      tag: null,
    };
  }
  if (value.startsWith("tag:")) return { centre: null, tag: value.slice(4) || null };
  return { centre: null, tag: null };
}

/** What the URL holds, and what it means. `?centre=` and `?tag=` are the view. */
export function selectionFromQuery(query: Record<string, string>): FolderSelection {
  const centre = query.centre;
  return {
    centre: (CENTRE_CODES as readonly string[]).includes(centre ?? "")
      ? (centre as CentreCode)
      : null,
    tag: query.tag || null,
  };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export interface CollateralCardModel {
  /** "HPFM · PDF · 310 KB · updated Sep 1" — the prototype's meta line. */
  meta: string;
  validity: "current" | "upcoming" | "expired";
  /** The chip beside the title, or null when the file is simply current. */
  validityLabel: string | null;
  /** The prototype shows the share count unless the file is new. */
  sharesLabel: string;
  isNew: boolean;
}

const NEW_DAYS = 14;

/** The prototype's `isNew` flag, derived rather than authored: uploaded recently. */
export function isNewCollateral(item: CollateralItem, now: Date): boolean {
  const at = Date.parse(item.createdAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < NEW_DAYS * 24 * 60 * 60 * 1000;
}

export function collateralCardModel(
  item: CollateralItem,
  todayYmd: string,
  now: Date,
): CollateralCardModel {
  const validity = validityOf(item, todayYmd);
  const parts = [item.centre ?? "All", item.type];
  const size = sizeLabel(item.sizeBytes);
  if (size) parts.push(size);
  parts.push(`updated ${fLibraryDate(item.updatedAt)}`);
  return {
    meta: parts.join(" · "),
    validity,
    validityLabel:
      validity === "expired"
        ? `Expired ${item.validUntil ? fLibraryDate(item.validUntil) : ""}`.trim()
        : validity === "upcoming"
          ? `From ${item.validFrom ? fLibraryDate(item.validFrom) : ""}`.trim()
          : null,
    sharesLabel: `${item.shares} share${item.shares === 1 ? "" : "s"}`,
    isNew: isNewCollateral(item, now),
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** The prototype's row preview: subject then the first 110 characters. */
export function templatePreview(t: MessageTemplate, max = 110): string {
  const head = t.subject ? `${t.subject} — ` : "";
  const body = t.body.replace(/\s+/g, " ").trim();
  return head + (body.length > max ? `${body.slice(0, max)}…` : body);
}

export function templatesByKind(templates: readonly MessageTemplate[]) {
  return {
    sms: templates.filter((t) => t.kind === "sms"),
    email: templates.filter((t) => t.kind === "email"),
  };
}

/** How many SMS templates would cost double today. Drives the list's warning. */
export function gsm7Offenders(templates: readonly MessageTemplate[]): MessageTemplate[] {
  return templates.filter((t) => t.kind === "sms" && t.gsm7 && !t.gsm7.ok);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Server error codes → the sentence a rep reads. Anything unmapped falls
 * through to the server's own message, which `withCrmRoute` already keeps free
 * of hostnames and SQL.
 */
const MESSAGES: Record<string, string> = {
  [BLOB_NOT_CONFIGURED]:
    "File upload is off for this deployment — paste the file's public link instead.",
  no_file: "Pick a file first.",
  file_too_big: "That file is too big. The limit is 25 MB.",
  unsupported_file_type: "We can share PDF, PowerPoint, Word, Excel and image files.",
  collateral_not_found: "That file is no longer in the library.",
  collateral_archived: "That file is archived — restore it before sharing.",
  share_not_found: "That link was already removed.",
  template_not_found: "That template is no longer here.",
  director_only: "Only a sales director can change the library.",
};

export function collateralMessage(error: string): string {
  const code = error.split(":")[0]?.trim() ?? error;
  return MESSAGES[code] ?? error;
}
