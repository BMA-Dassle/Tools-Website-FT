/**
 * Build chargeback rebuttal write-ups (HTML -> PDF) for the two live disputes.
 *
 * READ-ONLY with respect to Square and Neon: this only renders facts already
 * verified by dispute-forensics.mts / dispute-card-sweep.mts and the Neon probes.
 * It uploads nothing. Submission stays manual and irreversible.
 *
 * Usage: npx tsx scripts/dispute-evidence-build.mts [outDir]
 *   outDir defaults to C:\Work
 */
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const OUT = process.argv[2] ?? "C:\\Work";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/* ────────────────────────────────────────────────────────────────────
   Verbatim policy copy. Sources of truth:
     - components/booking/ClickwrapCheckbox.tsx  (checkbox label + modal body)
     - lib/clickwrap.ts                          (CURRENT_POLICY_VERSION)
     - app/waiver-3/page.tsx                     (dispute/chargeback clauses)
   Keep these strings in sync if the source copy changes.
   ──────────────────────────────────────────────────────────────────── */

const CLICKWRAP_LABEL = `I agree to our cancellation &amp; payment policy. All reservations are final and
subject to this policy. Your payment card may be securely retained by our payment processor to cover
approved changes to your reservation, and is removed within 72 hours after your visit unless you choose
to save it.`;

const CLICKWRAP_POLICY = {
  intro: "Reservations are confirmed immediately upon payment. All sales are final.",
  cancellations: [
    "Cancellations must be made <strong>more than 2 hours</strong> before your reservation to be eligible for a refund or credit.",
    "Cancellations within <strong>2 hours</strong> of your reservation are <strong>non-refundable</strong>, no exceptions.",
    "All cancellation and reschedule requests must be made by <strong>phone or SMS</strong> at (239) 481-9666. Online requests are not accepted.",
  ],
  disputes: [
    "If you have a concern about a charge, please <strong>contact us first</strong> at (239) 481-9666 before contacting your bank. We can typically resolve issues within one business day.",
    "Initiating a chargeback without first contacting FastTrax Entertainment may result in suspension of booking privileges.",
  ],
  retention: [
    "Your payment card may be securely retained by our payment processor to cover approved changes to your reservation, and is removed within 72 hours after your visit unless you choose to save it.",
  ],
  closing:
    "By checking the box and completing payment, you acknowledge that you have read, understood, and agreed to this policy.",
};

const WAIVER_TITLE =
  "Release and Waiver of Liability, Indemnity, Confidentiality, and Credit Card Dispute Agreement";
const WAIVER_DISPUTE_CLAUSES = [
  "<strong>All sales are final</strong> once services or Attractions are rendered or accessed.",
  "Refunds or adjustments are granted <strong>solely at management&rsquo;s discretion</strong>.",
  "I agree to a <strong>Good-Faith Resolution Requirement</strong>, meaning that I must first contact the Company directly to resolve any billing or service concern before taking any outside action.",
  "Failure to contact the Company before filing a credit-card dispute or chargeback shall constitute a <strong>material breach of this Agreement</strong>.",
  "I will <strong>not initiate or pursue any credit-card chargeback</strong> based on dissatisfaction with service, staff, experience quality, food or beverage quality, race timing, equipment condition, or facility operations.",
  "I authorize the Company to present this signed waiver and transaction records as <strong>conclusive evidence of authorization</strong> if a chargeback is filed in violation of this Agreement.",
  "I agree to reimburse the Company for any costs, fees, or penalties incurred responding to or reversing such disputes.",
];

const CSS = `
:root { --ink:#111827; --muted:#5b6472; --line:#d7dce3; --accent:#0b3d91; --warn:#8a1c1c; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: var(--ink);
       font-size: 10.5pt; line-height: 1.5; margin: 0; }
h1 { font-size: 17pt; margin: 0 0 2pt; letter-spacing: -0.2pt; }
h2 { font-size: 11.5pt; margin: 18pt 0 6pt; padding-bottom: 3pt;
     border-bottom: 1.5px solid var(--accent); color: var(--accent);
     text-transform: uppercase; letter-spacing: 0.4pt; page-break-after: avoid; }
h3 { font-size: 10.5pt; margin: 12pt 0 4pt; page-break-after: avoid; }
p { margin: 0 0 7pt; }
.sub { color: var(--muted); font-size: 9.5pt; }
.hdr { border-bottom: 2.5px solid var(--accent); padding-bottom: 9pt; margin-bottom: 4pt; }
.brand { font-size: 9pt; letter-spacing: 1.6pt; text-transform: uppercase;
         color: var(--accent); font-weight: 700; margin-bottom: 5pt; }
.meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3pt 20pt;
        margin: 10pt 0 4pt; font-size: 9.5pt; }
.meta div { border-bottom: 1px dotted var(--line); padding-bottom: 2pt; }
.meta span { color: var(--muted); display: inline-block; min-width: 108px; }
.verdict { border-left: 4px solid var(--accent); background: #f2f5fb;
           padding: 9pt 12pt; margin: 12pt 0; page-break-inside: avoid; }
.verdict strong { color: var(--accent); }
table { width: 100%; border-collapse: collapse; margin: 7pt 0 10pt; font-size: 9.5pt; }
th { text-align: left; background: #eef1f6; border: 1px solid var(--line);
     padding: 5pt 7pt; font-weight: 600; }
td { border: 1px solid var(--line); padding: 5pt 7pt; vertical-align: top; }
td.num { text-align: right; white-space: nowrap; }
.mono { font-family: Consolas, "Courier New", monospace; font-size: 8.7pt; word-break: break-all; }
ul { margin: 0 0 8pt; padding-left: 16pt; }
li { margin-bottom: 3.5pt; }
.quote { border: 1px solid var(--line); border-left: 3px solid #9aa6b8; background: #fafbfd;
         padding: 9pt 12pt; margin: 7pt 0 10pt; page-break-inside: avoid; }
.quote .cap { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.7pt;
              color: var(--muted); margin-bottom: 5pt; font-weight: 600; }
.note { font-size: 9pt; color: var(--muted); font-style: italic; margin-top: 5pt; }
.flag { border-left: 3px solid var(--warn); background: #fdf4f4; padding: 8pt 11pt;
        margin: 9pt 0; font-size: 9.5pt; page-break-inside: avoid; }
.foot { margin-top: 20pt; padding-top: 7pt; border-top: 1px solid var(--line);
        font-size: 8.5pt; color: var(--muted); }
.key { background: #fff6d9; padding: 0 2px; font-weight: 600; }
@page { size: Letter; margin: 14mm 15mm; }
`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const header = (brand: string, title: string, meta: [string, string][]) => `
<div class="hdr">
  <div class="brand">${brand}</div>
  <h1>${title}</h1>
  <div class="sub">Merchant response to chargeback &mdash; prepared ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
</div>
<div class="meta">${meta.map(([k, v]) => `<div><span>${k}</span> ${v}</div>`).join("")}</div>`;

