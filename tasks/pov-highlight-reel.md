# POV highlight reel — check-in guide wall

**Status 2026-08-17: data layers SHIPPED to main, clipper written but UNSMOKED, display not built.**
Paused here deliberately. Everything below is resumable without re-deriving anything.

## What it is

Cut each racer's **actual fastest lap** out of their Viewpoint (VT3) video, keep ~10 clips on Vercel
Blob, and play them as a silent auto-advancing reel on the **check-in guide wall** (signage role
`check-in-guide` — the screen the owner calls "the secondary check-in TV").

Owner decisions, 2026-08-17:

| | |
| --- | --- |
| Selection | Top 5 Pro + top 5 Intermediate, by fastest lap |
| Window | Rolling 7 days, **recomputed daily** |
| Clip length | **12s** — "we don't want to give their secrets away" |
| Overlay | "Ticker" design, **top** of frame, with a race-type chip; **static** best time |
| Placement | New scene in the guide-wall rotation |
| Clipper host | **Railway** (`pov-clipper/`) |

---

## SHIPPED (on main)

- **`race_lap_results`** — the standings capture, archived past its 48h Redis TTL. Also fixes the
  21.8% of POV-overlay cards that were being lost to that expiry.
- **`race_best_laps`** — best lap **and its `PassingTimeUtc`** per (session, racer). Idempotent by
  construction: only a strictly faster lap overwrites, so replays and out-of-order delivery
  converge. ~330 rows/week.
- **`race_timings`** gains `pause_count` / `first_paused_at` / `duration_ms`, fed from
  `SessionPausedNotification`. Deliberately **separate from `track-events.server.ts`**, which owns
  the incident log — this is a denormalised counter so the reel's filter is a column read.
- **`src/features/pov-reel/select.ts`** — selection rules, 19 tests.
- **`kart:events:queue`** cap 5,000 → 100,000 with a 72h TTL. The old pair claimed 24h while
  actually holding **3.6 hours**, because the cap evicted long before the TTL fired.
- **`pov-clipper/`** — Railway service. Inert until someone creates the service.

Also on branch `feat/pov-reel-clipper`.

---

## REMAINING WORK

### 1. Deploy the clipper (blocks everything below)

New Railway service, root `pov-clipper/`. Env: `KART_BRIDGE_SECRET`, `BLOB_READ_WRITE_TOKEN`,
`CLIP_RESULT_WEBHOOK`. Check `GET /health`.

**It has never run against a live video.** The burn-in maths is verified (reproduces a
by-eye-confirmed offset of 443.9s exactly) and the ffmpeg invocation ran fine locally all evening,
but ffmpeg-over-HTTP + tesseract only exist inside that container. **First `/build` is the real
test.** Watch `anchor` in the results: `"burn-in"` is exact, a wall of `"estimate"` means OCR is
broken.

### 2. Daily cron + result webhook

- `app/api/cron/pov-reel-build/route.ts` — `verifyCron` + `?dryRun=1`, house pattern. Reads
  `race_best_laps` over 7 days, runs `selectReel`, POSTs jobs to the clipper's `/build`.
  A dry-run harness already exists: `apps/web/scripts/_pov-reel-dryrun.mts`.
