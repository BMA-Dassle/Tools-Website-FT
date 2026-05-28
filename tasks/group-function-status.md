# Group Function Contract System — Status & Open Items

**Last updated:** 2026-05-28

## What's Working

- [x] Hermes queue → internal contract creation (PandaDoc removed)
- [x] Contract page: review → tips → policy → sign → pay → "You're All Set"
- [x] Square deposit payment (multi-tender: card + gift card)
- [x] eGift card creation + activation (GRPF/HPFM/HPN prefix)
- [x] Day-of Square order creation (OPEN status for staff POS redemption)
- [x] Card save to Square customer (uses paymentId per Square docs)
- [x] BMI Office status update (Confirmation / Confirmation+Waiver per location)
- [x] BMI Office payment recording
- [x] 72-hour balance auto-charge cron (saved card → charge → load gift card)
- [x] Balance payment link fallback (when no saved card)
- [x] Post-event auto-close cron (marks completed after event passes)
- [x] Email + SMS + Teams notifications at each lifecycle stage
- [x] Signed contract PDF generation (branded dark theme)
- [x] Live notes from BMI Office on review + event pages
- [x] Live participant list with waiver confirmation status
- [x] Group events visible on admin reservations page
- [x] Brand-aware nav on contract pages (HeadPinz nav / FastTrax nav)
- [x] FastTrax detection from Hermes subject line

## NOT Finished — Needs Work

### High Priority

- [ ] **Day-of order payment at event time** — Need a cron that, at the time of the event, pays/closes the day-of Square order using the gift card. Currently the day-of order is created OPEN at deposit time, the gift card gets loaded to 100% at balance charge time, but nothing redeems the gift card against the day-of order. Staff must do this manually at POS. A cron should auto-pay the day-of order with the gift card at event start time (or shortly after).

- [ ] **Naples BMI Office auth** — API2 credentials fail for `headpinznaples` client key. Naples events won't get BMI status updates or payment recording until separate Naples credentials are configured. Need to either: get API2 access to Naples, or add Naples-specific creds to env.

- [ ] **Hermes queue "read = consumed" problem** — The `/queue/pandadoc` endpoint in Hermes moves items from priority 1→9 on READ (before our cron processes them). If processing fails, the item is already moved and won't be retried. Fix: Hermes should only move items when `/complete` is called, not on GET. This is a Hermes-side change (`c:\GIT\Hermes_BMI\src\main.ts` lines 241-247).

### Medium Priority

- [ ] **HeadPinz nav on contract pages** — Implemented but untested. HeadPinzNav renders on headpinz.com contract URLs, FastTrax Nav on fasttraxent.com. Verify it looks correct after deploy.

- [ ] **Card save verification** — Fixed to use paymentId (not nonce) per Square docs. Needs live testing to confirm cards are actually saving now.

- [ ] **SEO: HeadPinz metadata on /book routes** — (from todo.md) headpinz.com/book/* shows FastTrax titles in Google.

### Low Priority / Future

- [ ] **Admin reservations: group event actions** — Currently read-only display. Could add: manual resend contract, cancel event, view Square orders, manual balance charge.

- [ ] **Contract PDF: embed logo images** — Currently text-only header. Could fetch HeadPinz/FastTrax logos from blob storage and embed in PDF header.

- [ ] **Apple/Google Wallet passes** — Add wallet pass generation to the "You're All Set" confirmation page.

- [ ] **Express Lane for group events** — Returning guests with valid waivers could skip Guest Services.

## Cron Schedule (vercel.json)

| Cron | Path | Frequency | Purpose |
|------|------|-----------|---------|
| group-quote-dispatch | `/api/cron/group-quote-dispatch` | Every 2 min | Poll Hermes → create contracts |
| group-balance-charge | `/api/cron/group-balance-charge` | Every 15 min | 72hr auto-charge or payment link |
| group-dayof-close | `/api/cron/group-dayof-close` | Every 15 min | Mark past events completed |
| **MISSING** | — | — | Pay day-of order with gift card at event time |
