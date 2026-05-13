/**
 * KBF Welcome Email — renderer + send helpers.
 *
 * Loads `emails/kbf-welcome.html`, fills placeholders from a
 * `KbfPassWithMembers` record, and sends via the shared SendGrid
 * helper. Tracks sends via `kbf_passes.welcome_email_sent_at`.
 *
 * Two entry points:
 *   - `renderWelcomeEmail(pass)` — pure render, no side-effects
 *   - `sendWelcomeEmails({ limit, dryRun })` — query unsent → render
 *     → send → mark sent. Called by the cron after sync and by the
 *     manual preview/send endpoint.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { sql, isDbConfigured } from "@/lib/db";
import { sendEmail } from "@/lib/sendgrid";
import type { KbfPassWithMembers, KbfMemberRow } from "@/lib/kbf-prefs";

// ── Template cache ─────────────────────────────────────────────────────────

let templateCache: string | null = null;
function loadTemplate(): string {
  if (!templateCache) {
    templateCache = readFileSync(
      join(process.cwd(), "emails", "kbf-welcome.html"),
      "utf-8",
    );
  }
  return templateCache;
}

// ── Center metadata ────────────────────────────────────────────────────────

const CENTER_META: Record<
  string,
  { shortName: string; locationSlug: string; phone: string }
> = {
  "HeadPinz Fort Myers": {
    shortName: "Fort Myers",
    locationSlug: "fortmyers",
    phone: "(239) 302-2155",
  },
  "HeadPinz Naples": {
    shortName: "Naples",
    locationSlug: "naples",
    phone: "(239) 455-3755",
  },
};

// ── DB: ensure column + queries ────────────────────────────────────────────

let columnReady = false;

/** Idempotent — safe to call on every request. */
async function ensureWelcomeColumn(): Promise<void> {
  if (columnReady) return;
  if (!isDbConfigured()) return;
  const q = sql();
  await q`ALTER TABLE kbf_passes ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ`;
  columnReady = true;
}

/**
 * Return passes that have NOT received a welcome email yet, with
 * members attached. Excludes test accounts.
 *
 * @param limit     Max passes to return.
 * @param recentMinutes  When set, only returns passes whose
 *   `first_synced_at` is within the last N minutes — i.e. brand-new
 *   registrations from the most recent sync cycle(s). Used by the
 *   sync cron to send immediate welcome emails to new sign-ups.
 *   When omitted, returns ALL unsent passes oldest-first (backfill).
 */
export async function getUnsentWelcomePasses(
  limit: number = 50,
  recentMinutes?: number,
): Promise<KbfPassWithMembers[]> {
  if (!isDbConfigured()) return [];
  await ensureWelcomeColumn();
  const q = sql();

  type PassRow = {
    id: number;
    email: string;
    center_name: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    preferred_2fa: string | null;
    is_test: boolean | null;
    fpass: boolean | null;
  };

  const passRows: PassRow[] = recentMinutes
    ? ((await q`
        SELECT id, email, center_name, first_name, last_name, phone,
               preferred_2fa, is_test, fpass
        FROM kbf_passes
        WHERE welcome_email_sent_at IS NULL
          AND is_test = false
          AND first_synced_at > NOW() - make_interval(mins => ${recentMinutes})
        ORDER BY first_synced_at ASC
        LIMIT ${limit}
      `) as PassRow[])
    : ((await q`
        SELECT id, email, center_name, first_name, last_name, phone,
               preferred_2fa, is_test, fpass
        FROM kbf_passes
        WHERE welcome_email_sent_at IS NULL
          AND is_test = false
        ORDER BY first_synced_at ASC NULLS FIRST
        LIMIT ${limit}
      `) as PassRow[]);

  if (passRows.length === 0) return [];

  const passIds = passRows.map((r) => r.id);
  const memberRows = (await q`
    SELECT id, pass_id, relation, slot, first_name, last_name,
           birthday, redemptions, games
    FROM kbf_pass_members
    WHERE pass_id = ANY(${passIds}::int[])
    ORDER BY pass_id ASC, relation ASC, slot ASC
  `) as Array<{
    id: number;
    pass_id: number;
    relation: string;
    slot: number;
    first_name: string | null;
    last_name: string | null;
    birthday: string | null;
    redemptions: number | null;
    games: number | null;
  }>;

  // Build KbfPassWithMembers[]
  const passes: KbfPassWithMembers[] = passRows.map((r) => ({
    id: r.id,
    email: r.email,
    centerName: r.center_name,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    phone: r.phone,
    preferred2fa: r.preferred_2fa === "sms" ? ("sms" as const) : ("email" as const),
    isTest: r.is_test === true,
    fpass: r.fpass === true,
    members: [],
  }));

  const passById = new Map(passes.map((p) => [p.id, p]));
  for (const m of memberRows) {
    const pass = passById.get(m.pass_id);
    if (!pass) continue;
    pass.members.push({
      id: m.id,
      passId: m.pass_id,
      relation: m.relation === "family" ? "family" : "kid",
      slot: m.slot,
      firstName: m.first_name ?? "",
      lastName: m.last_name ?? "",
      birthday: m.birthday ?? "",
      redemptions: m.redemptions ?? 0,
      games: m.games ?? 0,
      prefs: null,
    });
  }

  return passes;
}