const clickwrapExhibit = (heading: string) => `
<h2>${heading}</h2>
<p>Before payment can be submitted, our checkout requires the customer to affirmatively check a
policy-agreement box. The Pay button is disabled until it is checked. This is the exact text
displayed beside that checkbox:</p>
<div class="quote">
  <div class="cap">Checkbox label shown at checkout</div>
  ${CLICKWRAP_LABEL}
</div>
<p>The linked policy opens in-page. Its full text, including the section on disputes, reads:</p>
<div class="quote">
  <div class="cap">Cancellation &amp; Payment Policy &mdash; version ${"v3-2026-07-11"}</div>
  <p>${CLICKWRAP_POLICY.intro}</p>
  <h3>Cancellations &amp; Reschedules</h3>
  <ul>${CLICKWRAP_POLICY.cancellations.map((s) => `<li>${s}</li>`).join("")}</ul>
  <h3>Disputes &amp; Chargebacks</h3>
  <ul>${CLICKWRAP_POLICY.disputes.map((s) => `<li>${s}</li>`).join("")}</ul>
  <h3>Payment Card Retention</h3>
  <ul>${CLICKWRAP_POLICY.retention.map((s) => `<li>${s}</li>`).join("")}</ul>
  <p style="margin-top:8pt"><strong>${CLICKWRAP_POLICY.closing}</strong></p>
</div>`;

const waiverExhibit = (signedNote: string, signedBlock = "") => `
<h2>Exhibit &mdash; Participant Waiver: Credit Card Dispute Terms</h2>
<p>All guests accessing our attractions are required to execute the
<em>${WAIVER_TITLE}</em>. The agreement contains an express chargeback provision, reproduced
verbatim below:</p>
<div class="quote">
  <div class="cap">Credit Card Dispute and Refund Waiver</div>
  <ul>${WAIVER_DISPUTE_CLAUSES.map((s) => `<li>${s}</li>`).join("")}</ul>
</div>
${signedBlock}
<p class="note">${signedNote}</p>`;

/** Ciotola executed this waiver personally — signature on file. */
const CIOTOLA_WAIVER_BLOCK = `
<h3>This cardholder personally executed this waiver</h3>
<table>
  <tr><th style="width:34%">Waiver field</th><th>Value on the signed document</th></tr>
  <tr><td>First name</td><td class="key">salvatore</td></tr>
  <tr><td>Last name</td><td class="key">Ciotola</td></tr>
  <tr><td>Date of birth</td><td>May 1, 1978</td></tr>
  <tr><td>Contact number given</td><td>540-786-185 (area code 540 matches the booking contact)</td></tr>
  <tr><td>Executed</td><td class="key">December 31, 2025, 2:44 PM &mdash; signature affixed on all four pages</td></tr>
  <tr><td>Still in force on the service date?</td><td class="key">Yes &mdash; see Duration and Validity below</td></tr>
</table>
<div class="quote">
  <div class="cap">Duration and Validity &mdash; verbatim from the signed waiver</div>
  This waiver shall remain <strong>valid indefinitely</strong> for the signer and any minors listed
  below, unless and until the Company issues an updated waiver or modifies its terms, attractions, or
  policies.
</div>
<p>The waiver executed on December 31, 2025 was therefore in full force on
<strong>July 24, 2026</strong>, the date of the disputed transaction and the date of service. The
name on the signed waiver &mdash; <strong>Ciotola, salvatore</strong> &mdash; matches the
<strong>AVS-verified billing name on the disputed card</strong>.</p>
<div class="verdict">
  By signing this document the cardholder expressly agreed, in advance, that he would
  <strong>not initiate or pursue any credit-card chargeback</strong>, that failing to contact us
  first would constitute a <strong>material breach</strong>, and &mdash; directly on point here
  &mdash; he <strong>authorized the Company to present this signed waiver and transaction records as
  conclusive evidence of authorization if a chargeback is filed in violation of this Agreement</strong>.
  He filed this chargeback without ever contacting us.
</div>`;

/* ─────────────────────────── Dispute 1 ─────────────────────────── */

