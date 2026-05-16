# Plan: Video block/unblock + VT3 customer email link

## Context

Staff needs to stop certain race videos from reaching racers — usually:
- Crash / safety incident in a heat → block the whole heat
- Individual complaint / minor without parent release → block one racer
- After-the-fact: staff sees a bad video in admin → block just that one

Mechanism today: cron matches video → sends SMS + email. Once notified,
can't recall. Need a pre-flight + post-match block that:
1. Marks videos non-notifiable on OUR side (SMS/email suppressed)
2. Calls VT3 to `disabled: true` so the vt3.io link also stops playing

Also: on every successful match, push the racer's Pandora email to VT3
so `control-panel.vt3.io` links that video to the customer's vt3.io
account profile (customer then sees it in "My Videos" on vt3.io + VT3's
own purchase-confirmation emails land in their inbox).

## VT3 endpoints (from HAR)

1. **Block / Unblock**: `PUT https://sys.vt3.io/videos/by-code/{code}`
   body `{"disabled": true|false}` → 200
2. **Link customer email to video**: `POST https://sys.vt3.io/videos/{code}/customer`
   body `{"email": "..."}` → 200

Both use same JWT + `x-cp-ui: mui` + `x-cp-ver: v2.48.2` we already send
on `/videos`.

## Data model

### Redis keys

- `video-block:session:{sessionId}` — heat-level block.
  Value: JSON `{ blockedAt, reason?, blockedBy? }` (presence = blocked)
- `video-block:person:{sessionId}:{personId}` — individual-level.
  Value: JSON `{ state: "block" | "unblock", blockedAt, reason? }`.
  `state: "unblock"` is the explicit "heat is blocked but this one person
  is NOT" override.
- `video-block:video:{videoCode}` — video-level (admin page).
  Value: JSON `{ blockedAt, reason? }`.
- `video-block:log` — sorted set for audit (score=epochMs, member=op description)

TTL 14d on all block keys (longer than match 90d is overkill; 14d is
plenty of "crash drama settles" window and lets Redis GC old keys).

### Resolution order

`isBlocked(sessionId, personId, videoCode)`:
1. If `video-block:video:{videoCode}` present → BLOCKED
2. If `video-block:person:{sessionId}:{personId}` present:
   - `state: "unblock"` → NOT BLOCKED (overrides heat)
   - `state: "block"` → BLOCKED
3. If `video-block:session:{sessionId}` present → BLOCKED
4. Else → NOT BLOCKED

### VideoMatch extension

Add to `VideoMatch` interface:
```
blocked?: boolean;
blockLevel?: "video" | "person" | "session";
blockReason?: string;
blockedAt?: string;
vt3CustomerLinked?: boolean;          // set true once we POST /videos/{code}/customer successfully
vt3CustomerLinkedEmail?: string;      // record which email was pushed
```

## Phases

### Phase 1 — data layer + VT3 helpers (no behavior change yet)

**Files**
- `fasttrax-web/lib/vt3.ts`
  - `setVideoDisabled(code: string, disabled: boolean): Promise<void>` —
    wraps `PUT /videos/by-code/{code}` with JWT+retry, same shape as
    `listRecentVideos`.
  - `linkCustomerEmail(code: string, email: string): Promise<void>` —
    wraps `POST /videos/{code}/customer`. Idempotent per (code, email) —
    hitting twice with same email is fine on VT3 side (they link or
    no-op).
- `fasttrax-web/lib/video-block.ts` — NEW
  - Types: `BlockState = { blocked: boolean; level?: "video"|"person"|"session"; reason?: string; blockedAt?: string; }`
  - `getBlockState(opts: { sessionId, personId, videoCode? }): Promise<BlockState>`
  - `blockSession(sessionId, ctx?)` / `unblockSession(sessionId)`
  - `blockPerson(sessionId, personId, ctx?)` / `unblockPerson(sessionId, personId)` / `overrideUnblockPerson(sessionId, personId, ctx?)`
  - `blockVideo(videoCode, ctx?)` / `unblockVideo(videoCode)`
  - `listSessionBlocks(sessionId)` → `{ sessionBlock?, personBlocks: Record<personId, BlockState> }` for the camera-assign UI to render red names
- `fasttrax-web/lib/video-match.ts` — add the 5 new fields to VideoMatch

**Acceptance**: `npx tsc --noEmit` clean. No behavior change on the live
cron until Phase 2 wires these in.

### Phase 2 — cron wiring

**Files**
- `fasttrax-web/app/api/cron/video-match/route.ts`

**Changes**
1. New-match save path: before calling `fireNotify()`, call
   `getBlockState()`. If blocked:
   - Save match with `blocked: true, blockLevel, blockReason, blockedAt, pendingNotify: false`
   - Call `setVideoDisabled(code, true)` (best-effort — log failure, keep
     the Redis block authoritative)
   - DO NOT call `notifyVideoReady`
   - Increment a new counter `skippedBlocked`
