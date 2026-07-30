# Waiver short-links — overnight run report (2026-07-30)

**Branch:** `feat/unified-waiver` (Vercel preview). **`main` was never touched.**
**No live emails were sent** — those senders are guest-facing crons.

---

## TL;DR

| Piece | State |
|---|---|
| `buildWaiverUrl` canonical helper + contract test | **On preview** (`cc6a1d91`), 9/9 |
| **Short-link minting** (`/w/{code}`, admin vs register) | **On preview** (`1350f853`), 89/89 |
| **Stage 2 — every entry point on short codes** | **On preview** (`d01ad8c5`), 27 files |
| Roster preload (show who's registered) | **NOT COMMITTED — shelved, see below** |

Three of four shipped. Stage 2 is done — §3 below replaced. The roster preload is
still shelved, but your two naming decisions shrank it a lot (§2).

---

## 1. What is on preview and safe to review

### `1350f853` — Neon-durable capability short links

A waiver link is now an opaque code; the capability lives in the code, not a query param.

* **ADMIN** code → waiver page **with the roster and remove**. Only ever sent by us, to the booker.
* **REGISTER** code → sign only. This is what Share/Text/Email/Copy hands out.

Why it matters beyond tidiness: a guessable `?flag` would have let anyone holding a
forwarded link delete guests from someone else's booking. Two codes also make sharing
*structurally* unable to escalate — the admin capability is not in the share payload at all,
so nothing depends on remembering to strip a parameter.

Durability copies `group_function_quotes.contract_short_id`, **not** the Redis-only `short:`
model: Neon is the source of truth (UNIQUE per reservation+capability → idempotent minting,
one stable code), Redis is only a cache, and a Redis miss falls back to Neon. `/s/` is
Redis-only on a 90-day TTL and this Redis has an OOM history — a guest clicking a December
event's link in November must not get nothing.

**Three adversarial audits found three defects that 38 green tests did not:**

1. **Every HeadPinz link 404'd.** `/w` is a new top-level path and was missing from
   `isSharedTopLevelRoute` — the exact CLAUDE.md rule that exists because HeadPinz visitors
   404'd once before. Now registered as `"/w/"` **with** the trailing slash (bare `"/w"`
   would swallow `/waiver` and `/waiver-3`), and the pin is **mutation-tested**.
2. **A real capability escalation.** `resolveWaiverLink` answered from the Redis cache and
   that payload carried the capability — so the thing authorising a guest DELETE came from a
   disposable 90-day key. Reproduced: seeding a register code's cache with `cap:"admin"` made
   `waiverLinkGrantsAdminFor` return **true**. Worse, demoting the row still returned true:
   **the grant was unrevocable for up to 90 days.** Fixed so the types make it impossible.
3. **`unknown` vs `unavailable` were conflated.** A missing table was reported as "unknown",
   so every outstanding link was declared dead *and had its grant cookie cleared*. A corrupt
   capability column caused a permanent 503 on a link whose redirect was derivable.

I also bounded the post-resolution hit write at 400 ms myself: it is awaited (a serverless
freeze drops a detached write) but swallowing errors does not bound **latency**, and one
forwarded link is **one row**, so a whole party contends on `hits = hits + 1`.

Gates: tsc clean · 98 tests · eslint clean · `next build` exit 0.

---

## 2. Why the roster preload is NOT committed

It went **three fix rounds** and every audit round found new defects — two of them
*introduced by the previous round's fix*. Round 3's confirm pass still reports:

* **A confirmed regression causing the exact harm the feature had to avoid:** the join↔BMI
  name key no longer folds identically for rows **already at rest**, so a guest who has
  already signed **is re-asked and appears twice**.
* Two further **false-completion** paths (the roster branch falls through to a frozen fraction).
* A **false privacy promise** still on screen.

Tests were green at 78 → 98 → 136 → 138 the whole way. That is the pattern worth taking
seriously, not the individual bugs.

The root difficulty was real and structural: **the redaction rule doubled as the dedupe key**
between Neon join rows and BMI registered rows. Tightening privacy and preserving
identity-matching pull in opposite directions, and rows already written under the old rule
cannot be re-folded.

### Your two decisions dissolved most of that

> *"full names are fine on all now that we do specific links"*
> *"kiosk roster can show it too — the only place we don't is the list of reservations on kiosk"*

That collapses a policy I had sprayed across five callers down to **one** place —
the kiosk reservation **picker**, which is browsable before identity is proven.
Everything else (kiosk waiver roster, the admin-code waiver roster, check-in) is
already scoped to someone who picked their own booking.

