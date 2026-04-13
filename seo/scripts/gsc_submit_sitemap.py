"""Resubmit sitemap(s) to Google Search Console for each configured property.

Use cases (see seo/README.md "When to push"):
- After deploying new pages
- After adding redirects
- After major content rewrites
- Weekly maintenance

Do NOT run more than once a day. The API accepts but ignores rapid resubmits.
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(__file__))
from _common import client, SITEMAPS

svc = client(write=True)

for site, sitemap_urls in SITEMAPS.items():
    for sm in sitemap_urls:
        try:
            svc.sitemaps().submit(siteUrl=site, feedpath=sm).execute()
            print(f"OK    {site}  ->  {sm}")
        except Exception as e:
            print(f"FAIL  {site}  ->  {sm}  :: {e}")

# Print current status
print("\nCurrent sitemap status:")
for site in SITEMAPS.keys():
    try:
        r = svc.sitemaps().list(siteUrl=site).execute()
        for sm in r.get("sitemap", []):
            print(
                f"  {site}  {sm['path']}  "
                f"submitted={sm.get('lastSubmitted', '?')}  "
                f"downloaded={sm.get('lastDownloaded', '?')}  "
                f"warnings={sm.get('warnings', 0)}  errors={sm.get('errors', 0)}"
            )
    except Exception as e:
        print(f"  {site}  error: {e}")
