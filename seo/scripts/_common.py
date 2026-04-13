"""Shared auth + client for GSC scripts."""
import os
from google.oauth2 import service_account
from googleapiclient.discovery import build

KEY_FILE = os.environ.get("GSC_KEY_FILE", r"C:\Work\headpinz-52e6d30db6e5.json")

READ_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]
WRITE_SCOPES = ["https://www.googleapis.com/auth/webmasters"]

PROPERTIES = ["sc-domain:headpinz.com", "sc-domain:fasttraxent.com"]

# Sitemap URLs to submit for each property
SITEMAPS = {
    "sc-domain:headpinz.com": ["https://headpinz.com/sitemap.xml"],
    "sc-domain:fasttraxent.com": ["https://fasttraxent.com/sitemap.xml"],
}


def client(write: bool = False):
    scopes = WRITE_SCOPES if write else READ_SCOPES
    creds = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=scopes)
    return build("searchconsole", "v1", credentials=creds, cache_discovery=False)


def list_sites(svc):
    r = svc.sites().list().execute()
    return [s["siteUrl"] for s in r.get("siteEntry", [])]
