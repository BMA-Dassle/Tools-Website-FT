# SEO Operations

Tools and rules for monitoring and maintaining search visibility for
`headpinz.com` and `fasttraxent.com` across **every major search engine**.

---

## Coverage

| Search engine | How we notify it | Script / endpoint |
|---|---|---|
| **Google** | Search Console Sitemaps API (PUT) | `gsc_submit_sitemap.py` OR `POST /api/seo/submit-sitemaps` |
| **Bing** | IndexNow | `POST /api/seo/indexnow` |
| **Yandex** | IndexNow | `POST /api/seo/indexnow` |
| **Seznam** (Czech) | IndexNow | `POST /api/seo/indexnow` |
| **Naver** (Korean) | IndexNow | `POST /api/seo/indexnow` |
| **Yep** (Brave) | IndexNow | `POST /api/seo/indexnow` |
| **DuckDuckGo** | (uses Bing index — covered transitively via IndexNow) | — |
| All at once | Combined fan-out | `POST /api/seo/ping-all` |

Not covered:
- **Baidu** (China) — requires their private submission portal; low ROI for SWFL business
- **Apple Spotlight** — no ping protocol (handled via Apple Business Connect instead)

Full IndexNow participant list: https://www.indexnow.org/searchengines.json

---

## Properties

| Property | GSC URL | Sitemap |
|---|---|---|
| `sc-domain:headpinz.com` | https://search.google.com/search-console?resource_id=sc-domain:headpinz.com | https://headpinz.com/sitemap.xml |
| `sc-domain:fasttraxent.com` | https://search.google.com/search-console?resource_id=sc-domain:fasttraxent.com | https://fasttraxent.com/sitemap.xml |

Both are **Domain properties** (verified via DNS TXT), not URL-prefix — so
the API path uses `sc-domain:fasttraxent.com`, not `https://fasttraxent.com/`.
The Next.js endpoint auto-detects which format the service account has
access to (via `sites.list`) and uses the right one.

---

## Two ways to trigger pings

Pick the one that matches your situation:

### A. Next.js API endpoints (automation-friendly)

Runs in Vercel, no local setup. Use these for scheduled jobs, CI/CD
deploy hooks, or one-off triggers from a browser / curl.

```bash
# Google only (GSC Sitemaps)
curl -X POST https://fasttraxent.com/api/seo/submit-sitemaps \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET"

# Bing + Yandex + Seznam + Naver + Yep + others (IndexNow)
curl -X POST https://fasttraxent.com/api/seo/indexnow \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET"

# Everyone at once (Google + IndexNow fan-out in parallel)
curl -X POST https://fasttraxent.com/api/seo/ping-all \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET"
```

**Env vars** (set in fasttrax-web Vercel project, Production + Preview):
- `GOOGLE_SERVICE_ACCOUNT_KEY` — full JSON blob (see `fasttrax-web/docs/seo-gsc-setup.md`)
- `INDEXNOW_KEY` — 40-hex key; also hosted at `fasttrax-web/public/{key}.txt`
- `PORTAL_FORWARD_SECRET` — shared secret used as the `x-dev-secret` auth

**Source:**
- `fasttrax-web/app/api/seo/submit-sitemaps/route.ts`
- `fasttrax-web/app/api/seo/indexnow/route.ts`
- `fasttrax-web/app/api/seo/ping-all/route.ts`
- `fasttrax-web/lib/google-auth.ts` (service-account JWT → token)
- `fasttrax-web/lib/indexnow.ts` (IndexNow POST + sitemap parse)

### B. Python scripts (operator-friendly for reports)

Runs on your local machine, emits plain-text reports. Use these for
weekly reviews, diagnostics, debugging specific URLs.

```bash
# From repo root
python seo/scripts/gsc_decline.py           # Declining queries report
python seo/scripts/gsc_submit_sitemap.py    # Resubmit sitemaps to GSC
python seo/scripts/gsc_inspect_urls.py URL  # Inspect index status of URLs
```

Install once: `pip install google-api-python-client google-auth`
Key file: `C:\Work\headpinz-09398c4edefa.json` — same service account as
the Next.js endpoints; lives outside the repo.

---

## API access

Both paths authenticate via the same Google Cloud service account:

- **Service account email:** `googlesearch@headpinz.iam.gserviceaccount.com`
- **Project:** `headpinz` (GCP)
- **Permissions needed:** Owner on each GSC property (Settings → Users and
  permissions → Add user). Already done for both properties.
- **Scopes:** `.../webmasters.readonly` for reads, `.../webmasters` for
  writes (sitemap submit).

