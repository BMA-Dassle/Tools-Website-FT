/**
 * THE PRIVATE-MEMO SECTION PARSER — pure, no imports, client-safe.
 *
 * One BMI field (`projectLog.memo`, `public === false`) has three writers and
 * each keeps its own section so none can erase another (R6):
 *
 *   ── FastTrax Web ──  …  ── End FastTrax Web ──
 *        the website's contract rail: contract / PDF / waiver links plus its
 *        own timestamped log lines (`lib/bmi-office-actions.ts:1328-1329`).
 *   ----- Portal Staff -----
 *        the food-out sync's section, everything after the separator
 *        (`src/features/daily-events/constants.ts:418`, `PORTAL_SEPARATOR`;
 *        `syncBmiNotes` rewrites exactly this slice and deliberately preserves
 *        a FastTrax Web block that landed AFTER it — hence "nested").
 *   anything else
 *        what a member of staff typed into Office by hand, and the CRM's own
 *        appended lines (which ride INSIDE the FastTrax Web section).
 *
 * The CRM only DISPLAYS these. It appends through `appendProjectPrivateNote`
 * and never writes `projectLog` itself, so this parser has no write path to
 * get wrong — but it must never lose text: `sectionsCoverMemo` (used by the
 * tests) proves every character of the memo lands in exactly one section.
 *
 * The marker strings are duplicated here ON PURPOSE: importing them would pull
 * `lib/bmi-office-actions.ts` (node `https`, Redis) into the browser bundle.
 * `sections.test.ts` asserts they still equal the server's constants.
 */

import type { PrivateNoteSection, PrivateSectionKey } from "../contracts";

export const WEB_SECTION_START = "── FastTrax Web ──";
export const WEB_SECTION_END = "── End FastTrax Web ──";
export const PORTAL_SECTION_MARKER = "----- Portal Staff -----";

export const SECTION_LABEL: Record<PrivateSectionKey, string> = {
  staff: "Staff notes",
  web: "FastTrax Web section",
  portal: "Portal Staff section",
};

interface Slice {
  text: string;
  rest: string;
}

/**
 * Cut the FastTrax Web block out of a memo. A start with no matching end takes
 * everything to the memo's end (a truncated write must still be shown, not
 * silently merged into the staff notes).
 */
export function cutWebSection(memo: string): Slice | null {
  const start = memo.indexOf(WEB_SECTION_START);
  if (start < 0) return null;
  const endMarker = memo.indexOf(WEB_SECTION_END, start + WEB_SECTION_START.length);
  const end = endMarker >= 0 ? endMarker + WEB_SECTION_END.length : memo.length;
  return {
    text: memo.slice(start + WEB_SECTION_START.length, endMarker >= 0 ? endMarker : memo.length),
    rest: memo.slice(0, start) + memo.slice(end),
  };
}

/**
 * The memo split into the sections the Notes tab renders, in display order:
 * staff free text, the FastTrax Web block, then the Portal Staff line. A
 * section whose text is blank is dropped — except `portal`, which is kept
 * whenever the marker is present (its "(No staff assigned)" IS the answer).
 */
export function parsePrivateMemo(memo: string | null | undefined): PrivateNoteSection[] {
  const source = typeof memo === "string" ? memo : "";
  if (!source.trim()) return [];

  const web = cutWebSection(source);
  const remainder = web ? web.rest : source;

  const portalIdx = remainder.indexOf(PORTAL_SECTION_MARKER);
  const staffText = (portalIdx >= 0 ? remainder.slice(0, portalIdx) : remainder).trim();
  const portalText =
    portalIdx >= 0 ? remainder.slice(portalIdx + PORTAL_SECTION_MARKER.length).trim() : null;

  const out: PrivateNoteSection[] = [];
  if (staffText)
    out.push({ key: "staff", label: SECTION_LABEL.staff, marker: null, text: staffText });
  if (web) {
    out.push({
      key: "web",
      label: SECTION_LABEL.web,
      marker: WEB_SECTION_START,
      text: web.text.trim(),
    });
  }
  if (portalText !== null) {
    out.push({
      key: "portal",
      label: SECTION_LABEL.portal,
      marker: PORTAL_SECTION_MARKER,
      text: portalText,
    });
  }
  return out;
}

/** The `Food Out: 4:45 PM` line inside the Portal Staff section, or null. */
export function foodOutFromMemo(memo: string | null | undefined): string | null {
  const portal = parsePrivateMemo(memo).find((s) => s.key === "portal");
  if (!portal) return null;
  const m = /Food Out:\s*(.+)/i.exec(portal.text);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

/**
 * Test seam: every non-whitespace character of the memo appears in exactly one
 * section. A parser that drops a staff note is worse than no parser at all.
 */
export function sectionsCoverMemo(memo: string, sections: PrivateNoteSection[]): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "");

  // Whitespace and the markers themselves are structure, not content.
  let rest = strip(memo);
  for (const marker of [WEB_SECTION_START, WEB_SECTION_END, PORTAL_SECTION_MARKER]) {
    const m = strip(marker);
    for (let at = rest.indexOf(m); at >= 0; at = rest.indexOf(m)) {
      rest = rest.slice(0, at) + rest.slice(at + m.length);
    }
  }

  // Take each section's content out wherever it sits — the NESTED memo orders
  // its sections portal-then-web while we DISPLAY web-then-portal, so this
  // cannot be a concatenation check.
  for (const section of sections) {
    const text = strip(section.text);
    if (!text) continue;
    const at = rest.indexOf(text);
    if (at < 0) return false;
    rest = rest.slice(0, at) + rest.slice(at + text.length);
  }
  return rest === "";
}