2. New-match save path: on NON-blocked matches where VT3 is ready,
   call `linkCustomerEmail(code, assignment.email)` in parallel with
   `fireNotify()`. Track outcome on the record (`vt3CustomerLinked`).
   Best-effort — failure here doesn't break the match.
3. Overlay pass (existing): add a "previously-blocked, now unblocked"
   branch. If `existing.blocked === true` AND `getBlockState()` returns
   `blocked: false` AND VT3 is ready:
   - Call `setVideoDisabled(code, false)` — re-enable vt3.io playback
   - Call `linkCustomerEmail` if not already linked
   - Call `fireNotify()` to send the deferred SMS/email
   - Patch record: clear blocked fields, set notify outcomes
4. Response JSON: add `skippedBlocked`, `unblockedAndSent` counters.

**Acceptance**: Dry-run returns new counters. Non-blocked path continues
to match baseline. `logCronRun` sees no error spike.

### Phase 3 — admin endpoints

**Files**
- `fasttrax-web/app/api/admin/cameras/block/route.ts` — NEW
  - `POST { scope: "session"|"person", sessionId, personId?, block: boolean, reason? }`
  - Scope=session: writes `video-block:session:{sid}` or clears it
  - Scope=person: writes person-level (block OR override-unblock)
  - Does NOT call VT3 here — videos from this heat haven't arrived yet.
    The cron handles the VT3 call when the video arrives + matches.
- `fasttrax-web/app/api/admin/videos/block/route.ts` — NEW
  - `POST { videoCode, block: boolean, reason? }`
  - Calls `setVideoDisabled(code, block)` on VT3 first
  - Sets/clears `video-block:video:{code}` + patches the VideoMatch
    record's `blocked` fields via `updateVideoMatch`
  - On UNBLOCK + match exists + VT3 ready + no prior notify:
    - Call `linkCustomerEmail` if not already
    - Call `notifyVideoReady` inline (don't wait for cron)

### Phase 4 — UI

**Files**
- `fasttrax-web/app/admin/[token]/camera-assign/CameraAssignClient.tsx`
  - "Block Heat" button at top of each heat card, confirm modal
  - Per-racer block toggle (trash can / lock icon)
  - Red text on racer names when their resolved state is blocked
  - "🚫 blocked" chip next to red names
- `fasttrax-web/app/admin/[token]/videos/VideoAdminClient.tsx`
  - "🚫 blocked" chip in the notified column (both mobile + desktop)
  - Block/Unblock button (replaces or accompanies Resend)
  - When blocked: row gets subtle red tint

## Critical files

| Path | Phase | Change |
|---|---|---|
| `lib/vt3.ts` | 1 | +2 helpers for VT3 PUT + POST |
| `lib/video-block.ts` | 1 | NEW — block state helpers |
| `lib/video-match.ts` | 1 | +5 fields on VideoMatch |
| `app/api/cron/video-match/route.ts` | 2 | block check + linkCustomerEmail + unblock-backfill |
| `app/api/admin/cameras/block/route.ts` | 3 | NEW — heat/person block endpoint |
| `app/api/admin/videos/block/route.ts` | 3 | NEW — video block endpoint |
| `app/admin/[token]/camera-assign/CameraAssignClient.tsx` | 4 | block UI |
| `app/admin/[token]/videos/VideoAdminClient.tsx` | 4 | block chip + button |

## Verification plan

1. **Block a test heat** via camera-assign → dry-run cron → rows for that
   heat come back with `blocked: true`, `skippedBlocked > 0`, no new
   video-match SMS hit the log.
2. **VT3 side** — go to `vt3.io/?code={someBlockedCode}` → video should
   not play (disabled:true on VT3 record).
3. **Email push** — match a new video → `vt3CustomerLinked: true` on the
   match record, `linkCustomerEmail` logged in VT3 response.
4. **Unblock heat** → next cron tick re-enables VT3 + sends the deferred
   SMS/email. `unblockedAndSent > 0`.
5. **Video-level block from admin** → click Block on a matched row →
   VT3 flip + SMS log shows no new send. Click Unblock → inline notify
   fires, chip flips back.

## Review (filled in at end of each phase)

### Phase 1 review
- ✅ `lib/vt3.ts` — added `setVideoDisabled(code, disabled)` + `linkCustomerEmail(code, email)`. Shared auth-retry helper extracted so both stay terse.
- ✅ `lib/video-block.ts` — NEW. 3-layer model (video/person/session) with person-level `"unblock"` override. `getBlockState()` batches the reads into one Redis MGET. `getSessionBlockSnapshot()` for the camera-assign UI paint.
- ✅ `lib/video-match.ts` — +8 fields: `blocked`, `blockLevel`, `blockReason`, `blockedAt`, `vt3CustomerLinked`, `vt3CustomerLinkedEmail`, `vt3CustomerLinkedAt` (block mirror + VT3 email-push tracking).
- ✅ tsc clean. No behavior change on live cron — all additions dormant until Phase 2 wires them in.

### Phase 2 review
(TBD)

### Phase 3 review
(TBD)

### Phase 4 review
(TBD)
