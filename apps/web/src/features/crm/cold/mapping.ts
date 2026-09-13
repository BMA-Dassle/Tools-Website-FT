/**
 * Column mapping: which of the operator's columns is the company, which is the
 * phone, and so on — plus the projection that turns one stored raw record into
 * the typed fields the dialling list uses.
 *
 * THE OWNER HAS NOT TOLD US WHICH COLUMNS THEIR FILES HAVE (decision D9, brief
 * §5.8). So the aliases below are a STARTING GUESS that the operator always
 * sees and can always override on the Import sheet — never a schema. A file
 * whose headers match nothing still imports: every field simply starts at
 * "(skip)" and the operator picks. Getting the guess wrong costs a dropdown;
 * hard-coding a schema would cost the import.
 *
 * PURE AND CLIENT-SAFE. `canonicalizePhone` is imported rather than
 * re-implemented so the cold list and `createLead` can never disagree about
 * what a phone number is; that module has no imports of its own.
 */

import { canonicalizePhone } from "@/lib/participant-contact";
import { COLD_FIELDS, type ColdColumnMap, type ColdField } from "./contracts";
import type { CsvRecord, CsvTable } from "./csv";

/**
 * Header spellings we have seen or expect, per field, most specific first.
 * Compared on a squashed key (lowercase, letters and digits only), so
 * "E-mail Address", "email_address" and "Email Address" are one entry.
 */
const ALIASES: Record<ColdField, readonly string[]> = {
  company: [
    "company",
    "companyname",
    "business",
    "businessname",
    "organisation",
    "organization",
    "organisationname",
    "organizationname",
    "org",
    "account",
    "accountname",
    "employer",
    "firm",
    "dba",
    "practice",
    "school",
    "schoolname",
  ],
  contactName: [
    "contact",
    "contactname",
    "primarycontact",
    "fullname",
    "name",
    "contactperson",
    "attn",
    "attention",
    "owner",
    "decisionmaker",
  ],
  firstName: ["firstname", "first", "givenname", "fname", "forename"],
  lastName: ["lastname", "last", "surname", "lname", "familyname"],
  phone: [
    "phone",
    "phonenumber",
    "telephone",
    "tel",
    "mobile",
    "mobilephone",
    "cell",
    "cellphone",
    "businessphone",
    "workphone",
    "officephone",
    "mainphone",
    "direct",
    "directline",
    "contactnumber",
  ],
  email: [
    "email",
    "emailaddress",
    "email1",
    "mail",
    "workemail",
    "businessemail",
    "contactemail",
    "primaryemail",
  ],
  city: ["city", "town", "cityname", "municipality", "locality", "citystate"],
  notes: [
    "notes",
    "note",
    "comments",
    "comment",
    "remarks",
    "description",
    "details",
    "source",
    "industry",
    "category",
  ],
  bmiPersonId: ["bmipersonid", "personid", "bmiid", "smstimingpersonid", "guestid"],
};

/** "E-mail Address" → "emailaddress" */
export function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Score one header against one field. Exact alias beats "the alias is a whole
 * word inside the header" beats "the header merely contains it", so
 * "Phone" wins over "Phone Type" and "Business Name" maps to company rather
 * than to contact just because it contains "name".
 */
export function scoreHeader(field: ColdField, header: string): number {
  const key = headerKey(header);
  if (!key) return 0;
  const aliases = ALIASES[field];
  for (let i = 0; i < aliases.length; i++) {
    const a = aliases[i] as string;
    const rank = aliases.length - i;
    if (key === a) return 1000 + rank;
    if (key.startsWith(a) || key.endsWith(a)) return 500 + rank;
    if (key.includes(a)) return 100 + rank;
  }
  return 0;
}

/**
 * The default map for a set of headers. Each field takes the best-scoring
 * header that no better-scoring field has already claimed, so a file with both
 * "Contact Name" and "Company Name" does not put the same column in two
 * places. Fields with no candidate stay unmapped, which the sheet shows as
 * "(skip)".
 *
 * `contactName` is dropped when both halves of a split name matched, because a
 * file with First/Last usually also has a "Name" column that is the two joined
 * — mapping all three would double the name in the record.
 */
