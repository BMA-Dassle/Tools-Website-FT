# Session Check-In Notifications (Text + Email)

## Context

When Pandora's `GET /bmi/races/current/{locationID}` endpoint returns a new "now checking in" heat for a track, we want to automatically notify every racer whose booked heat matches the checking-in heat. Right now the live "Now Checking In" badge shows on the homepage and confirmation page, but racers already at home, at lunch, or not watching the site won't see it.

The existing Have-A-Ball booking confirmation, race-day instructions email, and level-up email all show the send-email + send-SMS pattern. We have the matching logic in place (confirmation page `isMyHeat` check), so the data side is ready.

## What triggers

A new Pandora call for `{track}` where `scheduledStart` or `sessionId` differs from the last-seen value for that track. The check runs on the existing Vercel cron schedule (every 2 min) we use for level-up detection — same cadence works here.

## Files to create

| File | Purpose |
|---|---|
| `app/api/cron/checkin-alerts/route.ts` | Cron: poll Pandora, find newly-called heats, match to booked racers, send alerts |
| `app/api/notifications/heat-checking-in/route.ts` | Send one alert (email + SMS) for one racer/heat |
| `emails/heat-checking-in.html` | Dynamic template — "Your heat is checking in NOW" |

## Files to modify

- `vercel.json` — add the new cron entry alongside the existing `race-day-emails` and `level-up-watch` crons
- `app/api/pandora/races-current/route.ts` — already writes each track's last-seen race to Redis with key `pandora:last-race:fasttrax:{track}`. We can reuse that as the source-of-truth for "what's currently called."

## Detection logic

Cron runs every 2 minutes:

1. Read current races from `/api/pandora/races-current` — gets `{ blue, red, mega }`.
2. For each non-null track, read Redis key `alert:last-sent:{track}:{sessionId}`. If it exists, we already alerted on this heat — skip.
3. If this sessionId is new: query Redis for all racing `bookingrecord:*` entries where `racers[].heatStart === currentRace.scheduledStart` AND day matches today (Eastern Time).
4. For each match, POST to `/api/notifications/heat-checking-in` with `{ racerName, email, phone, heatStart, heatNumber, raceType, track, resNumber }`.
5. Set Redis key `alert:last-sent:{track}:{sessionId}` with TTL 6 hours so we don't double-fire.

## Notification content

**SMS** (160 char budget):
> FastTrax: Your heat is checking in NOW. {TrackName} Heat #{N} — {RaceType} at {Time}. Head to Karting 1st Floor. Res {W####}.

**Email**:
- Subject: "YOUR HEAT IS CHECKING IN — Head to Karting"
- Big "NOW CHECKING IN" hero with race time
- Track + heat number + race type
- Express-lane: "Skip Guest Services, go straight to Karting 1st Floor"
- Non-express: "Be at Guest Services 2nd Floor immediately"
- Reservation number
- QR code if we have one stored

## Opt-out handling

Only send if `bookingrecord.smsOptIn === true` for SMS. Always send email (racers expect confirmation emails about their heats).

## Dedup & rate-limit safeguards

- `alert:last-sent:{track}:{sessionId}` — prevents duplicate fires for the same heat on multiple cron runs.
- `alert:sent:{billId}:{sessionId}` — per-bill dedup so if Pandora reports the same heat twice we still only alert each racer once.
- Lock window: if the cron runs at 5:48 PM ET and the heat's `scheduledStart` is 5:48 PM, send. If `scheduledStart` is > 60 min old (stale data from Pandora), skip — probably not a real call anymore.

## Verification

1. During FastTrax operating hours, trigger the cron manually: `GET /api/cron/checkin-alerts` with the cron secret
2. Confirm it reads Pandora, finds any active heats, and logs "would-notify: [racerName]" for matching bookings — dry-run mode flag first so we don't blast real customers during testing
3. Remove dry-run flag, do a real send for one test racer (Eric) booked on the live checking-in heat
4. Verify email + SMS arrive within 30s of the heat being called
5. Verify a second cron run does not re-send (Redis dedup)
6. Check off-hours: cron returns empty, no sends

## Open items

- **Email template** — should this use the same style as race-day-instructions, or something more urgent (red border, pulse)?
- **SMS sender** — use Voxtelesys number as we do elsewhere, or dedicated alert number?
- **Attraction heats** — same pattern for gel blaster/laser tag when those start? (Different Pandora endpoint if/when it exists.)
- **Multi-racer bills** — if a bill has 3 racers on different heats, we want separate SMS per racer, not one lumped message. Already supported by the per-racer booking record shape.

## Status

Planned. Not started. Pick up after Pandora's `scheduledStart` field is reliably populated and the on-screen "Now Checking In" badge has proven itself over a weekend of operating hours.