- `app/api/webhooks/pov-reel-clip/route.ts` — receives per-clip results, writes the manifest.
- **`pov_reel_clips` table, keyed on `video_code`** (not week+rank — that cannot express "this clip
  survived into today's top 10").

**RECONCILE, NEVER REBUILD.** Re-cutting all ten nightly would burn ~94MB of uploads and ten VT3
impressions to reproduce yesterday's reel.

| State | Action |
| --- | --- |
| Still in the top 10 | Keep the blob. No re-cut, no `/check`, no impression. |
| New entry | Cut, upload, insert row. |
| Dropped out | `del()` the blob, delete the row. |

Delete on the run **after** a clip leaves the reel, not the same one — a wall may be mid-loop on it.
There is no automatic blob expiry and no cleanup cron in this repo; it must clean up after itself.

### 3. The signage scene

Follow the full registration checklist — skipping any step silently paints ads instead:

1. `SceneType` union + `ROTATION_SCENE_TYPES` (`signage/types.ts`)
2. `case` in `scenes/registry.tsx` **and** an entry in `IMPLEMENTED`
3. `sceneHasData` clause — no clips ⇒ scene skipped, wall stays wayfinding
4. `ScreenConfig.povReel` + default in `resolveScreenConfig`
5. Feed section in `service/feed.ts`, gated on `config.playlist.some(...)`
6. Checkbox in `SignageAdminClient.tsx`
7. Kill switch in `signage/flags.ts`, default ON per house rule

Player: `muted playsInline autoPlay`, advancing on `ended`. Card is **DOM over video** — reuse
`buildOverlay` and the markup from `app/admin/[token]/pov-overlay/PovOverlayPlayer.tsx`.

**THE TV MUST NOT RE-DOWNLOAD THE REEL** (owner). ~94MB a rotation over venue internet is the same
starvation that once blacked out a briefing room. Reuse `video-cache.ts` (Cache Storage, **not** the
HTTP cache — Chromium evicts large media from it) with:

- **its own cache name** (e.g. `pov-reel-v1`); sharing `briefing-videos-v1` lets daily churn evict a
  briefing film
- cache key = the blob URL, so a surviving clip stays cached and only new clips download
  (~1-3/day, ~20-30MB, not 94MB)
- prune on manifest change, or the wall accumulates ~9.5MB/day forever
- prefer a cached clip and skip ahead rather than stalling — a buffering wall looks broken
- **prefetch yields to briefing films** (`useBriefingAssets.ts` already aborts in-flight downloads)

**Guide-wall placement:** add `{scene: "pov-reel", slots: 1}` to the `check-in-guide` playlist. The
briefing takeover (`GUIDE_TAKEOVER_MS`) **must still win outright** — that arrow is wayfinding, and
a reel covering it sends guests the wrong way.

---

## HARD-WON FACTS — do not re-derive

- **The camera burns a wall clock into every frame** (`YYYY/MM/DD HH:MM:SS`, bottom-left), advancing
  1:1 with playback. `videoStart = burnInAt(t) − t`. This is the whole alignment solution.
  Verified three ways: burn-in maths said t=443.9s, the frame there read `23:00:03`, timing said
  `23:00:02.948`.
- **`created_at` is NOT a shortcut for that.** Looked 5s accurate on one video; across **1,385
  videos the interquartile spread is 243 seconds**.
- **The centring heuristic is ~55s wrong** and is a fallback only. Padding is ~1:2 head:tail —
  cameras keep running while the group walks back.
- **Per-lap data already flows** despite the bridge sending `Timing: "false"` (251 passings in one
  window). Nothing needs enabling. Older notes saying otherwise are stale, as are notes saying
  Crash/SpeedChange never flow — 492 crashes and 1,387 SpeedChange in one window, plus
  `EmergencyOn/OffNotification`, the literal e-stop.
- **Cutting the fastest lap makes cautions impossible** — a yellow lap is never anyone's fastest.
  **Do not build a motion-based yellow filter:** pixel motion scored a known yellow-flag clip at the
  **69th percentile** of its own race. It cannot see cautions.
- **Exclude juniors separately, before tier** — "Junior Pro" and "Junior Intermediate" both pass a
  naive tier test.
- **Reject any video shorter than its race**, never clamp (real case: a 191s video of a 501s race —
  camera mounted late).
- **`-ss` goes BEFORE `-i`** so ffmpeg range-seeks. 25s out of a 14-min/800MB source took 10s.
  Reordering silently downloads the whole file.
- **`/check` counts as a VT3 impression** and pollutes `VideoMatch.viewed`. Never poll it.
- **Rotate the sector** (opening / middle / run to the line) or every clip is the same corner.
- **Sizing:** ~9.5MB per 12s clip at 6 Mbps (source runs 8.9 Mbps); 10 clips ≈ 94MB.

## Open questions

- **The 5/5 tier split may not fill.** Across 199 unlocked videos over 3 days, 44 candidates were
  eligible and **not one was Pro** — Intermediate drivers are running under Blue's 32.5s Pro cutoff.
  Backfill is implemented; re-check once a full week of data exists.
- **`race_lap_results` and `race_best_laps` overlap** — both hold a best lap per racer, from
  different sources (standings capture vs passings). They cross-validated exactly (37.244 on Chris
  ferguson). Keep both consciously or collapse them; don't discover it later.
- **Railway idle cost** ~$5/month for a daily job. A Railway **cron** on the same image would pay
  for minutes instead, at the cost of a few more moving parts.

## Local sample (what the owner signed off on)

Reproducible with the untracked probes in `apps/web/scripts/`:
`_pov-fastlap-pick.mts` → `_pov-fastlap-frame.mts` (read the burn-in by eye) →
`_pov-fastlap-reel.mts` → `_pov-fastlap-page.mts`.
