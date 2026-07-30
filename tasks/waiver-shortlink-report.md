# Waiver short-links — overnight run report (2026-07-30)

**Branch:** `feat/unified-waiver` (Vercel preview). **`main` was never touched.**
**No live emails were sent** — those senders are guest-facing crons.

---

## TL;DR

| Piece | State |
|---|---|
| `buildWaiverUrl` canonical helper + contract test | **On preview** (`cc6a1d91`), 9/9 |
| **Short-link minting** (`/w/{code}`, admin vs register) | **On preview** (`1350f853`), 89/89 |
| Roster preload (show who's registered) | **NOT COMMITTED — shelved, see below** |
| Email/SMS senders + contracts + confirmation pages (stage 2) | **NOT DONE — did not start** |

Two of four shipped. I did not get to the thing you most wanted (the senders), and I
stopped the roster preload on purpose. Both explained below, honestly.

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

The root difficulty is real and structural: **the redaction rule doubles as the dedupe key**
between Neon join rows and BMI registered rows. Tightening privacy and preserving
identity-matching pull in opposite directions, and rows already written under the old rule
cannot be re-folded. That deserves a deliberate decision, not another autonomous round.

The work is intact in the working tree (uncommitted) if you want to look; nothing is lost.

---

## 3. What I did not do: stage 2 (the senders)

**Not started.** The 10 email/SMS senders, PandaDoc contracts, the contract confirmation
page and the 4 booking confirmation pages are still on the **old external BMI links** —
exactly as they were yesterday morning. No regression, but no progress either.

I spent the night on the two prerequisites and on six rounds of audit-and-fix. That was the
right order (senders mint codes, so the mint module had to be correct first) but it means the
visible deliverable did not land.

Everything needed to do it in one pass is recorded in memory: which center/loc/pid each
sender resolves, the two defects to carry forward by design (**F1** never read
`getBookingLocation()` after `clearBookingLocation()` wiped it; **F2** never let a brand-less
origin decide the Pandora location), and the note that `lib/group-event-rules.ts` exports a
*different* function also named `buildWaiverUrl` into a live cron — a genuine collision trap.

---

## 4. Findings that need a human, independent of what ships

1. **`makeDisplayName` was leaking full names beyond the waiver feature.** It returned the
   first-name field verbatim when the surname was empty, and BMI frequently sends the whole
   name in that field. Four callers were affected including the **kiosk roster** and
   **check-in**. Fixed in the shelved work — so **this leak is still live on main.**
2. **`app/event/[slug]/page.tsx:152` has a local copy of the same bug.** Outside every
   agent's scope, untouched, still leaking.
3. **8 guests paid for race packs and never got their races** — 26 credits, $500.47
   collected. Separate chat has the desk worksheet. Needs a person, not code.
4. **`/waiver` A3 attach is still unproven** — `registerProjectPerson` against an existing
   confirmed project. Probe exists: `scripts/kiosk-waiver-attach-probe.mts`.

---

## 5. What could NOT be verified

* **No browser smoke.** Nothing here has been opened in a browser by me.
* **No live email send** — deliberate: `group-7day-waiver` would mail every group contact
  with an event in 7 days.
* **`/w/{code}` never served over real HTTP.** Route→URL mapping rests on App Router
  convention plus unit-tested middleware, not a running server.
* **A3 attach** — unproven, as above.
* The mint module built and passed **with the shelved roster changes also in the tree**. It
  imports only already-committed modules, so the risk is low, but a preview deploy of the
  committed state is the real check.

---

## 6. Suggested order when you pick this up

1. Deploy preview, click `/w/{code}` on **both** hosts (the HeadPinz 404 was real).
2. Decide the roster dedupe-vs-privacy tradeoff — that unblocks the roster preload.
3. Stage 2 in one pass: senders + contracts + confirmation pages mint codes.
4. A3 attach probe against a throwaway project.
5. The two live PII leaks in §4, which are independent of all of the above.