Consequences, honestly stated:

* The **confirmed regression evaporates** rather than needing a fix. Raw names on both
  sides means the dedupe keys agree by construction, so a signed guest is no longer
  re-asked and duplicated. Most of rounds 2–3 (the folding rules, the monotonicity
  oracle, the `"W."` collapse) was solving a problem that only existed on paths that
  never needed redaction — it can be reverted, not repaired.
* **I need to correct §4 below.** I reported a "live PII leak on main". Under your rule
  it is not a leak, and I would rather retract that than leave you thinking there is an
  open exposure.

What genuinely remains is the two **false-completion** paths: `total` comes from
`detail.persons` while `roster` comes from `persons_list`, so a booking where nobody has
signed can still show "All waivers signed". That is arithmetic, not privacy — a much
smaller job than the three rounds suggested.

The work is intact in the working tree (uncommitted) if you want to look; nothing is lost.
It is **not** in `d01ad8c5` — stage 2 was committed independently of it, and I verified
none of the 27 staged files imports the shelved modules.

---

## 3. Stage 2 — DONE (`d01ad8c5`, 27 files)

Every waiver surface now goes through `lib/waiver-link-send.ts`. **Nine senders** each
hand-rolled the identical external URL:

```
fetchProject(...) → `kiosk.sms-timing.com/{ck}/subscribe/event?id={projectReference}`
```

Collapsing them removed three defects along with the duplication:

1. It was an **external BMI page**, so no guest who arrived by email ever saw the
   first-party flow — roster, guardian, sign log, Spanish, in-house template. All of
   that work was reachable only by typing the URL.
2. It needed a **BMI Office round trip per send** purely to read `projectReference`,
   and when that failed the sender **skipped the email**. Two crons silently dropped
   waiver reminders — including the final 48-hour warning — whenever BMI was briefly
   down. A short link needs only `center_code` + `bmi_reservation_id`, both already
   columns on the quote, so that call is gone entirely.
3. Its fallbacks were hardcoded to `headpinzftmyers` — **Naples guests were sent to
   the Fort Myers tenant**, where their waiver is not valid.

**Capability follows the audience; copy follows the capability.** That coupling turned
out to be the whole design problem. The old emails said *"please forward this link to
everyone in your group"* — forwarding an admin link hands every guest the remove
button, so the copy had to change with the link:

| Surface | Link |
|---|---|
| The 3 dedicated waiver emails + their SMS | **admin** CTA **and** a sign-only share box — both, labelled |
| Banner on every lifecycle email, 96h + receipt nudges | **register** (their copy has always said "share this") |
| Contract page: Open | **admin** |
| Contract page: Copy / Share-via-Text | **register** |
| Racing: booking-confirmation, race-day instructions/emails | **admin** (addressed to the booker) |

`waiver-venue.ts` **refuses an unknown `center_code`** rather than defaulting to
HP-FM. "fort-myers" and "fasttrax" are two venues on one BMI server with two Pandora
locations, and Naples has its own template — a wrong venue files a waiver the guest
does not have. It is pinned against `CENTER_TO_BMI_LOCATION_IDS`, which is what
`/api/waiver/context` validates, so an impossible pair fails in a test rather than in
someone's inbox.

Both carried-forward defects are implemented: **F1** — the confirmation pages no longer
read `getBookingLocation()` after `clearBookingLocation()` wiped it (which made every
booking, HeadPinz Naples included, resolve to Fort Myers). **F2** — the waiver origin
comes from the resolved booking location, never a brand-less request origin, and an
absolute supplied URL keeps its own origin through the upgrade. The
`group-event-rules.ts` name collision is gone (`eventWaiverLinkUrl`), and a test now
asserts only one `buildWaiverUrl` can exist.

### The audit caught three surfaces the sweep missed

`waiver-entry-points.test.ts` checks the invariants against the **tree** instead of
trusting the sweep — and immediately found:

* **`components/Nav.tsx`** — the FastTrax main nav still linked
  `kiosk.bmileisure.com/headpinzftmyers`. The nav/footer cutover (`332bd1c2`) reached
  `components/Footer.tsx` and `components/headpinz/*` but **skipped this one**. A live,
  guest-facing legacy link on every FastTrax page.
* **`app/hp/book/bowlingold/confirmation/page.tsx`** — two hand-rolled legacy URLs,
  one of them built from `projectReference` (which is *not* a `pid`, so it could only
  ever look reservation-scoped while attaching to nothing).
* **`LEGACY_WAIVER_URLS`** — a ready-made pair of legacy URLs still exported from
  `build-waiver-url.ts`, the module written to replace them. Unused, so an invitation.