const d1 = page(
  "Dispute 7LgzFaOjCUKwtb3RommPB - Merchant Rebuttal",
  header("FastTrax Entertainment &mdash; Fort Myers, FL", "Chargeback Rebuttal: No Duplicate Transaction Exists", [
    ["Dispute ID", '<span class="mono">7LgzFaOjCUKwtb3RommPB</span>'],
    ["Network case", "849407509"],
    ["Disputed amount", "$100.59 USD"],
    ["Original payment", "$240.59 USD"],
    ["Reason code", "DUPLICATE"],
    ["Payment ID", '<span class="mono">FyAmXzYU0E1keNEyGTcP7xcMMK8YY</span>'],
    ["Card", "Mastercard ending 1140"],
    ["Transaction date", "July 24, 2026, 3:21:33 PM ET"],
    ["Cardholder", "Salvatore Ciotola"],
    ["Evidence due", "August 7, 2026"],
  ]) +
    `
<div class="verdict">
  <strong>Summary:</strong> The cardholder was charged <strong>exactly once</strong>. We searched
  <strong>122,277 card payments across all 16 of our locations</strong> from June 1, 2026 through
  August 2, 2026. The card ending 1140 appears in our records
  <strong>one time only</strong> &mdash; the $240.59 transaction now under dispute. There is no
  second charge to this card, at any location, on any date. This booking is also the
  <strong>only reservation this guest has ever made</strong> with us.
</div>

<h2>1. The Transaction</h2>
<table>
  <tr><th style="width:34%">Field</th><th>Value</th></tr>
  <tr><td>Authorized</td><td>July 24, 2026, 3:21:33 PM ET</td></tr>
  <tr><td>Amount</td><td>$240.59 USD</td></tr>
  <tr><td>Description</td><td>Deposit &ndash; WEBFT05903961 &ndash; 2026-07-24</td></tr>
  <tr><td>Card</td><td>Mastercard &bull;&bull;&bull;&bull;1140, exp 11/2028</td></tr>
  <tr><td>Authorization code</td><td>33496Z</td></tr>
  <tr><td>Billing name on card</td><td class="key">Salvatore Ciotola</td></tr>
  <tr><td>Billing address on card</td><td>1485 Overton Drive, Mineral, VA 23117-4483</td></tr>
  <tr><td>AVS result</td><td class="key">AVS_ACCEPTED &mdash; issuer confirmed the billing address matched</td></tr>
  <tr><td>Phone on customer record</td><td>+1 (540) 748-6185 &mdash; matches the phone given at booking</td></tr>
  <tr><td>Entry method</td><td>Keyed (card-not-present, e-commerce)</td></tr>
  <tr><td>Booking reference</td><td>Race reservation W53899 &mdash; 8 kart sessions across 2 racers</td></tr>
  <tr><td>Amount refunded</td><td>$0.00</td></tr>
</table>

<h2>2. Search for a Duplicate &mdash; Result: None</h2>
<p>We ran an exhaustive search keyed on the card's payment-network fingerprint, which identifies the
same physical card across every terminal, website, and location we operate.</p>
<table>
  <tr><th>Search parameter</th><th>Value</th></tr>
  <tr><td>Payments examined</td><td class="num">122,277</td></tr>
  <tr><td>Locations covered</td><td class="num">16 (all)</td></tr>
  <tr><td>Date range</td><td>June 1, 2026 &ndash; August 2, 2026</td></tr>
  <tr><td>Matches on card ending 1140</td><td class="num key">1</td></tr>
  <tr><td>Bookings ever made by this guest</td><td class="num key">1</td></tr>
</table>
<p>A duplicate charge would require a second authorization against the same card. No such
authorization exists in our records.</p>

<h2>3. The Probable Source of the Confusion</h2>
<p>Our deposit flow converts a paid deposit into a stored-value credit, which is then redeemed
against the final bill on the day of the visit. The guest therefore sees <strong>two records for
$240.59</strong> &mdash; but only the first is a charge to the card. The second is the redemption of
credit the guest had already paid for.</p>
<table>
  <tr><th>Time (ET)</th><th>Record</th><th>Tender</th><th class="num">Amount</th></tr>
  <tr>
    <td>Jul 24, 3:21 PM</td>
    <td>Deposit &ndash; WEBFT05903961</td>
    <td class="key">Mastercard &bull;&bull;&bull;&bull;1140</td>
    <td class="num">$240.59</td>
  </tr>
  <tr>
    <td>Jul 24, 6:42 PM</td>
    <td>Day-of race order: 8 &times; Karting, 1 &times; Rookie Pack</td>
    <td><strong>Stored-value credit</strong> (not a card charge)</td>
    <td class="num">$240.59</td>
  </tr>
</table>
<p><strong>Total charged to the card ending 1140: $240.59, one time.</strong> The second line
consumed the credit created by the first; it did not touch the card.</p>

<h2>4. Services Were Delivered</h2>
<ul>
  <li>Reservation W53899 was booked and confirmed on July 24, 2026 for
      <strong>8 kart sessions across 2 racers</strong> &mdash; four consecutive heats each at
      4:36 PM, 5:00 PM, 5:24 PM, and 6:00 PM on the Red track.</li>
  <li>The day-of race order was created and settled at <strong>6:42 PM ET on July 24</strong>,
      posted automatically at the conclusion of the race session.</li>
  <li>Onboard race-video access codes were issued to the guest and delivered by both
      <strong>email and SMS</strong>.</li>
  <li>The reservation is in <strong>completed</strong> status with <strong>$0.00 refunded</strong>.</li>
  <li>The guest did not contact us about this charge at any point before filing the dispute.</li>
</ul>

<h2>5. The Cardholder Accepted Our Payment Policy Before Being Charged</h2>
<p>Our checkout logs every policy acceptance with a server-captured timestamp, IP address, and
browser user-agent. This cardholder's acceptance was recorded
<strong>14 seconds before</strong> the card was charged:</p>
<table>
  <tr><th>Field</th><th>Recorded value</th></tr>
  <tr><td>Accepted at</td><td class="key">July 24, 2026, 3:21:19 PM ET</td></tr>
  <tr><td>Charged at</td><td>July 24, 2026, 3:21:33 PM ET (14 seconds later)</td></tr>
  <tr><td>Second acceptance recorded</td><td>July 24, 2026, 3:21:42 PM ET</td></tr>
  <tr><td>IP address</td><td class="mono">99.109.65.71</td></tr>
  <tr><td>Device / browser</td><td class="mono">iPhone, iOS 18.7, Safari Mobile</td></tr>
  <tr><td>Policy version accepted</td><td class="mono">v3-2026-07-11</td></tr>
  <tr><td>Contact on file</td><td>salciotola@gmail.com &nbsp;&bull;&nbsp; (540) 748-6185</td></tr>
  <tr><td>Amount shown at acceptance</td><td>$240.59</td></tr>
  <tr><td>Booking type</td><td>Racing</td></tr>
</table>
` +
    clickwrapExhibit("6. Exhibit &mdash; Policy Text Accepted at Checkout") +
    `
<p>The accepted policy expressly directs customers to contact us before contacting their bank. The
cardholder did not do so.</p>
` +
    waiverExhibit(
      "The executed waiver bearing this cardholder's signature is submitted as a separate exhibit file " +
        "alongside this document.",
      CIOTOLA_WAIVER_BLOCK,
    ) +
    `
<h2>Conclusion</h2>
<div class="verdict">
  The card ending 1140 was charged <strong>once</strong>, for $240.59, on July 24, 2026. The billing
  name on the card is <strong>Salvatore Ciotola</strong>, the issuer confirmed the billing address via
  AVS, the phone on the account matches the phone given at booking, and a policy acceptance was logged
  <strong>14 seconds before</strong> the charge. Eight kart sessions were delivered to two racers that
  same evening. No duplicate authorization exists anywhere in our system across 122,277 payments and
  16 locations. The cardholder additionally executed a waiver, still in force on the service date, in
  which he agreed not to file a chargeback and authorized that waiver to be presented as conclusive
  evidence of authorization. We respectfully request that this dispute be resolved in the merchant's
  favor.
</div>

<h2>Exhibits</h2>
<ul>
  <li><strong>A.</strong> Executed participant waiver signed by Salvatore Ciotola, December 31, 2025
      <em>(submitted as a separate file)</em></li>
  <li><strong>B.</strong> Transaction and authorization record (Section 1)</li>
  <li><strong>C.</strong> All-location duplicate search results (Section 2)</li>
  <li><strong>D.</strong> Deposit-to-credit settlement trail (Section 3)</li>
  <li><strong>E.</strong> Policy acceptance log with IP, device, and timestamp (Section 5)</li>
  <li><strong>F.</strong> Cancellation &amp; Payment Policy, version v3-2026-07-11 (Section 6)</li>
  <li><strong>G.</strong> Credit card dispute terms from the executed waiver</li>
</ul>
<div class="foot">
  FastTrax Entertainment &bull; Fort Myers, Florida &bull; (239) 481-9666 &bull; fasttraxent.com<br>
  Dispute 7LgzFaOjCUKwtb3RommPB &bull; Payment FyAmXzYU0E1keNEyGTcP7xcMMK8YY &bull; Network case 849407509
</div>`,
);