/** Mark passes as sent. */
export async function markWelcomeEmailSent(passIds: number[]): Promise<void> {
  if (!isDbConfigured() || passIds.length === 0) return;
  await ensureWelcomeColumn();
  const q = sql();
  await q`
    UPDATE kbf_passes
    SET welcome_email_sent_at = NOW()
    WHERE id = ANY(${passIds}::int[])
  `;
}

// ── Render ─────────────────────────────────────────────────────────────────

export function renderWelcomeEmail(pass: KbfPassWithMembers): string {
  const tpl = loadTemplate();
  const center = CENTER_META[pass.centerName] ?? {
    shortName: pass.centerName.replace("HeadPinz ", ""),
    locationSlug: "fortmyers",
    phone: "(239) 302-2155",
  };

  const isFbf = pass.fpass;

  // Program badge
  const programName = isFbf ? "Families Bowl Free" : "Kids Bowl Free";
  const programDescription = isFbf
    ? "Everyone bowls free — kids and adults included!"
    : "Registered kids bowl free all summer long.";
  const programBorderColor = isFbf ? "#90CAF9" : "#A5D6A7";
  const programBgColor = isFbf ? "#E3F2FD" : "#E8F5E9";
  const programIconBg = isFbf ? "#BBDEFB" : "#C8E6C9";

  // Adult pricing
  const adultPricingNote = isFbf
    ? "Everyone bowls free with Family Pass."
    : "Adults pay $5/game Mon–Thu, $6/game Fri.";
  const adultPricingDetail = isFbf
    ? "Your Families Bowl Free pass covers the whole family — kids and adults get 2 free games per day."
    : "Each registered kid gets 2 free games per day. Adults can join for $10 (Mon–Thu) or $12 (Fri) per session. Add adults when you book online.";

  // Booking link
  const bookingLink = `https://headpinz.com/hp/book/kids-bowl-free?location=${center.locationSlug}`;

  // Member rows
  const memberRowsHtml = renderMemberRows(pass.members, isFbf);

  // Replace all placeholders
  let html = tpl;
  html = html.replace(
    /\^\[ParentFirstName\]\$/g,
    escapeHtml(pass.firstName || "there"),
  );
  html = html.replace(
    /\^\[CenterName\]\$/g,
    escapeHtml(center.shortName),
  );
  html = html.replace(/\^\[ProgramName\]\$/g, escapeHtml(programName));
  html = html.replace(
    /\^\[ProgramDescription\]\$/g,
    escapeHtml(programDescription),
  );
  html = html.replace(/\^\[ProgramBorderColor\]\$/g, programBorderColor);
  html = html.replace(/\^\[ProgramBgColor\]\$/g, programBgColor);
  html = html.replace(/\^\[ProgramIconBg\]\$/g, programIconBg);
  html = html.replace(/\^\[MemberRows\]\$/g, memberRowsHtml);
  html = html.replace(
    /\^\[AdultPricingNote\]\$/g,
    escapeHtml(adultPricingNote),
  );
  html = html.replace(
    /\^\[AdultPricingDetail\]\$/g,
    escapeHtml(adultPricingDetail),
  );
  html = html.replace(/\^\[CenterPhone\]\$/g, center.phone);
  html = html.replace(/\^\[BookingLink\]\$/g, bookingLink);

  return html;
}

