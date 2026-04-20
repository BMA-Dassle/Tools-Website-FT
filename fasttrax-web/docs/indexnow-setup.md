# IndexNow setup

Near-instant re-crawl notifications for Bing, Yandex, Seznam, Naver, Yep,
and any other IndexNow-participating engine. DuckDuckGo uses Bing's index
so it's covered transitively. Google does **not** participate (use
`seo-gsc-setup.md` for Google).

## How it works

1. You generate a key (8–128 hex characters). We use a 40-hex SHA-1-style
   string: `52e6d30db6e55d7d60784ed3b779cf45ddf8dc71`.
2. You host a plaintext file at `https://{domain}/{key}.txt` containing
   just the key — this proves domain ownership.
3. Your app POSTs URL lists to `https://api.indexnow.org/IndexNow` with
   `{ host, key, keyLocation, urlList }`. Any participating engine that
   cares about the host verifies the key and crawls the URLs.

## Already configured

| What | Where |
|---|---|
| Key | `INDEXNOW_KEY` in `.env.local` |
| Key file | `fasttrax-web/public/52e6d30db6e55d7d60784ed3b779cf45ddf8dc71.txt` — served at `https://fasttraxent.com/52e6d30db6e55d7d60784ed3b779cf45ddf8dc71.txt` AND `https://headpinz.com/…txt` |
| Helper | `fasttrax-web/lib/indexnow.ts` — `submitIndexNow`, `submitSitemapUrls` |
| Endpoint | `POST /api/seo/indexnow` — submits both domains' full sitemap URLs |
| Combined | `POST /api/seo/ping-all` — fires IndexNow + Google in parallel |

## Usage

```bash
# IndexNow only
curl -X POST https://fasttraxent.com/api/seo/indexnow \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET" | jq .

# Combined with Google
curl -X POST https://fasttraxent.com/api/seo/ping-all \
     -H "x-dev-secret: $PORTAL_FORWARD_SECRET" | jq .
```

Expected response (on success):

```json
{
  "ok": true,
  "results": [
    {"host":"fasttraxent.com","key":"…","urlCount":14,"ok":true,"status":202},
    {"host":"headpinz.com",   "key":"…","urlCount":18,"ok":true,"status":202}
  ]
}
```

Status `202 Accepted` = IndexNow queued the submission. It verifies the
key file by fetching `https://{host}/{key}.txt` asynchronously; if that
returns the expected content (just the key), the URLs start getting
crawled within minutes by Bing / Yandex / etc.

## Verify setup in production

After deploying the key file:

```bash
# Must return the raw key string (plain text, HTTP 200)
curl -i https://fasttraxent.com/52e6d30db6e55d7d60784ed3b779cf45ddf8dc71.txt
curl -i https://headpinz.com/52e6d30db6e55d7d60784ed3b779cf45ddf8dc71.txt
```

Both should return `HTTP 200` with `Content-Type: text/plain` (or similar)
and body = `52e6d30db6e55d7d60784ed3b779cf45ddf8dc71` (nothing else).

If either returns 404, the middleware's root-metadata bypass isn't
working — double-check `middleware.ts` allows `/^\/[a-zA-Z0-9_-]+\.txt$/`
through on the HeadPinz domain.

## Vercel env var

Add `INDEXNOW_KEY=52e6d30db6e55d7d60784ed3b779cf45ddf8dc71` to the
fasttrax-web Vercel project (Production + Preview). Not sensitive — the
key is public by design (it's at a discoverable URL).

## Rotating the key

1. Generate a new 40-hex string (e.g. `openssl rand -hex 20` or
   `uuidgen | tr -d '-'`).
2. Create a new file in `fasttrax-web/public/{new-key}.txt` with just the
   new key as content.
3. Update `INDEXNOW_KEY` in `.env.local` AND Vercel env.
4. Deploy.
5. After deploy confirms both key files serve correctly, delete the OLD
   key file from `fasttrax-web/public/`.
6. Deploy again.

The order matters: new key needs to be live BEFORE you switch the env
var, otherwise any pings mid-deploy reference a missing key file.

## Bing Webmaster Tools (additional — optional)

IndexNow is the main integration for Bing. If you also want:
- Coverage reports
- Crawl stats
- Manual "Submit URL" triggers
- Indexed site size

…register at https://www.bing.com/webmasters. The verification options:
- **Option 1 — CNAME:** add a DNS CNAME record. Works for both domains.
- **Option 2 — XML file:** download `BingSiteAuth.xml`, drop in
  `fasttrax-web/public/`. Middleware allows root-level .xml through.
- **Option 3 — Import from GSC:** easiest if GSC already verified
  (Bing auto-imports the property).

Already-indexed content shows up within 24–48 h of verification.

## Troubleshooting

### Key file returns 404

- Middleware's root-metadata bypass isn't catching it. Check
  `fasttrax-web/middleware.ts` → `isRootMetadataPath` regex includes
  `/^\/[a-zA-Z0-9_-]+\.txt$/` (it does as of commit `ae0f7d1`).
- Double-check file exists in `fasttrax-web/public/` and filename
  exactly matches the `INDEXNOW_KEY` env var.

### IndexNow returns `403 Forbidden`

Engine tried to verify the key and the file didn't match. Causes:
- Key file content differs from env var (must be exact, no trailing
  newline issues — check `curl -s url | od -c | tail`)
- Key file not accessible from public internet (firewall, auth wall)
- Host in POST body doesn't match the domain serving the key

### IndexNow returns `422 Unprocessable`

URLs in `urlList` don't belong to the `host` you declared. Each call
handles one host at a time — don't mix fasttraxent + headpinz in a
single POST.
