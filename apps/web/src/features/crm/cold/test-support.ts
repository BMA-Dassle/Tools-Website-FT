/**
 * THE UGLY FIXTURE — a cold-list CSV with everything real files do to us.
 * Test-only; never imported by production code (the index does not export it).
 *
 * Built deliberately, item by item, because a tidy fixture proves nothing
 * (memory `feedback_fixture_must_match_the_ugly_case`):
 *
 *   header  a UTF-8 BOM in front of the first header (Excel writes one); a
 *           header quoted because it contains a space; and a DUPLICATE "Phone"
 *           header, which must not collapse two columns into one key
 *   row 1   a surname-first contact ("Okafor, Devon") inside quotes
 *           and a quoted cell containing the delimiter
 *   —       a completely blank row in the middle of the file
 *   row 2   a phone written with dots, and an email with surrounding
 *           whitespace and capitals
 *   row 3   a phone with an extension ("x12") and a cell containing a doubled
 *           quote ("call in January")
 *   row 4   no contact name at all, and a RAGGED row (one cell short)
 *   row 6   the SAME phone and email as row 1 — an in-file duplicate
 *   row 7   a number Excel turned into scientific notation, which cannot be
 *           dialled and must be reported rather than silently dropped
 *   row 8   a quoted cell containing a real newline
 *   end     no trailing newline
 *
 * CRLF throughout except the embedded newline, which is a bare LF — mixed
 * endings in one file, exactly like a file that has been through two machines.
 */

import { BOM } from "./csv";

const LINES: string[] = [
  '"Business Name",Primary Contact,Phone,Email,City,Notes,Phone',
  'BrightPath Dental,"Okafor, Devon",(239) 555-7015,devon@brightpath.example,Fort Myers,"Chamber list, tech night",239-555-7016',
  "",
  "Coastal Title Co.,Renata Silva,239.555.3110,  RENATA@CoastalTitle.example  ,Cape Coral,,",
  'Meridian IT,Paul Ostrowski,+1 (239) 555-4471 x12,paul@meridian.example,Fort Myers,"Said ""call in January""",',
  "Palm Legal Group,,2395552060,,Naples,No contact name",
  "SWFL Orthodontics,Dr. Hale,(239) 555-8817,hale@swflortho.example,Fort Myers,,",
  "Duplicate Dental,Devon Okafor,(239) 555-7015,devon@brightpath.example,Fort Myers,rang them twice,",
  "Broken Phone Co,Sam Vane,2.39556E+09,sam@broken.example,Estero,Excel ruined the number,",
  '"Riverside Church",Pastor Gomez,(239) 555-9001,office@riverside.example,Fort Myers,"Line one\nLine two",',
];

/** The file as the browser reads it: BOM, CRLF, no trailing newline. */
export const UGLY_CSV = BOM + LINES.join("\r\n");

/** The same content with semicolons, for the delimiter-sniffing test. */
export const UGLY_CSV_SEMICOLON = BOM + LINES.map(semicolonise).join("\r\n");

/** Swap top-level commas for semicolons without touching quoted cells. */
function semicolonise(line: string): string {
  let out = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    out += ch === "," && !quoted ? ";" : ch;
  }
  return out;
}

/** What the headers must come out as: the second "Phone" disambiguated. */
export const UGLY_HEADERS = [
  "Business Name",
  "Primary Contact",
  "Phone",
  "Email",
  "City",
  "Notes",
  "Phone (2)",
];

/** Eight data rows survive: ten lines minus the header and the blank one. */
export const UGLY_ROW_COUNT = 8;

/** Exactly one row is short of a cell (Palm Legal Group). */
export const UGLY_RAGGED_ROWS = 1;