The Next.js endpoints use `GOOGLE_SERVICE_ACCOUNT_KEY` env var (full JSON
blob). The Python scripts use the key file at `C:\Work\…json` (not in git).

IndexNow is zero-auth — engines verify ownership by fetching the
key file you host at `https://{domain}/{key}.txt` (done — lives in
`fasttrax-web/public/`).

---

## When to push things to search engines

Only push when there's a **concrete signal they need to re-check**.
Pushing without a real change is noise and can suppress crawl budget.

### DO push (`/api/seo/ping-all`)

1. **After deploying new pages** — new route, new attraction, new landing
   page.
2. **After redirects route traffic to new pages** — so the new targets get
   crawled.
3. **After large content rewrites** on existing pages — search engines
   prioritize fresh content discovery.
4. **Weekly maintenance** — a single scheduled ping per week keeps the
   sitemap / URL list flagged as fresh.

### DO NOT push

1. **Minor copy tweaks** (typos, small wording fixes) — engines re-crawl
   on their own cadence.
2. **Style/CSS-only changes** — no SEO impact.
3. **Multiple times per day** — the GSC Sitemaps API accepts but ignores
   rapid resubmits; more than once/day looks like abuse. IndexNow has a
   similar rate-limit behavior.
4. **Never** use the Google Indexing API for regular HTML pages. That API
   is restricted to `JobPosting` and `BroadcastEvent` content types by
   Google's policy — using it for booking or attraction pages can get the
   site flagged.

### For immediate re-indexing of a specific page

Use **URL Inspection → Request Indexing** in the Search Console UI
(human-in-the-loop). Rate-limited to ~10/day and not exposed via API for
regular content. Save it for launches or critical fixes.

---

## Monitoring cadence

| Cadence | Task | Where |
|---|---|---|
| Weekly | Pull declining query report, review | `python seo/scripts/gsc_decline.py` |
| Weekly | Ping all engines | `POST /api/seo/ping-all` |
| After launch | Inspect key URLs to confirm indexed | `python seo/scripts/gsc_inspect_urls.py URL` |
| Monthly | Review coverage errors in GSC UI + Bing Webmaster | (manual) |
| Quarterly | Audit `<h1>`, canonicals, internal links, broken redirects | (manual) |

---

## Decision rules for ranking drops

From the `gsc_decline.py` output, classify each declining query into one
bucket:

1. **Seasonal volume drop** → impressions fell, position stable. Do nothing.
2. **CTR drop at stable rank** → clicks fell, impressions rose, position
   stable. Improve Google Business Profile (hours, photos, reviews), not
   the website.
3. **Real rank drop** → position worsened by 3+. Strengthen the landing
   page with content targeting that query; add internal links from
   higher-authority pages.
4. **SERP feature loss** → position improved but clicks dropped. Maps /
   local pack is taking clicks. Improve GBP, not the site.

---

## Adding a new property (if we launch another brand)

1. Verify domain in GSC (DNS TXT record).
2. GSC → Settings → Users and permissions → Add
   `googlesearch@headpinz.iam.gserviceaccount.com` with **Owner** permission.
3. Add the site URL to any script that iterates (or let it auto-pick up
   via `sites().list()`).
4. Add sitemap entry to `fasttrax-web/app/sitemap.ts` under the new brand.
5. Add the host to `DOMAINS` in
   `fasttrax-web/app/api/seo/ping-all/route.ts`, `submit-sitemaps`,
   `indexnow`.
6. Drop the IndexNow key file at `fasttrax-web/public/{key}.txt` (same key
   works cross-domain).

---

## Off-page (things this repo can't fix)

- **Google Business Profile** — hours, photos, posts, reviews, Q&A.
  Biggest lever for local queries.
- **Bing Places for Business** — same idea, Bing's local index.
- **Apple Business Connect** — powers Apple Maps, Siri, Spotlight
  suggestions.
- **Backlinks** — listed partners, press mentions, directory listings
  (BBB, Yelp, TripAdvisor, local chamber of commerce).
- **Brand consistency** — NAP (name, address, phone) identical across
  all directories. Discrepancies confuse search engines.
- **Reviews** — volume, velocity, response rate. Directly affects local
  pack ranking.
- **Site speed / Core Web Vitals** — Next.js 16 + Vercel edge already
  handles this well; monitor in GSC → Core Web Vitals report.

---

## Related docs

- `fasttrax-web/docs/seo-gsc-setup.md` — step-by-step GCP / GSC setup
  for the Next.js endpoints
- `fasttrax-web/docs/indexnow-setup.md` — IndexNow setup + key rotation
- [`scripts/_common.py`](scripts/_common.py) — shared auth + site list
  for Python scripts