Worth noting how it nearly failed: the obvious way to stop the test tripping on the
"was kiosk…" history comments is to strip comments first — and that is the **wrong**
tool, because a naive `//…` strip eats the `//` in every URL literal and would have
turned the three real offenders into passes. It matches quote-prefixed URLs instead.

### Deliberately NOT short-linked

The **4 booking confirmation pages** keep the canonical long `/waiver` URL. They are
client components, so minting there would need an unauthenticated mint endpoint —
anyone could mint an **admin** code for any guessable `projectId`. That is a real
escalation for a small convenience; the booker gets their admin link by email. The
long link still attaches the waiver to the reservation, it just has no remove button.

**Nav and both footers** stay on the long URL too: nothing is sent, there is no
reservation, and there is nothing to repoint. (Flagged to you earlier, unanswered —
this is my assumption, easy to change.)

---

## 4. Findings that need a human, independent of what ships

1. ~~**`makeDisplayName` was leaking full names beyond the waiver feature.**~~
   **RETRACTED.** I reported this as a live leak on main. Per your naming decision it is
   not one: the affected callers were the **kiosk roster** and **check-in**, both of
   which you have said may show full names. There is **no open exposure here** and
   nothing to remediate. The one surface that must stay redacted is the kiosk
   reservation **picker** — and whoever implements that must *confirm the exact picker
   path* (likely `app/api/kiosk/waiver/reservations`) rather than assume it.
2. ~~**`app/event/[slug]/page.tsx:152` has a local copy of the same bug.**~~
   **RETRACTED** for the same reason — it is a group-event roster, not the picker.
3. **8 guests paid for race packs and never got their races** — 26 credits, $500.47
   collected. Separate chat has the desk worksheet. Needs a person, not code.
4. **`/waiver` A3 attach is still unproven** — `registerProjectPerson` against an existing
   confirmed project. Probe exists: `scripts/kiosk-waiver-attach-probe.mts`.

---

## 5. What could NOT be verified

* **No browser smoke.** Nothing here has been opened in a browser by me.
* **No live email send** — deliberate: `group-7day-waiver` would mail every group contact
  with an event in 7 days. So **no email in §3 has been seen rendered.** The HTML is
  reviewed and typechecked, not viewed.
* **`/w/{code}` never served over real HTTP.** Route→URL mapping rests on App Router
  convention plus unit-tested middleware, not a running server.
* **No code has ever been minted against real Neon.** `waiver_link_codes` does not exist
  in any database yet — the first mint bootstraps it. The lazy `CREATE TABLE` path is
  unit-tested, never executed.
* **A3 attach** — unproven, as above. This is the one that would change my confidence
  most: it is what proves a reservation-scoped link actually attaches a signature.
* **Stage 2 gates ran with the shelved roster changes in the tree.** I verified none of
  the 27 staged files imports a shelved module, and re-ran tsc + the waiver suites after
  the pre-commit reformat — but a preview deploy of the committed state is the real check.
* **The FastTrax nav fix is unviewed.** It is the highest-traffic surface I touched and I
  changed a nav item on every FastTrax page; worth one glance.

---

## 6. Suggested order when you pick this up

1. **Deploy preview and click `/w/{code}` on BOTH hosts.** The HeadPinz 404 was real and
   nothing here has been opened in a browser.
2. **Read one waiver email end to end** — a preview send to yourself, not a cron. What I
   most want checked by a human is that the two links in the dedicated waiver emails read
   clearly as "yours" vs "share this", because that distinction is the security boundary
   and it is carried entirely by copy.
3. A3 attach probe against a throwaway project (`scripts/kiosk-waiver-attach-probe.mts`).
4. The roster preload, now much smaller: revert the waiver path to raw names (without
   blanket-reverting `lib/display-name.ts` — it has four other callers), keep redaction
   only on the kiosk reservation picker, fix the two false-completion paths, then gate the
   roster behind the admin code (which also closes "nothing consumes `WAIVER_LINK_COOKIE`").
5. Purge the probe persons: 56906741, 8521875, 56906750, 56906759, 56906767, 56906779.

### One judgment call worth your eye

You said *"the links in the email and sms have the full roster."* I gave the **SMS** the
admin link to match that literally — but an SMS is the most-forwarded thing we send. The
copy no longer says "forward this", and removal is only reachable from the roster UI
behind a 12-hour cookie, so the exposure is bounded. If you would rather the SMS carry
the sign-only link, it is a one-line change per sender and I will make it.
