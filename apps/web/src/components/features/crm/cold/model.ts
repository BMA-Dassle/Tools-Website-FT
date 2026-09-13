import {
  COLD_CALLBACK,
  COLD_CLOSED_DISPOSITIONS,
  COLD_INTERESTED,
  COLD_MATCH_LABEL,
  type ColdDisposition,
  type ColdImportReport,
  type ColdListStats,
  type ColdListView,
  type ColdRowView,
} from "~/features/crm/cold/contracts";
import type { ChipKind } from "~/features/crm/core/types";

/**
 * Pure helpers behind the two cold screens (`crm-shared.js:439-443`). No hooks,
 * no fetch, no React — which is the only way the fiddly bits (a row with no
 * company, a number Excel broke, a percentage of zero) stay right, and the only
 * way they can be unit-tested at all.
 *
 * CLIENT-SAFE by construction: type-only imports from the sub's `contracts`,
 * never from its `index.ts` (§5.7b).
 */

/** The prototype's `pct(a, b)` — a whole-number percentage, 0 when there is nothing. */
export function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/** What a row is called: the company, else the contact, else the number. */
export function rowTitle(row: Pick<ColdRowView, "company" | "contactName" | "phoneRaw">): string {
  return row.company ?? row.contactName ?? row.phoneRaw ?? "—";
}

/** The number to show, canonical if we have one, otherwise what the file said. */
export function rowNumber(row: Pick<ColdRowView, "phoneE164" | "phoneRaw">): string | null {
  return row.phoneE164 ?? row.phoneRaw ?? null;
}

/** The chip hue for an outcome: interest is a win, a refusal is a loss. */
export function dispositionKind(d: ColdDisposition | null): ChipKind | undefined {
  if (!d) return undefined;
  if (d === COLD_INTERESTED) return "won";
  if (COLD_CLOSED_DISPOSITIONS.includes(d)) return "lost";
  if (d === COLD_CALLBACK) return "warn";
  return "open";
}

/** "Matched · Phone" — what the review table and the row meta say. */
export function matchLabel(row: Pick<ColdRowView, "matchedBy">): string | null {
  return row.matchedBy ? COLD_MATCH_LABEL[row.matchedBy] : null;
}

/** A row can be converted once, and only while it is in play. */
export function canConvert(row: ColdRowView): boolean {
  return !row.leadId && row.status !== "skipped";
}

/** A row is worth ringing when it has a number and nobody has rung it. */
export function isDialable(row: ColdRowView): boolean {
  return Boolean(row.phoneE164) && row.status === "ready";
}

/** A callback the rep promised, whose time has come. */
export function callbackDue(row: ColdRowView, now: Date): boolean {
  if (!row.callbackAt) return false;
  const at = new Date(row.callbackAt);
  return !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime();
}

/** The list's sub-line (`crm-shared.js:439`). */
export function statsLine(s: ColdListStats): string {
  return `${s.rows} rows · ${s.called} called · ${s.interested} interested · ${s.booked} booked`;
}

/** The lists screen's right-hand line (`crm-shared.js:442`). */
export function listMeta(list: ColdListView): string[] {
  const out = [`${list.stats.rows} rows`];
  if (list.ownerRepName) out.push(list.ownerRepName);
  if (list.sourceFilename) out.push(list.sourceFilename);
  if (list.status === "staged") out.push("import not finished");
  return out;
}

/**
 * The sentences the Import sheet's review step shows, in plain numbers.
 * Deliberately says what will happen to each group, because "7 rows match" on
 * its own does not tell the operator whether anything is about to be lost.
 */
export function importSummary(report: ColdImportReport): string[] {
  const lines: string[] = [];
  lines.push(
    `${report.rows} ${report.rows === 1 ? "row" : "rows"} read · ${report.withPhone} with a number · ${report.withEmail} with an email`,
  );
  if (report.matched > 0) {
    lines.push(
      `${report.matched} ${report.matched === 1 ? "row matches" : "rows match"} an account or contact we already have — linked, not duplicated.`,
    );
  }
  if (report.duplicatesInFile > 0) {
    lines.push(
      `${report.duplicatesInFile} ${report.duplicatesInFile === 1 ? "row repeats" : "rows repeat"} a number or email from earlier in the same file.`,
    );
  }
  if (report.undialable > 0) {
    lines.push(
      `${report.undialable} ${report.undialable === 1 ? "number" : "numbers"} could not be read — the row is kept with the number exactly as the file wrote it.`,
    );
  }
  if (report.unreachable > 0) {
    lines.push(
      `${report.unreachable} ${report.unreachable === 1 ? "row has" : "rows have"} neither a number nor an email. Map another column, or import them anyway.`,
    );
  }
  return lines;
}

/** The example account named in the match banner, when there is one. */
export function firstMatchExample(report: ColdImportReport): string | null {
  const hit = report.matches.find((m) => m.accountName ?? m.company);
  return hit ? (hit.accountName ?? hit.company ?? null) : null;
}

/** Nothing worth importing — say so instead of showing an empty table. */
export function reportIsEmpty(report: ColdImportReport): boolean {
  return report.rows === 0;
}
