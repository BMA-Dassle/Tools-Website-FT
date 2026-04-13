# SEO Operations

Tools and rules for monitoring and maintaining search visibility for `headpinz.com` and `fasttraxent.com`.

## Properties

| Property | GSC URL | Sitemap |
|---|---|---|
| `sc-domain:headpinz.com` | https://search.google.com/search-console?resource_id=sc-domain:headpinz.com | https://headpinz.com/sitemap.xml |
| `sc-domain:fasttraxent.com` | https://search.google.com/search-console?resource_id=sc-domain:fasttraxent.com | https://fasttraxent.com/sitemap.xml |

Both properties are Domain properties (not URL-prefix). Any subdomain (www, booking, etc.) is included automatically.

## API Access

All scripts authenticate via a Google Cloud service account:

- **Service account email:** `googlesearch@headpinz.iam.gserviceaccount.com`
- **Project:** `headpinz` (GCP)
- **Key file:** `C:\Work\headpinz-52e6d30db6e5.json` — **NOT in git**. Lives outside the repo.
- **Scope:** `https://www.googleapis.com/auth/webmasters.readonly` for reads, `.../auth/webmasters` for writes (sitemap submit).

The service account must be added as a user on each GSC property (Settings → Users and permissions → Add user → full permission). Already done for both properties.

### Install once

```bash
pip install google-api-python-client google-auth
```

### Run

```bash
# From repo root
python seo/scripts/gsc_decline.py           # Declining queries report
python seo/scripts/gsc_submit_sitemap.py    # Resubmit sitemaps to GSC
python seo/scripts/gsc_inspect_urls.py URL  # Inspect index status of URLs
```

## When to push things to Google

Only push when there's a **concrete signal Google needs to re-check**. Pushing without a real change is noise and can suppress crawl budget.

### DO push (run `gsc_submit_sitemap.py`)

1. **After deploying new pages** — new route added, new product/attraction page, new landing page.
2. **After adding redirects that route traffic to new pages** — so Google re-crawls the targets.
3. **After large content rewrites** on existing pages — Google prioritizes fresh content discovery.
4. **Weekly maintenance** — a single scheduled submit per week keeps the sitemap flagged as "fresh."

### DO NOT push

1. **Minor copy tweaks** (typo fixes, small wording changes) — Google re-crawls on its own cadence.
2. **Style/CSS-only changes** — no SEO impact.
3. **Multiple times per day** — the Webmasters sitemap API accepts but ignores rapid resubmits; more than once/day looks like abuse.
4. **Never push to the Google Indexing API** for regular HTML pages. That API is restricted to `JobPosting` and `BroadcastEvent` content types by Google's policy. Using it for booking or attraction pages can get the site flagged.

### For immediate re-indexing of a specific page

Use **URL Inspection → Request Indexing** in the Search Console UI (human-in-the-loop). It's rate-limited (~10/day) and not exposed via the API for regular content. Save it for launches or critical fixes.

## Monitoring cadence

| Cadence | Task | Script |
|---|---|---|
| Weekly | Pull declining query report, review | `gsc_decline.py` |
| Weekly | Resubmit both sitemaps | `gsc_submit_sitemap.py` |
| After launch | Inspect key URLs to confirm indexed | `gsc_inspect_urls.py` |
| Monthly | Review coverage errors in GSC UI | (manual) |

## Decision rules for ranking drops

From the `gsc_decline.py` output, classify each declining query into one bucket:

1. **Seasonal volume drop** → impressions fell, position stable. Do nothing.
2. **CTR drop at stable rank** → clicks fell, impressions rose, position stable. Improve GBP (Google Business Profile), not the website.
3. **Real rank drop** → position worsened by 3+. Strengthen the landing page with content targeting that query.
4. **SERP feature loss** → position improved but clicks dropped. Maps/local pack is taking clicks. Improve GBP.

## Adding a new property (if we launch another brand)

1. Verify domain in GSC (DNS TXT record).
2. GSC → Settings → Users and permissions → Add `googlesearch@headpinz.iam.gserviceaccount.com` with Full permission.
3. Add the site URL to any script that iterates (or let it auto-pick up via `sites().list()`).
4. Add sitemap entry if multi-site; currently each domain has its own `sitemap.xml`.

## Off-page (things this repo can't fix)

- **Google Business Profile** — hours, photos, posts, reviews, Q&A. Biggest lever for local queries.
- **Backlinks** — listed partners, press, directory listings.
- **Brand consistency** — NAP (name, address, phone) identical across all directories.
