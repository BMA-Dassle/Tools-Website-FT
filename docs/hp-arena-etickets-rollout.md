# HP Arena E-Tickets — Rollout Runbook

Status: code complete on stacked branches (2026-06-11), NOT live. Branch chain:
`arena-etickets-pr1-shared-plumbing` → `pr2-ticket-pages` → `pr3-cron-admin` →
`pr4-schedule` → `pr5-scanner`. Merge in order; PR-4 (the vercel.json schedule)
is the go-live switch and must wait for the dry-run sequence below.

Covers Nexus Laser Tag + Nexus Gel Blaster at HeadPinz Fort Myers
(`TXBSQN0FEKQ11`). BMI dayplanner resource: `"HP Arena"` (single resource,
both activities — live-probed 2026-06-11). Naples is explicitly out of scope
until the dedup keys are location-scoped (see Naples section).

## Owner decisions still open

- **0b — Online-booking participant attachment (verification, not a blocker).**
  The cron sources participants from `/bmi/session/{loc}/{sid}/participants`.
  POS/phone bookings verifiably attach participants ahead of time (probed:
  tonight's 9 PM session had 4 paid participants hours early). UNVERIFIED:
  whether a v2 ONLINE arena booking (qty-only + purchaser on the bill) creates
  participant rows pre-session. To verify: place one online laser tag booking
  2h+ out on headpinz.com, then
  `GET /v2/bmi/session/TXBSQN0FEKQ11/{sessionId}/participants` (Bearer
  SWAGGER_ADMIN_KEY). If purchaser-only or empty → launch still covers the
  POS/phone population; follow-up = send the e-ticket link at
  booking-confirmation time (the HP-branded `/api/notifications/booking-confirmation`
  rail already exists).
- **0c — SMS sender.** Code defaults to the existing HeadPinz FM DID
  `+12393022155` (A2P-registered, already texting HP FM customers for bowling /
  surveys / confirmations). Override with env `VOX_FROM_HEADPINZ_FM` if a
  dedicated arena DID is ever provisioned. Confirm reuse is acceptable.
- **0d — Copy sign-off.** `ImportantArenaInfo` (arrive 15 min early, waiver,
  closed-toe shoes, lockers) and the HP FM address `14513 Global Parkway` are
  conservative defaults — review before PR-2 merges.

## Pandora-team ask (copy-paste)

> **Request: arena session check-in notifications at HeadPinz Fort Myers (TXBSQN0FEKQ11).**
>
> Today `/v2/bmi/races/current/{locationID}` is populated by
> bmiNotificationProcessor exclusively from FastTrax track SessionAboutToStart
> notifications. We need the equivalent signal for HP Arena resources so we can
> (1) text guests "your session is checking in now" and (2) gate staff QR
> check-in on the live call instead of a fixed time window.
>
> Preferred shape: `GET /v2/bmi/sessions/current/{locationID}` → `{ data: [{
sessionId (string), resourceName, type, heatNumber, scheduledStart, calledAt
}] }` — every session whose SessionAboutToStart fired in the last ~30 min,
> any resource (we need at least the "HP Arena" resource; generic is better for
> Naples later), entries dropping ~20 min after call (same semantics as
> races-current).
>
> Also please confirm: does `GET /v2/bmi/race/next/{locationID}/{person|participant}/{id}`
> return arena sessions at TXBSQN0FEKQ11, or is it race-only? We use it for
> "come back at X" messaging at the scan desk and will degrade to
> session-metadata display if it's race-only.
>
> No changes needed to `/bmi/sessions`, `/bmi/session/.../participants`, or
> `/bmi/checkin` — verified working for arena sessions already.

**Integration seam already deployed:** ticket pages poll
`/api/race-session-state` (generic Redis `race:called:{sessionId}`). When the
endpoint lands, build an `arena-checkin-alerts` cron that polls it and writes
`race:called:{sid}` + sends the second SMS (source `arena-checkin-cron`,
dedup `alert:arena-checkin:{sid}:{pid}`) — deployed tickets light up the
"checking in now" banner with no redeploy.

## Dry-run → go-live sequence

1. Merge PR-1 → verify racing regression: `pre-race-tickets?dryRun=1` candidate
   counts unchanged; scanner `GET /api/admin/checkin?selftest=1&token=…` green;
   open a live racing `/t/{id}` on BOTH fasttraxent.com and headpinz.com.
2. Merge PR-2 → mint synthetic tickets
   (`node scripts/mint-test-arena-ticket.mjs [--state past|moved] [--group]`)
   and walk the states on both domains. CheckedIn state needs a real
   sessionId/personId from a live arena session (pass `--session`/`--person`).
3. Merge PR-3 → prod dry-runs across ≥3 evenings:
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://fasttraxent.com/api/cron/arena-tickets?dryRun=1"`
   — check `candidates` vs the BMI dayplanner, `[arena DRY]` log lines for
   guardian fallback + family grouping, `unclassifiedSessions` for surprise
   session names. Zero sends. Then ONE supervised live run via curl (no
   schedule) on a low-volume morning with team phones among recipients:
   sender shows +12393022155, link opens HP-branded ticket on headpinz.com,
   click telemetry + delivery webhook flip, admin board row reads
   "Laser Tag · Heat N", resend uses the HP number.
4. Merge PR-4 (one-line schedule) → watch the first live evening end-to-end.
   Check Vercel cron capacity in the dashboard first (29 crons after this).
5. Merge PR-5 when the desk is briefed — arena tickets then render a QR and
   the scanner accepts `HP:` payloads (green within −60/+30 min of start).
6. Racing canary week: compare daily `bySource.eTicket` counts vs prior week.

## Naples (before onboarding PPTR5G2N0QXF7)

Naples runs a SEPARATE BMI server — sessionIds can collide with FM's
namespace. These keys must gain a location segment first:
`ticket:bySession:{sid}:{pid}`, `alert:arena-pre:{sid}:{pid}`,
`race:called:{sid}`, participant-index `ticket:byParticipant:{participantId}`.
The QR already carries locationId (HP form) and the scanner threads it, so the
scan path is Naples-ready.

## Key files

- Cron: `apps/web/app/api/cron/arena-tickets/route.ts` →
  `apps/web/src/features/arena-tickets/service.ts` (+ `sms.ts`, `email.ts`)
- Views: `apps/web/src/components/features/arena-tickets/` (branch points:
  `app/t/[id]/page.tsx`, `app/g/[id]/page.tsx`)
- Constants/flags: `apps/web/src/features/arena-tickets/constants.ts`
  (`ARENA_QR_ENABLED`, `VOX_FROM_HEADPINZ_FM`, `HEADPINZ_SITE_URL`)
- Scanner: `apps/web/app/api/admin/checkin/route.ts` (`handleArenaScan`)
- QR payload: `apps/web/lib/qr-checkin.ts` (`HP:{loc}:{pid}:{sid}[:{participantId}]`)