export function suggestColumnMap(headers: readonly string[]): ColdColumnMap {
  const pairs: { field: ColdField; header: string; score: number }[] = [];
  for (const field of COLD_FIELDS) {
    for (const header of headers) {
      const score = scoreHeader(field, header);
      if (score > 0) pairs.push({ field, header, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));

  const map: ColdColumnMap = {};
  const takenHeaders = new Set<string>();
  for (const p of pairs) {
    if (map[p.field] !== undefined) continue;
    if (takenHeaders.has(p.header)) continue;
    map[p.field] = p.header;
    takenHeaders.add(p.header);
  }
  if (map.firstName && map.lastName && map.contactName) delete map.contactName;
  return map;
}

/** Headers a map does not use — what the sheet lists under "not imported". */
export function unmappedHeaders(headers: readonly string[], map: ColdColumnMap): string[] {
  const used = new Set(Object.values(map).filter((h): h is string => typeof h === "string"));
  return headers.filter((h) => !used.has(h));
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One raw record, read through a map. Every field may be null. */
export interface ColdProjection {
  company: string | null;
  contactName: string | null;
  /** Exactly what the cell said. */
  phoneRaw: string | null;
  /** Canonical E.164, or null when the cell could not be read as a number. */
  phoneE164: string | null;
  email: string | null;
  emailKey: string | null;
  city: string | null;
  notes: string | null;
  bmiPersonId: string | null;
}

export const EMPTY_PROJECTION: ColdProjection = Object.freeze({
  company: null,
  contactName: null,
  phoneRaw: null,
  phoneE164: null,
  email: null,
  emailKey: null,
  city: null,
  notes: null,
  bmiPersonId: null,
});

function cell(values: Record<string, unknown>, header: string | null | undefined): string | null {
  if (!header) return null;
  const v = values[header];
  if (typeof v !== "string") return v === undefined || v === null ? null : String(v).trim() || null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * A trailing extension. `\b` is deliberately NOT used before the marker: in
 * "555-4471x12" the `x` sits between two word characters, so a word boundary
 * never matches and the extension would be read as part of the number. The
 * anchor is the end of the string plus a short run of digits instead, which
 * only fires where an extension actually is.
 */
const EXTENSION = /\s*(?:x|ext\.?|extension|#)\s*\d{1,6}\s*$/i;

/**
 * A dialable number, or null. The digits go through `canonicalizePhone` (the
 * same function `createLead` uses), so the cold list can never think a number
 * is fine that the lead rail would reject. The only pre-step is dropping a
 * trailing extension — "(239) 555-7015 ext 12" is a perfectly good number with
 * a note attached, and twelve digits would otherwise fail.
 */
export function coldPhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(EXTENSION, "").trim();
  return canonicalizePhone(trimmed);
}

/** Lowercased and trimmed — the same key `crm_contacts.email_key` stores. */
export function coldEmailKey(raw: string | null): string | null {
  const k = (raw ?? "").trim().toLowerCase();
  if (!k || !k.includes("@")) return null;
  return k;
}

/**
 * A BMI person id STAYS A STRING (CLAUDE.md hard rule — 17-digit ids exceed
 * Number.MAX_SAFE_INTEGER). Anything that is not a run of digits is discarded
 * rather than coerced, because a rounded id is worse than no id.
 */
export function coldBmiPersonId(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return /^\d{1,20}$/.test(t) ? t : null;
}

function joinName(first: string | null, last: string | null, whole: string | null): string | null {
  const pair = [first, last].filter(Boolean).join(" ").trim();
  return pair || whole;
}

/** Read one stored raw record through a map. */
export function projectRecord(values: Record<string, unknown>, map: ColdColumnMap): ColdProjection {
  const phoneRaw = cell(values, map.phone);
  const email = cell(values, map.email);
  return {
    company: cell(values, map.company),
    contactName: joinName(
      cell(values, map.firstName),
      cell(values, map.lastName),
      cell(values, map.contactName),
    ),
    phoneRaw,
    phoneE164: coldPhone(phoneRaw),
    email,
    emailKey: coldEmailKey(email),
    city: cell(values, map.city),
    notes: cell(values, map.notes),
    bmiPersonId: coldBmiPersonId(cell(values, map.bmiPersonId)),
  };
}

/** Nothing to ring, nothing to write to — the row can still be kept, but say so. */
export function isUnreachable(p: ColdProjection): boolean {
  return !p.phoneE164 && !p.emailKey;
}

/** A phone cell was filled in and we could not read it. */
export function isUndialable(p: ColdProjection): boolean {
  return Boolean(p.phoneRaw) && !p.phoneE164;
}

/**
 * Split a single "Contact" cell into the two halves `createLead` wants.
 *
 * Deliberately dumb: first token is the first name, the REST is the surname,
 * so "Renata Silva" and "Paul Van Der Berg" both come out right and
 * "Dr. Hale" comes out as first "Dr." / last "Hale" — which the convert sheet
 * shows in two editable boxes for the rep to correct. Guessing harder (titles,
 * suffixes, "Last, First") would be wrong more interestingly, not less often.
 */
export function splitPersonName(whole: string | null): { firstName: string; lastName: string } {
  const t = (whole ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { firstName: "", lastName: "" };
  // "Silva, Renata" — the one inversion common enough to be worth handling.
  const comma = t.indexOf(",");
  if (comma > 0) {
    const last = t.slice(0, comma).trim();
    const first = t.slice(comma + 1).trim();
    if (last && first) return { firstName: first, lastName: last };
  }
  const parts = t.split(" ");
  if (parts.length === 1) return { firstName: parts[0] as string, lastName: "" };
  return { firstName: parts[0] as string, lastName: parts.slice(1).join(" ") };
}

/** The label a row shows when it has no company: the contact, else the number. */
export function rowLabel(p: Pick<ColdProjection, "company" | "contactName" | "phoneRaw">): string {
  return p.company ?? p.contactName ?? p.phoneRaw ?? "—";
}

/** Preview the first rows of a parsed file through a candidate map. */
export function previewProjection(
  table: Pick<CsvTable, "records">,
  map: ColdColumnMap,
  n = 5,
): { record: CsvRecord; projection: ColdProjection }[] {
  return table.records.slice(0, n).map((record) => ({
    record,
    projection: projectRecord(record.values, map),
  }));
}
