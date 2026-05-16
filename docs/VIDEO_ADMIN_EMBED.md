# Video Admin — Portal Embed Guide

## Overview

The video admin page shows all matched racing videos for a date with racer
details, thumbnails, camera/system numbers, and one-click resend. The portal
embeds it via iframe using the same HMAC-signed URL pattern as the bowling
and e-ticket admin embeds.

**Embed URL (HMAC-signed):**

```
https://headpinz.com/admin/embed/videos?ts={timestamp}&sig={hmac_hex}
```

---

## What the Video Admin Page Does

Video match log and resend tool for front-desk staff:

### Table columns

| Column    | Description                                            |
| --------- | ------------------------------------------------------ |
| Time      | Video capture timestamp (ET)                           |
| Racer     | First + last name from BMI person record               |
| Track     | Red / Blue track                                       |
| Heat      | Heat number + scheduled start                          |
| Camera    | Hardware camera number                                 |
| System    | Base-station / NFC tag system number                   |
| Code      | Short video code (customer-facing)                     |
| Thumbnail | Video thumbnail preview                                |
| Duration  | Video length                                           |
| Match     | When the video was matched to the racer                |
| Delivery  | SMS/email delivery state                               |
| Actions   | Resend via SMS, email, or both (with address override) |

### Admin actions

1. **Resend** — re-deliver video link via SMS, email, or both
2. **Override address** — resend to a different phone/email than original
3. **Filter** — by racer name, camera, video code
4. **Date picker** — view videos for any date

---

## HMAC Authentication

Identical to the bowling and e-ticket admin embeds. One shared secret covers
all embed pages.

### Auth flow

1. Portal page loads -> calls its own `/api/integrations/admin-embed-url?tool=videos`
2. That endpoint generates `HMAC-SHA256(ADMIN_EMBED_SECRET, Date.now())`
3. Returns `https://headpinz.com/admin/embed/videos?ts={timestamp}&sig={hex}`
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

**Same secret as bowling and e-tickets.** All embed pages share `ADMIN_EMBED_SECRET`.
Rotating the secret invalidates all outstanding URLs within 15 minutes.

---

## Portal Endpoint

Generalize the existing `bowling-admin-url.ts` to accept a `tool` parameter:

```ts
// GET /api/integrations/admin-embed-url?tool=videos
import { createHmac } from "crypto";

const EMBED_SECRET = process.env.ADMIN_EMBED_SECRET || "";
const tool = req.query.tool || "bowling"; // "bowling" | "e-tickets" | "videos"
const ts = String(Date.now());
const sig = createHmac("sha256", EMBED_SECRET).update(ts).digest("hex");
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

The video admin page does **not** yet have the CSS variable theme system that
bowling has. When embedded, it renders in its default dark theme. Theme support
(URL param + postMessage) can be added later using the same pattern as bowling.

---

## API Endpoints Used

The video admin client calls these APIs (token injected server-side):

| Endpoint                                    | Method | Description                        |
| ------------------------------------------- | ------ | ---------------------------------- |
| `/api/admin/videos/list?token=...&date=...` | GET    | List matched videos for a date     |
| `/api/admin/videos/resend?token=...`        | POST   | Resend video link (SMS/email/both) |

These are also accessible via the portal's api-key auth (`x-api-key` header with
`SALES_API_KEYS`).

---

## Quick Start

1. Set `ADMIN_EMBED_SECRET` on both Vercel projects (same value as bowling)
2. Generalize the portal's `bowling-admin-url.ts` to accept `?tool=videos`
3. Render `<iframe src={signedUrl} />` in the portal
4. Done — the page handles everything else