/* ─────────────────────────── Dispute 2 ─────────────────────────── */

const d2 = page(
  "Dispute mH6xiOSaVMqmxKetS9ZmUD - Merchant Rebuttal",
  header("HeadPinz Entertainment Center &mdash; Naples, FL", "Chargeback Rebuttal: Transaction Was Authorized, Contracted, and Fulfilled", [
    ["Dispute ID", '<span class="mono">mH6xiOSaVMqmxKetS9ZmUD</span>'],
    ["Network case", "849276226"],
    ["Disputed amount", "$212.72 USD"],
    ["Reason code", "NO_KNOWLEDGE"],
    ["Payment ID", '<span class="mono">XbKfbaJTqR4O6ZOeiat23X5UM35YY</span>'],
    ["Card", "Mastercard ending 5672"],
    ["Transaction date", "May 1, 2026, 1:17:25 AM UTC"],
    ["Cardholder", "Kathy Forbes"],
    ["Event", 'H1098 &mdash; "Happy 9th Birthday Kayden!"'],
    ["Evidence due", "August 6, 2026"],
  ]) +
    `
<div class="verdict">
  <strong>Summary:</strong> The cardholder personally signed an electronic event contract naming her,
  from an IP address in Naples, Florida, and was charged the exact deposit amount stated in that
  contract <strong>85 seconds later</strong>. She then <strong>attended the event</strong> the
  following evening, added food and beverages, and <strong>settled the remaining balance in person
  at our front desk</strong>. The dispute was filed <strong>89 days after the event took place</strong>.
</div>

<h2>1. The Transaction</h2>
<table>
  <tr><th style="width:34%">Field</th><th>Value</th></tr>
  <tr><td>Authorized</td><td>May 1, 2026, 1:17:25 AM UTC</td></tr>
  <tr><td>Amount</td><td>$212.72 USD</td></tr>
  <tr><td>Description</td><td>Event Quote &ndash; H1098 &ndash; Happy 9th Birthday Kayden!</td></tr>
  <tr><td>Card</td><td>Mastercard &bull;&bull;&bull;&bull;5672, exp 03/2031</td></tr>
  <tr><td>Authorization code</td><td>171079</td></tr>
  <tr><td>Billing address on card</td><td>P.O. Box 612 &mdash; consistent with the cardholder's own
      email handle <span class="mono">klf612@icloud.com</span></td></tr>
  <tr><td>AVS result</td><td class="key">AVS_ACCEPTED &mdash; issuer confirmed the billing address matched</td></tr>
  <tr><td>Card storage</td><td class="key">Card was stored on, and charged from, the Kathy Forbes
      customer profile (entry method: on file)</td></tr>
  <tr><td>Customer record</td><td>Kathy Forbes, established July 3, 2025 (repeat customer)</td></tr>
  <tr><td>Email on file</td><td>Klf612@icloud.com</td></tr>
  <tr><td>Phone on file</td><td>+1 (239) 595-2523</td></tr>
  <tr><td>Amount refunded</td><td>$0.00</td></tr>
</table>

<h2>2. The Cardholder Signed a Contract 85 Seconds Before the Charge</h2>
<p>The event was booked under a countersigned electronic contract executed through PandaDoc. The
signature certificate establishes identity, time, and place:</p>
<table>
  <tr><th style="width:34%">Certificate field</th><th>Value</th></tr>
  <tr><td>Document reference</td><td class="mono">JTR4X-BUWQJ-OCWKA-GSODZ</td></tr>
  <tr><td>Signer</td><td class="key">KATHY FORBES</td></tr>
  <tr><td>Signer email</td><td class="key">KLF612@ICLOUD.COM &mdash; matches the card's customer record</td></tr>
  <tr><td>Sent</td><td>April 29, 2026, 22:48:57 UTC</td></tr>
  <tr><td>Email verified</td><td>May 1, 2026, 01:15:04 UTC</td></tr>
  <tr><td>Viewed</td><td>May 1, 2026, 01:15:04 UTC</td></tr>
  <tr><td>Signed</td><td class="key">May 1, 2026, 01:16:00 UTC</td></tr>
  <tr><td>Signer IP address</td><td class="mono">73.156.226.236</td></tr>
  <tr><td>Signer geolocation</td><td class="key">Naples, United States &mdash; the venue's own city</td></tr>
  <tr><td>Card charged</td><td class="key">May 1, 2026, 01:17:25 UTC &mdash; 85 seconds after signing</td></tr>
</table>
<p>The signed contract states a required deposit of <strong>$212.72</strong>. The disputed charge is
<strong>$212.72</strong> &mdash; an exact match to the penny. The contract also carries the
cardholder's checked acknowledgement:</p>
<div class="quote">
  <div class="cap">Executed acknowledgements &mdash; page 4 of the signed contract</div>
  <ul>
    <li>&ldquo;I agree to make a 50% deposit via <strong>credit card</strong> after completing this document.&rdquo;</li>
    <li>&ldquo;I understand that we do not accept pre-paid payments and we are unable to collect final payment before your event.&rdquo;</li>
    <li>&ldquo;I&rsquo;ll have a form of payment ready on the day of my event&hellip;&rdquo;</li>
    <li>&ldquo;I agree to the &lsquo;Tips for Your Event&rsquo; and &lsquo;Cancellation&rsquo; policies.&rdquo;</li>
  </ul>
</div>
<p class="note">The complete executed contract, including the PandaDoc Certificate of Signature, is
submitted as a separate exhibit file alongside this document.</p>

<h2>3. The Cardholder Attended the Event and Paid the Balance in Person</h2>
<p>This is the decisive point. A cardholder with "no knowledge" of a transaction does not attend the
event, order food and drinks, and settle the remaining balance at the front desk the following day.</p>
<table>
  <tr><th>Date / time (ET)</th><th>Event</th></tr>
  <tr><td>May 1, 9:16 PM</td><td>Contract signed electronically from Naples, FL</td></tr>
  <tr><td>May 1, 9:17 PM</td><td>Deposit of $212.72 charged to card ending 5672</td></tr>
  <tr><td>May 2, 8:09 PM</td><td>In-event ticket opened at the venue: "Happy 9th Birthday Kayden!"</td></tr>
  <tr><td class="key">May 2, 9:06 PM</td><td class="key">Remaining balance of $216.34 settled in person &mdash; ticket "Bmi h1098- Kathy Forbes"</td></tr>
</table>
<p>The balance was paid at our front desk on a <strong>different card, ending 3759</strong>, exactly
as the signed contract anticipated ("I'll have a form of payment ready on the day of my event"). That
in-person settlement, on a separate card, is independent confirmation that the cardholder was
physically present and knowingly transacting with us.</p>

<h3>Itemized balance settled on site</h3>
<table>
  <tr><th>Item</th><th class="num">Amount</th></tr>
  <tr><td>Bronze Birthday Party &ndash; Group 1 (balance)</td><td class="num">$155.67</td></tr>
  <tr><td>Meatballs</td><td class="num">$6.07</td></tr>
  <tr><td>Dirty Banana (cocktail)</td><td class="num">$5.64</td></tr>
  <tr><td>Toasted Coconut Pi&ntilde;a Colada (cocktail)</td><td class="num">$6.14</td></tr>
  <tr><td>Tax and remaining package balance</td><td class="num">$42.82</td></tr>
  <tr><th>Total settled in person, May 2</th><th class="num">$216.34</th></tr>
</table>
<p class="note">The two cocktails were purchased by an adult present at the party &mdash; further
evidence of the cardholder's attendance and participation.</p>

<h2>4. Financial Reconciliation</h2>
<table>
  <tr><th>Line</th><th class="num">Amount</th></tr>
  <tr><td>Contracted event total (signed quote)</td><td class="num">$425.43</td></tr>
  <tr><td>Deposit paid May 1 (the disputed charge)</td><td class="num">$212.72</td></tr>
  <tr><td>Balance settled in person May 2</td><td class="num">$216.34</td></tr>
  <tr><th>Total collected</th><th class="num">$429.06</th></tr>
  <tr><td>Variance vs. contract</td><td class="num">+$3.63 (day-of food and beverage added on site)</td></tr>
</table>
<p>The amounts reconcile precisely to a contracted, delivered, and fully settled event.</p>

<h2>5. Timing of the Dispute</h2>
<div class="flag">
  The event took place on <strong>May 2, 2026</strong>. This dispute was filed on
  <strong>July 30, 2026</strong> &mdash; <strong>89 days after the services were delivered</strong> and
  fully paid for. The cardholder never contacted us regarding this charge, despite having been on our
  premises, having transacted with our staff in person, and having an active customer record with us
  since July 2025.
</div>
` +
    waiverExhibit(
      "Note on scope: this waiver is our standing participant agreement and is reproduced here to " +
        "establish the chargeback terms in force. The binding instrument for this particular " +
        "transaction is the executed event contract described in Section 2 and submitted as a " +
        "separate exhibit, which the cardholder personally signed.",
    ) +
    `
<h2>Exhibit &mdash; Published Disputes &amp; Chargebacks Policy</h2>
<p>Our published payment policy, in force at the time of this transaction, directs customers to
contact us before contacting their bank:</p>
<div class="quote">
  <div class="cap">Disputes &amp; Chargebacks</div>
  <ul>
    <li>If you have a concern about a charge, please <strong>contact us first</strong> at
        (239) 302-2155 before contacting your bank. We can typically resolve issues within one
        business day.</li>
    <li>Initiating a chargeback without first contacting HeadPinz may result in suspension of
        booking privileges.</li>
  </ul>
</div>
<p class="note">This event was booked through our contracted group-events process, under which the
customer executes the signed event contract shown in Section 2 rather than the web checkout
acceptance box. We are not representing that this cardholder passed through the web checkout flow.</p>

<h2>Conclusion</h2>
<div class="verdict">
  The cardholder personally executed a contract bearing her name and email from an IP address in
  Naples, Florida; was charged the exact contracted deposit <strong>85 seconds later</strong>;
  <strong>attended the event</strong> the following evening; purchased additional food and beverages;
  and <strong>settled the remaining balance in person at our front desk on a second card</strong>. A
  claim of no knowledge of this transaction is not supportable on this record. We respectfully
  request that this dispute be resolved in the merchant's favor.
</div>

<h2>Exhibits</h2>
<ul>
  <li><strong>A.</strong> Executed event contract with PandaDoc Certificate of Signature
      <em>(submitted as a separate file)</em></li>
  <li><strong>B.</strong> Transaction and authorization record (Section 1)</li>
  <li><strong>C.</strong> Signature certificate detail: identity, IP, geolocation, timing (Section 2)</li>
  <li><strong>D.</strong> Proof of attendance and in-person balance settlement (Section 3)</li>
  <li><strong>E.</strong> Financial reconciliation (Section 4)</li>
  <li><strong>F.</strong> Published Disputes &amp; Chargebacks policy</li>
  <li><strong>G.</strong> Participant waiver &mdash; credit card dispute terms</li>
</ul>
<div class="foot">
  HeadPinz Entertainment Center &bull; Naples, Florida &bull; (239) 302-2155 &bull; headpinz.com<br>
  Dispute mH6xiOSaVMqmxKetS9ZmUD &bull; Payment XbKfbaJTqR4O6ZOeiat23X5UM35YY &bull; Network case 849276226
</div>`,
);

