# Location × Attraction Content Landing Pages

## Problem

Booking pages (`/book/laser-tag?location=naples`, `/hp/book/bowling`, etc.) are transactional and don't rank well organically. Google treats query parameters like `?location=` as tracking params and consolidates all variants onto the base URL, so we can't win queries like "laser tag naples fl" (currently dropped from pos 1.9 → 5.6) or "gel blasters florida" without dedicated content pages.

Competitors (TopGolf, Dave & Buster's) solve this with the content-page + booking-page split:
- `/locations/fort-myers` — content, ranks organically
- `/reserve` — transactional, doesn't try to rank

We should do the same.

## Proposed structure

**Content landing pages (new — these rank):**

| URL | Targets query | Current rank |
|---|---|---|
| `headpinz.com/fort-myers/laser-tag` | laser tag fort myers | not ranking |
| `headpinz.com/fort-myers/gel-blaster` | gel blaster fort myers | not ranking |
| `headpinz.com/fort-myers/bowling` | bowling fort myers, best bowling alley | weak (at /fort-myers) |
| `headpinz.com/fort-myers/shuffly` | shuffleboard fort myers | not ranking |
| `headpinz.com/naples/laser-tag` | **laser tag naples fl** | pos 5.6 (was 1.9) |
| `headpinz.com/naples/gel-blaster` | **gel blasters naples** | weak |
| `headpinz.com/naples/bowling` | bowling naples fl | weak |

**Booking pages (unchanged):**
- `/book/laser-tag?location=naples` — transactional, linked from content pages
- `/book/gel-blaster?location=fort-myers` — same
- `/hp/book/bowling?location=naples` — same

No changes to booking flow. Zero risk of breaking bookings.

## Page template (every combo follows this)

1. **Hero** — big photo, H1 with exact keyword, price + "Book Now" CTA
2. **What Is It** — 150-word description with keyword variants
3. **Pricing & Hours card** — location-specific
4. **Photo gallery** — 4–6 original photos
5. **FAQ section** — 6–8 Q&A with `FAQPage` JSON-LD
6. **Also at HeadPinz [location]** — cross-links to 2–3 other attractions at same location
7. **Map + directions** — embedded
8. **Final CTA** — "Book [Attraction] at HeadPinz [Location]" → `/book/[attraction]?location=[location]`
9. **Schema:** `LocalBusiness` + `Service` (or `Product`) + `FAQPage` + `BreadcrumbList`

## Build approach

One reusable dynamic route: `app/hp/[location]/[attraction]/page.tsx` with:
- Static validation of location and attraction slugs (404 for invalid combos)
- `generateMetadata()` pulling from a config per combo (title, description, canonical, OG)
- Content fed from a per-combo config object: hero photo, pricing, FAQ answers, related attractions, schema data
- Same component tree reused; config drives the differences

Each combo is ~15 lines of config (slug, title, meta description, hero image, price, 6-8 FAQ items, related attractions). Keeps content consistent and easy to expand.

## Rollout plan

**Phase 1 — Prove it works (1 page):**
1. Build `/naples/laser-tag` only
2. This is the most urgent recovery target (rank dropped 1.9 → 5.6)
3. Deploy, submit to GSC, wait 2 weeks

**Phase 2 — Evaluate:**
- Check GSC for `laser tag naples fl` — did rank recover?
- Check indexation via `gsc_inspect_urls.py`
- Review time-on-page, bounce rate, booking conversion from the new page

**Phase 3 — Roll out the rest (6 pages):**
- If Phase 1 wins: build the other 6 combos using the same template
- If it doesn't: diagnose before rolling out (maybe content quality, maybe internal linking, maybe Google just needs more time)

## Internal linking plan (when built)

- Location home pages (`/fort-myers`, `/naples`) → link to each attraction landing page
- Attractions pages (`/fort-myers/attractions`, `/naples/attractions`) → each attraction card deep-links to its dedicated landing page instead of booking
- Booking pages → link back to content pages as "Learn more about [attraction]"
- Blog posts (when they exist) → link to relevant combo landing pages
- HeadPinz home → featured attractions block links to 3–4 top combo pages

## Middleware / redirects

No old URLs to redirect. These are net-new pages.

## Sitemap

Add 7 new URLs when pages go live:
- `/fort-myers/laser-tag`, `/fort-myers/gel-blaster`, `/fort-myers/bowling`, `/fort-myers/shuffly`
- `/naples/laser-tag`, `/naples/gel-blaster`, `/naples/bowling`

Run `python seo/scripts/gsc_submit_sitemap.py` after deploy.

## Open questions to resolve before starting

1. **Bowling landing page overlap with /fort-myers and /naples location homes** — the location home already covers bowling heavily. Does `/fort-myers/bowling` dilute or reinforce? (Probably reinforces if we angle the dedicated page specifically at "bowling alley" queries vs the home's broader "entertainment" angle, but verify before building.)
2. **Shuffly on Naples** — not offered there yet. Skip the Naples shuffly page or 301 to bowling? Default: skip.
3. **Do we need FastTrax versions too?** (e.g. `/fort-myers/go-karts`). FastTrax is single-location so probably not needed — the root `/racing` page already carries all the location signal via the LocalBusiness schema. Confirm before scope creep.

## Success metric

`laser tag naples fl` returns to position <= 2 within 60 days of the `/naples/laser-tag` page going live, AND booking conversions from that page are measurable in Vercel analytics / BMI bill records.

## Status

Planned. Not started. Requires Eric's sign-off before building.

## Related work

- Existing `SeoFaq` component at `components/headpinz/SeoFaq.tsx` — reusable for the FAQ section
- Existing FAQ content at `/naples/attractions` and `/fort-myers/attractions` — copy/adapt per combo
- Existing `seo/scripts/gsc_decline.py` — use to measure impact post-launch
