/**
 * What the composer needs before a rep types anything: WHO the message goes
 * out as, WHO it goes to, and the email templates merged for this lead.
 *
 * THE GUEST SERVICES RULE (owner, brief §5.7b, binding): when the acting
 * user's rep row is the `gs` bucket, the sender mailbox is the SHARED
 * `guestservices@headpinz.com` box and the acting call-centre agent's own
 * address is CC-ed, so the agent sees the reply thread as well as the shared
 * mailbox. Every other rep sends as themselves with no CC.
 *
 * A rep with no mailbox (the `mkt` hold row, a director with no `crm_reps`
 * row) cannot send: `resolveSender` returns a REFUSAL rather than guessing a
 * from-address. Same shape as the per-tenant Office id rule — never a guess.
 *
 * `mergeTemplate` is the prototype's token table (crm-shared.js:285) moved
 * server-side, because R11 puts guest-facing copy in `crm_templates` with a
 * SERVER-side merge. C6's `collateral/service/merge.ts` will absorb it at
 * release; the token list and the "missing token stays visible as
 * `{{token}}`" behaviour are the same on purpose.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureTemplatesSchema } from "../../collateral";
import { CENTRES } from "../../core/centres";
import { fDate } from "../../core/dates";
import type { CrmUser } from "../../core/types";
import type { LeadView } from "../../leads/contracts";
import { EVENT_TYPE_LABEL } from "../../leads/contracts";
import type { EmailSenderView, EmailTemplateView } from "../contracts";
import { graphConfigured, type GraphReadiness } from "./graph-client";
import { crmEmailEnabled } from "../../core/flags";

/** The bucket whose sends go out from the shared mailbox with the agent CC-ed. */
export const GUEST_SERVICES_SLUG = "gs";

export class NoSenderMailboxError extends Error {
  constructor(readonly reason: "no_rep" | "no_mailbox") {
    super(reason === "no_rep" ? "no_rep_row" : "no_sender_mailbox");
    this.name = "NoSenderMailboxError";
  }
}

/**
 * The Graph sender for this signed-in person. Throws rather than falling back
 * to a shared noreply address: a guest reply must land somewhere a human reads.
 */
export const CRM_EMAIL_OFF_REASON =
  "Graph sending is switched off by the CRM_EMAIL kill switch — messages go out through SendGrid.";

export function resolveSender(user: CrmUser): EmailSenderView {
  const rep = user.rep;
  if (!rep) throw new NoSenderMailboxError("no_rep");
  if (!rep.email) throw new NoSenderMailboxError("no_mailbox");
  const isBucket = rep.slug === GUEST_SERVICES_SLUG;
  const own = user.email.trim().toLowerCase();
  const mailbox = rep.email.trim().toLowerCase();
  const enabled = crmEmailEnabled();
  return {
    mailbox,
    displayName: rep.displayName,
    repId: rep.id,
    repSlug: rep.slug,
    cc: isBucket && own && own !== mailbox ? [own] : [],
    // Env-only, and therefore optimistic: `applyReadiness` is what turns this
    // into the truth once the tenant's consent has been read.
    graph: enabled && graphConfigured(),
    graphReason: enabled ? null : CRM_EMAIL_OFF_REASON,
  };
}

/**
 * Fold in what the tenant actually consented to. Without this the composer
 * would promise "through Microsoft Graph" and then quietly fall back — which
 * is precisely the lie the chip exists to prevent.
 */