// ── Member row HTML ────────────────────────────────────────────────────────

function renderMemberRows(
  members: KbfMemberRow[],
  isFbf: boolean,
): string {
  if (members.length === 0) {
    return `<tr><td style="padding: 14px 16px; font-family: Arial, sans-serif; font-size: 13px; color: #999; text-align: center;">No bowlers registered yet.</td></tr>`;
  }

  return members
    .map((m, i) => {
      const isLast = i === members.length - 1;
      const initial = (m.firstName || "?").charAt(0).toUpperCase();
      const name = `${m.firstName} ${m.lastName}`.trim() || "Unnamed";

      const isKid = m.relation === "kid";
      const isFree = isKid || isFbf;

      const badgeBg = isFree ? "#E8F5E9" : "#FFF3E0";
      const badgeColor = isFree ? "#2E7D32" : "#E65100";
      const badgeText = isFree ? "FREE" : "$5–6/GAME";

      return `<tr>
  <td style="padding: 10px 16px;${isLast ? "" : " border-bottom: 1px solid #F0F0F0;"} font-family: Arial, sans-serif;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr>
    <td width="32" valign="middle">
      <div style="width: 28px; height: 28px; border-radius: 50%; background-color: #E3F2FD; text-align: center; line-height: 28px; font-size: 13px; color: #1565C0; font-weight: bold;">${initial}</div>
    </td>
    <td style="padding-left: 10px; font-size: 14px; color: #1A1A1A; font-weight: 600;">${escapeHtml(name)}</td>
    <td align="right">
      <span style="display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; background-color: ${badgeBg}; color: ${badgeColor};">${badgeText}</span>
    </td>
    </tr>
    </table>
  </td>
</tr>`;
    })
    .join("\n");
}

// ── Send batch ─────────────────────────────────────────────────────────────

export interface WelcomeEmailResult {
  total: number;
  sent: number;
  failed: number;
  errors: Array<{ passId: number; email: string; error: string }>;
}

/**
 * Fetch unsent passes, render, and send welcome emails. Returns a
 * summary. Each successfully-sent pass is marked immediately so a
 * crash mid-batch doesn't double-send.
 */
export async function sendWelcomeEmailBatch(
  limit: number = 50,
  recentMinutes?: number,
): Promise<WelcomeEmailResult> {
  const passes = await getUnsentWelcomePasses(limit, recentMinutes);
  const result: WelcomeEmailResult = {
    total: passes.length,
    sent: 0,
    failed: 0,
    errors: [],
  };

  for (const pass of passes) {
    try {
      const html = renderWelcomeEmail(pass);
      const subject = pass.fpass
        ? "Welcome to Families Bowl Free at HeadPinz!"
        : "Welcome to Kids Bowl Free at HeadPinz!";
      const plainText = `Hi ${pass.firstName || "there"}, your family is registered for ${pass.fpass ? "Families Bowl Free" : "Kids Bowl Free"} at HeadPinz ${CENTER_META[pass.centerName]?.shortName ?? ""}. Book your free lanes at https://headpinz.com/hp/book/kids-bowl-free`;

      const res = await sendEmail({
        to: pass.email,
        toName: `${pass.firstName} ${pass.lastName}`.trim() || undefined,
        from: { email: "noreply@headpinz.com", name: "HeadPinz Kids Bowl Free" },
        subject,
        html,
        text: plainText,
      });

      if (res.ok) {
        await markWelcomeEmailSent([pass.id]);
        result.sent++;
      } else {
        result.failed++;
        result.errors.push({
          passId: pass.id,
          email: pass.email,
          error: res.error || `status ${res.status}`,
        });
      }
    } catch (err) {
      result.failed++;
      result.errors.push({
        passId: pass.id,
        email: pass.email,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
