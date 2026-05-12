# E-Ticket Admin — Portal Embed Guide

## Overview

The e-ticket admin page shows all e-ticket SMS/email deliveries for a date with
click tracking, racer details, and one-click resend. The portal embeds it via
iframe using the same HMAC-signed URL pattern as the bowling admin embed.

**Embed URL (HMAC-signed):**
```
https://headpinz.com/admin/embed/e-tickets?ts={timestamp}&sig={hmac_hex}
```

---

## What the E-Ticket Admin Page Does

E-ticket delivery log and resend tool for front-desk staff:

### Table columns
| Column | Description |
|--------|-------------|
| Time | Delivery timestamp (ET) |
| Racer | First + last name from BMI person record |
| Phone | Recipient phone (SMS deliveries) |
| Track | Red / Blue track |
| Heat | Heat number + scheduled start time |
| Race Type | Starter / Advanced / Pro |
| Status | Delivery state (sent, delivered, failed, clicked) |
| Clicks | Click count + first/last click timestamps |
| Actions | Resend via SMS, email, or both |

### Admin actions
1. **Resend** — re-deliver e-ticket link via SMS, email, or both
2. **Filter** — by phone number, racer name, or track
3. **Date picker** — view deliveries for any date

---

## HMAC Authentication

Identical to the bowling admin embed. One shared secret covers all embed pages.

### Auth flow
1. Portal page loads -> calls its own `/api/integrations/admin-embed-url?tool=e-tickets`
2. That endpoint generates `HMAC-SHA256(ADMIN_EMBED_SECRET, Date.now())`
3. Returns `https://headpinz.com/admin/embed/e-tickets?ts={timestamp}&sig={hex}`
4. FastTrax middleware validates HMAC + checks timestamp within **15 minutes**
5. Response includes `Content-Security-Policy: frame-ancestors https://portal.headpinz.com`

**The static admin token never appears in the URL.** The page component reads
`ADMIN_CAMERA_TOKEN` from env on the server and passes it to the client component.

### Environment variables

```env
# Portal .env (Vercel)
ADMIN_EMBED_SECRET=<shared HMAC secret — same value on both projects>

# FastTrax .env (Vercel) — supports both names (ADMIN_EMBED_SECRET preferred)
ADMIN_EMBED_SECRET=<same shared HMAC secret>
ADMIN_CAMERA_TOKEN=<existing admin token — used server-side for API calls>
```

Generate the shared secret: `openssl rand -hex 32`

**Same secret as bowling.** All embed pages share `ADMIN_EMBED_SECRET`. Rotating
the secret invalidates all outstanding URLs for all embeds within 15 minutes.

> **Backward compat:** FastTrax also reads `BOWLING_EMBED_SECRET` as a fallback
> if `ADMIN_EMBED_SECRET` is not set.

---

## Portal Endpoint

The portal needs an endpoint (or extend the existing bowling one) to generate
HMAC-signed URLs for the e-ticket embed:

```ts
// api/integrations/admin-embed-url.ts (or extend bowling-admin-url.ts)
import { createHmac } from "crypto";

const EMBED_SECRET = process.env.ADMIN_EMBED_SECRET || "";
const ts = String(Date.now());
const sig = createHmac("sha256", EMBED_SECRET).update(ts).digest("hex");
const url = `https://headpinz.com/admin/embed/e-tickets?ts=${ts}&sig=${sig}`;
```

Or generalize the existing `bowling-admin-url.ts` to accept a `tool` parameter:

```ts
// GET /api/integrations/admin-embed-url?tool=e-tickets
const tool = req.query.tool || "bowling"; // "bowling" | "e-tickets" | "videos"
const url = `https://headpinz.com/admin/embed/${tool}?ts=${ts}&sig=${sig}`;
```

---

## iframe Framing Headers

Same as bowling — FastTrax enforces:

1. **Middleware** sets `Content-Security-Policy: frame-ancestors https://portal.headpinz.com`
2. **`next.config.ts`** also sets frame-ancestors for `/admin/*?embedded=1`

Without the HMAC signature or `?embedded=1`, admin pages cannot be framed
cross-origin.

---

## Theme Support

The e-ticket admin page does **not** yet have the CSS variable theme system that
bowling has. When embedded, it renders in its default dark theme. Theme support
(URL param + postMessage) can be added later using the same pattern as bowling.

---

## API Endpoints Used

The e-ticket admin client calls these APIs (token injected server-side):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/e-tickets/list?token=...&date=...` | GET | List deliveries for a date |
| `/api/admin/e-tickets/resend?token=...` | POST | Resend e-ticket (SMS/email/both) |

These are also accessible via the portal's api-key auth (`x-api-key` header with
`SALES_API_KEYS`).

---

## Quick Start

1. Set `ADMIN_EMBED_SECRET` on both Vercel projects (same value as bowling)
2. Create/extend a portal endpoint to generate signed URLs for `e-tickets`
3. Render `<iframe src={signedUrl} />` in the portal
4. Done — the page handles everything else