export function applyReadiness(
  sender: EmailSenderView,
  readiness: GraphReadiness,
): EmailSenderView {
  if (!sender.graph) return sender;
  if (readiness.ready) return { ...sender, graph: true, graphReason: null };
  return { ...sender, graph: false, graphReason: readiness.reason };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeContext {
  lead: LeadView;
  repFirstName: string;
}

/** The twelve tokens the prototype defines, in its own order (crm-shared.js:285). */
export const MERGE_TOKENS = [
  "guest.first",
  "rep.first",
  "centre.short",
  "centre.name",
  "event.date",
  "event.type",
  "event.guests",
  "hold.until",
  "contract.link",
  "lastYear.date",
  "account.name",
  "quote.sentAgo",
] as const;

export type MergeToken = (typeof MERGE_TOKENS)[number];

/**
 * Values for this lead. Tokens whose data the CRM does not hold yet
 * (`hold.until`, `contract.link`, `quote.sentAgo`) resolve to null so
 * `mergeTemplate` LEAVES THE TOKEN VISIBLE — a rep sees `{{hold.until}}` and
 * fixes it, rather than sending a sentence with a hole in it (C6's rule:
 * "missing field highlighted, never silently blank").
 */
export function mergeValues(ctx: MergeContext): Record<MergeToken, string | null> {
  const { lead } = ctx;
  const centre = CENTRES[lead.centre];
  return {
    "guest.first": lead.guest.first || null,
    "rep.first": ctx.repFirstName || null,
    "centre.short": centre?.short ?? null,
    "centre.name": centre?.name ?? null,
    "event.date": lead.eventDate ? fDate(lead.eventDate) : null,
    "event.type": EVENT_TYPE_LABEL[lead.type]?.toLowerCase() ?? null,
    "event.guests": lead.guests ? String(lead.guests) : null,
    "hold.until": null,
    "contract.link": null,
    // The CRM holds last year's PROJECT id, never its date — B1's mirror is
    // what will supply it. Null keeps `{{lastYear.date}}` visible.
    "lastYear.date": null,
    "account.name": lead.guest.company || null,
    "quote.sentAgo": null,
  };
}

/** `{{a.b}}` → its value; an unknown or unresolved token is left as written. */
export function mergeTemplate(text: string, values: Record<string, string | null>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, token: string) => {
    const v = values[token];
    return v == null || v === "" ? whole : v;
  });
}

/** Every `{{token}}` still unresolved after a merge — what the UI highlights. */
export function unresolvedTokens(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface TemplateRowRaw {
  id: string;
  name: string;
  subject: string | null;
  body: string;
}

/**
 * The live `kind='email'` templates, merged for this lead.
 *
 * Read straight from `crm_templates` here rather than through the collateral
 * sub's readers because C6 owns those and has not landed; the release stage
 * swaps this query for `listTemplates('email')` and inherits the guard below.
 * It is a SELECT of one seeded table with no writes, so nothing here can
 * collide with C6.
 *
 * TWO GUARDS, both earned. `crm_templates` belongs to the collateral sub, so
 * this is the one read in this sub that cannot rely on `ensureEmailSchema()`:
 * `ensureCrmSchema()` runs on the tool page and in the job routes, but NOT in
 * `withCrmRoute`, so a cold API instance that never rendered the page has no
 * guarantee the table exists — hence `ensureTemplatesSchema()` first. And if
 * the read fails anyway, an empty picker is a far better composer than a 500
 * whose fixed `unexpected` code tells the rep nothing.
 */
export async function emailTemplatesFor(ctx: MergeContext): Promise<EmailTemplateView[]> {
  if (!isDbConfigured()) return [];
  let rows: TemplateRowRaw[];
  try {
    await ensureTemplatesSchema();
    const q = sql();
    rows = (await q`
      SELECT id::text AS id, name, subject, body
        FROM crm_templates
       WHERE kind = 'email' AND archived_at IS NULL
       ORDER BY position ASC, id ASC
       LIMIT 50
    `) as TemplateRowRaw[];
  } catch (err) {
    console.error("[crm] email templates unavailable", {
      lead_id: ctx.lead.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  const values = mergeValues(ctx);
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    subject: mergeTemplate(r.subject ?? "", values),
    body: mergeTemplate(r.body, values),
  }));
}

// ---------------------------------------------------------------------------
// Message-ID
// ---------------------------------------------------------------------------

export const MESSAGE_ID_DOMAIN = "headpinz.com";

/**
 * Our own RFC 5322 Message-ID, so a reply's `In-Reply-To` names a row we can
 * find. It carries the lead's public id for a human reading a header dump; the
 * MATCH is by the stored string, never by parsing this back out.
 */
export function crmMessageId(publicId: string, rand: string): string {
  const safe = publicId.replace(/[^A-Za-z0-9-]/g, "") || "L";
  return `<CRM-${safe}-${rand}@${MESSAGE_ID_DOMAIN}>`;
}
