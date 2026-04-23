# Custom Viewpoint viewer + pay page

## Why

Today VT3 hosts the customer-facing video page at `https://vt3.io/?code=...`.
That works but:
- Every visit bumps `videoPageImpressionCount` + `mediaCentreImpressionCount`
  on the video record, which feeds VT3's billing/reporting — we can't audit
  or preview without skewing their numbers.
- Branding is generic "Viewpoint / Fast Trax" — no FastTrax layout, no racer
  name pull-through from our Pandora/camera-assign context, no upsell paths.
- Payment (unlock the full-length video) goes through VT3's checkout flow; we
  can't easily staple on our own pricing, loyalty credit, or Square checkout.

If we build our own viewer at, say, `https://fasttraxent.com/v/{code}`, we
control all three.

## What we already know

Everything needed to render + unlock a video lives in **one unauthenticated
endpoint**:

```
GET https://sys.vt3.io/videos/code/{code}/check
Origin: https://vt3.io
Referer: https://vt3.io/
```

Response body includes:
- `video.code`, `fileName`, `duration`, `camera`, `uploadTime`, `sampleUploadTime`
- `video.sample.url` — signed R2 URL, 24h TTL, **sample MP4** (always present
  after first stream)
- `video.url` — signed R2 URL, 24h TTL, **full MP4** (only after activation)
- `video.locked`, `video.purchaseType`
- `video.site` — full FastTrax site info (logos, colors, pricing,
  `displayPrice: "$7"`, `videoAvailableForPurchaseDays: 60`, etc.)
- `video.highlights` — array of highlight clips (if any)
- `customerAttached`, `redactionStatus`

Reference HAR (captured from https://vt3.io/?code=C9QYRTG9NV):
`tasks/future/reference/vt3-public-video-viewer.har`

Other endpoints the public page hits (visible in the HAR):
- `GET https://cdn.vt3.media/fast_trax_backgrond_57284f3c65.png` — site bg
- `GET https://cdn.vt3.media/ft_logo1_copy_*.png` — FastTrax logo
- `GET https://cdn.vt3.media/video-page/viewpoint-logo.png` — viewpoint logo
- Range GET on the R2 MP4 URL for playback

## Reasons to proceed

1. **View-count hygiene** — admin staff can preview without affecting
   billing numbers. Pull the video but don't post to `/check`; we already
   store the shortcode + sample URL we got at match time. Could cache the
   last signed URL from a scheduled re-mint that doesn't count as a view
   (assuming VT3 doesn't gate that too — need to verify).

2. **Upsell in our UX** — after the race we show the e-ticket, race results,
   THEN the video with a FastTrax-branded "unlock the full race — $7" card
   that goes through Square or BMI credits, not VT3 checkout.

3. **Embed in e-ticket page** — `/t/{id}` could render the sample below race
   info without kicking the user to another domain.

## Known unknowns before building

- **Does VT3's `/check` always bump impressions?** Maybe there's a query
  param (`?preview=1`) or a different endpoint the admin UI uses that
  doesn't count. Needs testing with fresh HAR captures comparing admin vs.
  customer views.
- **How does VT3 detect "unlocked"?** There's `locked: true/false` in the
  response. How does flipping that to false via purchase work? The VT3
  checkout flow isn't in the public HAR — we'd need to capture a purchase
  session to learn the Stripe or VT3 billing integration.
- **Can we serve our own unlock?** If purchase state is tracked solely on
  VT3's side, we'd need them to flip it — meaning either an API we don't
  have yet or we handle purchase entirely on our side and render the FULL
  MP4 URL directly (bypassing VT3's unlock gate). The signed URL for the
  full MP4 works without VT3 auth once obtained.
- **Rate limits on `/check`?** Didn't see one in the HAR but should probe.

## Minimum viable first slice

1. New route `/v/[code]/page.tsx` (server component). Fetch
   `/videos/code/{code}/check` on page load, pass result to a client viewer.
2. Client renders:
   - FastTrax header
   - `<video>` element using `video.sample.url` (the short preview)
   - Watermark or overlay: "Preview — unlock the full 5+ min race for $7"
   - "Unlock" CTA that triggers Square checkout or BMI credit flow
   - After success, swap to `video.url` (full)
3. If `video.url` is already present (already unlocked on VT3), just play
   that directly with no unlock CTA.

## Open TODO

- [ ] Capture a second HAR: admin watching vs. customer watching, to
      confirm whether impressions-counting differs by endpoint.
- [ ] Capture a HAR of a VT3 purchase flow to understand `locked → unlocked`.
- [ ] Decide: pay VT3 for unlock (use their API), or pay us + serve the
      full MP4 ourselves?
- [ ] Shortlink: `fasttraxent.com/v/{code}` or `fasttraxent.com/race/{code}`?
      Should the e-ticket link to this instead of vt3.io?
- [ ] Auth: the viewer page is public (same as vt3.io/?code=…). No gating
      unless we want to hide it behind a racer phone/email match.
