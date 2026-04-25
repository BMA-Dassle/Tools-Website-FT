import { NextResponse } from "next/server";

/**
 * GET /contact.vcf
 *
 * Public vCard for the HeadPinz / FastTrax Fort Myers location.
 * Returns text/vcard so iOS Safari + Android browsers + email
 * clients recognize the file as an importable contact card on
 * tap rather than triggering a generic download.
 *
 * Update content here (not in /public/*.vcf) — keeping it in a
 * route handler means revisions don't need a static-file purge,
 * and we set proper headers (charset, suggested filename, cache
 * lifetime) without a custom rewrite rule.
 */

const vcard = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:HeadPinz Family Entertainment",
  "ORG:HeadPinz Family Entertainment",
  // ADR fields: PO-Box;Extended;Street;Locality;Region;Postal;Country
  "ADR;TYPE=WORK:;;14501 Global Parkway;Fort Myers;FL;33913;USA",
  "TEL;TYPE=WORK,VOICE:+12394819666",
  "EMAIL;TYPE=WORK,INTERNET:guestservices@headpinz.com",
  "URL:https://headpinz.com",
  "URL:https://fasttraxent.com",
  "UID:headpinz-fasttrax-fortmyers",
  "REV:2026-04-25T00:00:00Z",
  "END:VCARD",
  "",
].join("\r\n");

export function GET() {
  return new NextResponse(vcard, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      // Suggested filename when the user explicitly downloads.
      // `inline` (vs `attachment`) lets phones auto-open the import
      // sheet rather than dropping the file in Downloads.
      "Content-Disposition": 'inline; filename="headpinz-fasttrax.vcf"',
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