/* ─────────────────────────── Dispute 3 ─────────────────────────── */

const d3 = page(
  "Dispute rZLz94tH8Tr0O6iQIJzb4 - Merchant Rebuttal",
  header(
    "HeadPinz Entertainment Center &amp; FastTrax Entertainment &mdash; Fort Myers, FL",
    "Chargeback Rebuttal: Card Verified, and the Same Card's Funds Were Spent On Site That Night",
    [
      ["Dispute ID", '<span class="mono">rZLz94tH8Tr0O6iQIJzb4</span>'],
      ["Network case", "850230511"],
      ["Disputed amount", "$447.09 USD"],
      ["Reason code", "NO_KNOWLEDGE"],
      ["Payment ID", '<span class="mono">vPo0ZthayMpOHkhUItRaJkHz3VKZY</span>'],
      ["Card", "Visa ending 6548, exp 03/2030"],
      ["Transaction date", "July 25, 2026, 3:11:06 PM ET"],
      ["Booking", "Race reservation W54305 &mdash; 10-guest party"],
      ["Booked at", "fasttraxent.com"],
      ["Evidence due", "August 10, 2026"],
    ],
  ) +
    `
<div class="verdict">
  <strong>Summary:</strong> This charge passed <strong>both CVV and AVS verification</strong> &mdash;
  the payer held the physical card and knew the billing address. The same card made a
  <strong>second purchase the same evening</strong>, a $250 eGift Card, which the cardholder has
  <strong>not disputed</strong>. Those eGift funds were then spent down to <strong>$0.00 in person, on
  three staff-carried terminals at this venue</strong>, between 9:15 PM and 11:37 PM &mdash; a window
  that brackets the 10:12 PM race the disputed charge paid for. A compromised card produces disputes
  on <em>both</em> charges, not one.
</div>

<h2>1. The Transaction</h2>
<table>
  <tr><th style="width:34%">Field</th><th>Value</th></tr>
  <tr><td>Authorized</td><td>July 25, 2026, 3:11:06 PM ET</td></tr>
  <tr><td>Amount</td><td>$447.09 USD</td></tr>
  <tr><td>Description</td><td>Deposit &ndash; WEBHPFM06066236 &ndash; 2026-07-25</td></tr>
  <tr><td>Card</td><td>Visa &bull;&bull;&bull;&bull;6548, exp 03/2030</td></tr>
  <tr><td>Authorization code</td><td>101915</td></tr>
  <tr><td>CVV result</td><td class="key">CVV_ACCEPTED &mdash; the payer had the physical card in hand</td></tr>
  <tr><td>AVS result</td><td class="key">AVS_ACCEPTED &mdash; issuer confirmed the billing address matched</td></tr>
  <tr><td>Fraud screening</td><td>Square Risk Manager: risk level NORMAL</td></tr>
  <tr><td>Booking reference</td><td>Race reservation W54305 &mdash; 10 guests, Blue track, 10:12 PM heat</td></tr>
  <tr><td>Amount refunded</td><td>$0.00</td></tr>
</table>
<p>CVV is not stored on the card's magnetic stripe or chip and is not available from a stolen card
number alone. A CVV match, combined with an address match, is direct evidence that the person who
entered this payment was in possession of the card itself.</p>

<h2>2. Why This Charge May Not Have Been Recognized</h2>
<p>We want to address the likely source of the confusion directly. This guest booked a
<strong>go-kart race on fasttraxent.com</strong>, but our two brands operate from the same Fort Myers
complex under separate merchant locations, and the charge settled under the HeadPinz location name:</p>
<table>
  <tr><th>Charge</th><th>Descriptor on the cardholder's statement</th><th>Disputed?</th></tr>
  <tr>
    <td>$447.09 &mdash; race deposit (this dispute)</td>
    <td class="mono key">SQ *HEADPINZ FORT MYERS</td>
    <td class="key">Yes</td>
  </tr>
  <tr>
    <td>$250.00 &mdash; eGift Card, same card, same evening</td>
    <td class="mono">SQ *FASTTRAX FORT MYERS</td>
    <td>No</td>
  </tr>
</table>
<p>A cardholder reviewing a statement after booking on <em>fasttraxent.com</em> would recognize
"FASTTRAX FORT MYERS" and might not recognize "HEADPINZ FORT MYERS." That is a reasonable mistake and
it is ours to explain &mdash; but it is a <strong>labelling</strong> issue, not an authorization
issue. Both charges are ours, both were verified by CVV and AVS, and the evidence below shows the
guest received and consumed what both charges paid for.</p>

<h2>3. A Second, Undisputed Charge on the Same Card the Same Evening</h2>
<table>
  <tr><th>Time (ET), July 25, 2026</th><th>Charge</th><th>Verification</th><th class="num">Amount</th></tr>
  <tr>
    <td>3:11:06 PM</td><td>Race deposit &mdash; W54305 <em>(disputed)</em></td>
    <td>CVV + AVS accepted</td><td class="num">$447.09</td>
  </tr>
  <tr>
    <td>8:28:40 PM</td><td>eGift Card purchase, auth 112280 <em>(not disputed)</em></td>
    <td class="key">CVV + AVS accepted</td><td class="num">$250.00</td>
  </tr>
</table>
<p>We searched <strong>169,917 card payments across all 16 of our locations</strong> from May 1, 2026
through August 3, 2026. This card appears <strong>exactly twice</strong> &mdash; the two charges
above, both on the evening of July 25. Neither has been refunded. The cardholder is contesting one
and not the other.</p>

<h2>4. The Second Charge's Funds Were Spent In Person, At This Venue, Around the Race</h2>
<p>The $250 eGift Card purchased on this card (number ending 3365) was activated at 8:28:44 PM and
redeemed to a <strong>zero balance</strong> the same night at HeadPinz Fort Myers &mdash; the same
location as the disputed charge. Each redemption was taken on a <strong>staff-carried Square
Handheld terminal</strong>, which is used at the table and lane by our servers:</p>
<table>
  <tr><th>Time (ET)</th><th>Purchased</th><th>Terminal</th><th class="num">Amount</th></tr>
  <tr><td>9:15:07 PM</td><td>2 &times; Hennessy</td><td>Square Handheld 3065</td><td class="num">$26.77</td></tr>
  <tr><td>9:16:20 PM</td><td>1 &times; Hennessy</td><td>Square Handheld 3065</td><td class="num">$23.81</td></tr>
  <tr style="background:#f2f5fb">
    <td colspan="3"><strong>10:12 PM &mdash; the booked go-kart race the disputed charge paid for</strong></td>
    <td class="num">&mdash;</td>
  </tr>
  <tr>
    <td>11:34:50 PM</td>
    <td>3 &times; Nemos Chicken Wings, 16&quot; Pepperoni Pizza, Macho Nachos,
        2 &times; Triple Chocolate Brownie Sundae &mdash; ticket 17/18</td>
    <td>Square Handheld 2387</td><td class="num">$110.76</td>
  </tr>
  <tr><td>11:37:04 PM</td><td>Remaining balance transferred to a gift card</td><td>Square Handheld 4275</td><td class="num">$88.66</td></tr>
  <tr><th colspan="3">Total redeemed &mdash; ending balance $0.00</th><th class="num">$250.00</th></tr>
</table>
<p>Cocktails at 9:15 PM, a group food order for roughly ten people at 11:34 PM, and the race at
10:12 PM between them. This is a party physically present in our building for the entire evening,
served in person by our staff, spending funds drawn from the very card now said to be unrecognized.</p>

<h2>5. The Booked Services Were Delivered</h2>
<p>The disputed deposit was converted to stored-value credit and consumed against the day-of bill:</p>
<table>
  <tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr>
  <tr><td>Karting</td><td class="num">10</td><td class="num">$287.45</td></tr>
  <tr><td>FastTrax License</td><td class="num">10</td><td class="num">$53.14</td></tr>
  <tr><td>Nexus Laser Tag</td><td class="num">10</td><td class="num">$106.50</td></tr>
  <tr><th colspan="2">Settled 10:16 PM ET, July 25, 2026</th><th class="num">$447.09</th></tr>
</table>
<ul>
  <li>Reservation W54305 is in <strong>completed</strong> status with <strong>$0.00 refunded</strong>.</li>
  <li>The guest <strong>never contacted us</strong> about this charge, and never requested a refund,
      at any point before filing this dispute.</li>
</ul>

<h2>6. The Cardholder Accepted Our Payment Policy Before Being Charged</h2>
<p>Our checkout will not submit payment until the customer affirmatively checks a policy-agreement
box. Acceptance is logged server-side with timestamp, IP address, and device. This booking recorded
<strong>two</strong> acceptances, the first <strong>90 seconds before</strong> the charge:</p>
<table>
  <tr><th>Field</th><th>Recorded value</th></tr>
  <tr><td>First acceptance</td><td class="key">July 25, 2026, 3:09:36 PM ET &mdash; IP 172.56.1.167</td></tr>
  <tr><td>Second acceptance</td><td>July 25, 2026, 3:11:09 PM ET &mdash; IP 172.56.1.231</td></tr>
  <tr><td>Charged at</td><td>July 25, 2026, 3:11:06 PM ET</td></tr>
  <tr><td>Device / browser</td><td class="mono">Android 10, Chrome Mobile</td></tr>
  <tr><td>Policy version accepted</td><td class="mono">v3-2026-07-11</td></tr>
  <tr><td>Amount shown at acceptance</td><td>$447.09</td></tr>
  <tr><td>Contact provided</td><td>billydgoat55@gmail.com &nbsp;&bull;&nbsp; (239) 744-1563</td></tr>
  <tr><td>Booking type</td><td>Racing</td></tr>
</table>

` +
    clickwrapExhibit("7. Exhibit &mdash; Policy Text Accepted at Checkout") +
    waiverExhibit(
      "Note on scope: this waiver is the standing agreement required of participants and is reproduced " +
        "here to establish the contractual terms in force on the date of service. We are not " +
        "representing it as bearing this cardholder's signature &mdash; no executed waiver for this " +
        "party is present in our centralized waiver log, whose coverage on this date was incomplete. " +
        "The policy acceptance in Section 6 is separately and directly logged to this booking.",
    ) +
    `
<h2>Conclusion</h2>
<div class="verdict">
  This charge was authenticated by <strong>both CVV and AVS</strong>, screened as normal risk, and
  preceded by a logged policy acceptance 90 seconds earlier. The same card made a second purchase
  that evening which the cardholder <strong>has not disputed</strong>, and those funds were spent to
  zero <strong>in person, on our staff's handheld terminals, in this building</strong>, in a window
  that brackets the very race this deposit paid for. Ten guests received karting, licenses, and laser
  tag. Nothing was refunded and we were never contacted. If the cardholder did not recognize
  "HEADPINZ FORT MYERS" for a booking made on fasttraxent.com, Section 2 reconciles that &mdash; but
  the transaction itself is plainly authorized and plainly fulfilled. We respectfully request that
  this dispute be resolved in the merchant's favor.
</div>

<h2>Exhibits</h2>
<ul>
  <li><strong>A.</strong> Transaction and card-verification record: CVV and AVS accepted (Section 1)</li>
  <li><strong>B.</strong> Statement-descriptor reconciliation across both charges (Section 2)</li>
  <li><strong>C.</strong> The second, undisputed charge on the same card (Section 3)</li>
  <li><strong>D.</strong> In-person redemption trail with terminal identifiers (Section 4)</li>
  <li><strong>E.</strong> Day-of itemization of services delivered (Section 5)</li>
  <li><strong>F.</strong> Policy acceptance log with IP, device, and timestamp (Section 6)</li>
  <li><strong>G.</strong> Cancellation &amp; Payment Policy, version v3-2026-07-11 (Section 7)</li>
  <li><strong>H.</strong> Participant waiver &mdash; credit card dispute terms</li>
</ul>
<div class="foot">
  HeadPinz Entertainment Center &amp; FastTrax Entertainment &bull; Fort Myers, Florida
  &bull; (239) 481-9666 &bull; fasttraxent.com<br>
  Dispute rZLz94tH8Tr0O6iQIJzb4 &bull; Payment vPo0ZthayMpOHkhUItRaJkHz3VKZY &bull; Network case 850230511
</div>`,
);

/* ─────────────────────────── Render ─────────────────────────── */

if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

const jobs: [string, string][] = [
  ["dispute-7Lgz-ciotola-duplicate-rebuttal", d1],
  ["dispute-mH6x-forbes-noknowledge-rebuttal", d2],
  ["dispute-rZLz-tarver-noknowledge-rebuttal", d3],
];

for (const [name, html] of jobs) {
  const htmlPath = join(OUT, `${name}.html`);
  const pdfPath = join(OUT, `${name}.pdf`);
  writeFileSync(htmlPath, html, "utf8");
  const profile = mkdtempSync(join(tmpdir(), "chrome-pdf-"));
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { stdio: "pipe", timeout: 90_000 },
  );
  console.log(`wrote ${pdfPath}`);
}
