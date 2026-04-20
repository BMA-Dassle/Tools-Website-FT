# Google Search Console API setup

Lets us programmatically tell Google "the sitemap changed, please re-crawl"
via `POST /api/seo/submit-sitemaps`. One-time setup (~15 minutes).

## Why

Google deprecated the old `google.com/ping?sitemap=` endpoint in June 2023.
The only supported way to submit a sitemap now is the Search Console
**Sitemaps API**, which requires OAuth2 — we use a service account for
server-to-server auth.

Once set up, you can trigger re-crawl any time (on deploy, on cron,
manually after content updates) by POSTing to our endpoint:

```bash
curl -X POST https://fasttraxent.com/api/seo/submit-sitemaps \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET"
```

…and it submits both `fasttraxent.com/sitemap.xml` AND
`headpinz.com/sitemap.xml` to Google in one call.

## Setup (do these in order)

### 1. Create a Google Cloud project (if you don't already have one)

- Go to https://console.cloud.google.com/
- Pick an existing project (e.g. a HeadPinz/FastTrax one) OR create a new
  one — name doesn't matter (`fasttrax-seo` is fine).

### 2. Enable the Search Console API

- In the same project, navigate to **APIs & Services → Library**
- Search for "Google Search Console API"
- Click it → **Enable**

### 3. Create a service account

- **APIs & Services → Credentials → Create credentials → Service account**
- Name: `fasttrax-seo-submit` (anything)
- Role: none needed at project level — skip the "grant access" steps, we'll
  grant per-property in Search Console instead
- **Create and continue → Done**

### 4. Download the key

- Click the newly-created service account
- **Keys → Add key → Create new key → JSON**
- A JSON file downloads. Open it — it looks like:
  ```json
  {
    "type": "service_account",
    "project_id": "fasttrax-seo",
    "private_key_id": "…",
    "private_key": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
    "client_email": "fasttrax-seo-submit@fasttrax-seo.iam.gserviceaccount.com",
    "client_id": "…",
    …
  }
  ```
- Note the `client_email` value — you'll need it in step 5.

### 5. Grant the service account Owner access to each property

Search Console treats service accounts just like a normal user — they
need to be granted Owner access on each site.

- Go to https://search.google.com/search-console
- Select the **fasttraxent.com** property → **Settings → Users and permissions → Add user**
- Paste the service account's `client_email` → Permission: **Owner** → Add
- Repeat for the **headpinz.com** property

If a property isn't verified yet, verify it first (DNS TXT record or HTML
file). Once verified, add the service account.

### 6. Set the env var

Paste the ENTIRE JSON key (as one long string — preserve the `\n` escapes
inside `private_key`) into the Vercel env var for the fasttrax-web
project:

```
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"…","private_key":"-----BEGIN PRIVATE KEY-----\n…","client_email":"…",…}
```

Production + Preview. Mark it **Sensitive**.

### 7. Test the endpoint

From your machine or a Vercel function:

```bash
curl -X POST https://fasttraxent.com/api/seo/submit-sitemaps \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET" | jq .
```

Expected response (both domains accepted):
```json
{
  "ok": true,
  "results": [
    {"siteUrl":"https://fasttraxent.com/","sitemap":"…","ok":true,"status":200},
    {"siteUrl":"https://headpinz.com/","sitemap":"…","ok":true,"status":200}
  ]
}
```

If you see `"ok": false` with a `403` or `404` status, it usually means:
- The service account isn't an Owner on that property (re-check step 5)
- The property isn't verified in Search Console yet
- The Sitemaps API isn't enabled for that project

## Call it on a schedule?

Optional — add to `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/seo/submit-sitemaps?scheduled=1", "schedule": "0 9 * * 1" }
  ]
}
```

Runs every Monday at 9 AM UTC and re-pings Google. Note: cron endpoints
need a different auth path (Vercel cron doesn't set custom headers) —
you'd extend the route to accept a query param OR check the
`x-vercel-signature` header. Not shipped yet; wire up only if needed.

## Also submit to Bing / Yandex?

Bing Webmaster has an **IndexNow** protocol — no auth, just host a key
file and POST a URL list. Easy to add; the same key works for Bing +
Yandex + all IndexNow participants. Ask when you want this wired up —
it's ~30 lines.
