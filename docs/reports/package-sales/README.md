# Package Sales Report — Ultimate Qualifier · Rookie Pack · Ultimate VIP Experience

Owner-facing sales report, first produced 2026-08-02. Live copy (private artifact,
same URL on every refresh): https://claude.ai/code/artifact/81a1bc3b-2f9d-4f24-9922-81d0182d199d

- `package-sales-report.html` — the report page (self-contained, light/dark themed;
  numbers are hardcoded as of the "Prepared" date in the masthead).
- Data pull: [`apps/web/scripts/package-sales-report.mts`](../../../apps/web/scripts/package-sales-report.mts)
  — read-only, prints every number the report needs.

## Refreshing the report

1. From `apps/web` (needs `.env.local` with `DATABASE_URL`):

   ```
   npx tsx scripts/package-sales-report.mts
   ```

2. Update the numbers + "Prepared"/"as of" dates in `package-sales-report.html`.

3. PDF (from this directory; pin light theme — the tokens flip dark otherwise):

   ```
   { echo '<!DOCTYPE html><html data-theme="light"><head><meta charset="utf-8"><style>@page { size: Letter; margin: 0.5in; } html, body { background: #ffffff !important; }</style></head><body>'; cat package-sales-report.html; echo '</body></html>'; } > /tmp/pkg-print.html
   "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu \
     --no-pdf-header-footer --print-to-pdf="C:\\path\\to\\out.pdf" /tmp/pkg-print.html
   ```

4. Artifact: republish the HTML to the URL above (pass it as `url` from any
   Claude Code session so it keeps the same link).

## Method (established 2026-08-02 — details in the script header)

| Product | Counts | Dollars |
| --- | --- | --- |
| UQ web | `sales_log.package_id LIKE 'ultimate-qualifier%'` | registry price × racers (pre-tax) |
| UQ kiosk | race anchors whose heats hit **package-only Intermediate SKUs** (derived from `lib/packages.ts`) | registry price × racers |
| Rookie web | `sales_log.package_id LIKE 'rookie-pack%'` | registry price × racers |
| Rookie kiosk | **not trackable** — kiosk persists no package identity and Rookie shares SKUs with plain Starter races | — |
| VIP (v1 `race-bowl` + v2 `race-bowl-v2`) | `bowling_reservations` combo legs grouped by deposit order | **actual** charged totals (tax-inclusive) |

Known gaps / follow-ups:

- **Kiosk Rookie Pack**: to make it countable, forward `packageId` (and
  `rookiePack`) from `kiosk-post-reserve.ts` into the booking-confirmation
  payload so kiosk rows in `sales_log` carry `package_id` like web rows do.
- **Combo (Game Zone + Gel Blasters, Groupon replacement, launches Aug 2026)**:
  make sure the sell rail stamps a product identity in Neon at capture, then add
  its query to the script and a live tile to the report.
- `sales_log.total_usd` is NULL on every row — that's why UQ/Rookie dollars are
  computed rather than actual.
