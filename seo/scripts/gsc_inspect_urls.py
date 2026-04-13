"""Inspect index status of URLs via GSC URL Inspection API.

Usage:
    python gsc_inspect_urls.py https://headpinz.com/naples/attractions
    python gsc_inspect_urls.py https://fasttraxent.com/racing

Prefix is matched against configured properties to pick the right siteUrl.
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(__file__))
from _common import client, PROPERTIES

if len(sys.argv) < 2:
    print("Usage: python gsc_inspect_urls.py URL [URL ...]")
    sys.exit(1)

svc = client(write=False)


def pick_site(url: str):
    for p in PROPERTIES:
        host = p.replace("sc-domain:", "")
        if host in url:
            return p
    return None


for url in sys.argv[1:]:
    site = pick_site(url)
    if not site:
        print(f"SKIP  {url}  (no matching GSC property)")
        continue
    try:
        r = svc.urlInspection().index().inspect(body={"inspectionUrl": url, "siteUrl": site}).execute()
        idx = r.get("inspectionResult", {}).get("indexStatusResult", {})
        print(f"\n{url}")
        print(f"  verdict:          {idx.get('verdict')}")
        print(f"  coverage:         {idx.get('coverageState')}")
        print(f"  robotsTxtState:   {idx.get('robotsTxtState')}")
        print(f"  indexingState:    {idx.get('indexingState')}")
        print(f"  lastCrawlTime:    {idx.get('lastCrawlTime')}")
        print(f"  googleCanonical:  {idx.get('googleCanonical')}")
        print(f"  userCanonical:    {idx.get('userCanonical')}")
        if "referringUrls" in idx:
            print(f"  referringUrls:    {len(idx['referringUrls'])}")
    except Exception as e:
        print(f"ERROR  {url}  :: {e}")
