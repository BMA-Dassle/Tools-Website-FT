# Kids Bowl Free — System Overview

**For:** Management team
**Last updated:** May 13, 2026

---

## What It Is

Kids Bowl Free (KBF) is a national summer program where registered kids get **2 free bowling games per day**, Monday through Friday. We participate at both HeadPinz Fort Myers and HeadPinz Naples.

Parents register at [KidsBowlFree.com](https://kidsbowlfree.com), selecting our centers. Our system automatically imports those registrations and lets parents **book their free lanes online** instead of walking in and hoping for availability.

---

## Program Dates & Hours

|            | Detail                                                  |
| ---------- | ------------------------------------------------------- |
| **Season** | May 14 – August 28, 2026                                |
| **Days**   | Monday through Friday only (no weekends)                |
| **Hours**  | 11:00 AM – close (Mon–Thu), 11:00 AM – 5:00 PM (Friday) |
| **Games**  | 2 free games per registered bowler per day              |

The date picker in the booking flow shows available weekdays across the full season — no artificial booking window.

---

## Two Programs: Kids Bowl Free vs. Families Bowl Free

|                   | Kids Bowl Free (KBF)                                | Families Bowl Free (FBF)                 |
| ----------------- | --------------------------------------------------- | ---------------------------------------- |
| **Who's free**    | Registered kids only                                | Everyone — kids AND adults               |
| **Adult pricing** | $5/game Mon–Thu, $6/game Fri (2 games = $10 or $12) | Free                                     |
| **How to tell**   | `fpass = false` on the pass                         | `fpass = true` on the pass               |
| **Registration**  | Free at KidsBowlFree.com                            | Paid upgrade ($34.95/family on KBF site) |

The booking wizard detects which program the family is on and adjusts automatically:

- **KBF families** see their kids listed as free bowlers. Adults are NOT in the free list — they can be added via an "Add Adult" button that clearly shows the per-game price.
- **FBF families** see everyone (kids + adults + account holder) listed as free bowlers. No charges.

---

## How Registrations Get Into Our System

### Hourly Sync (Cron Job)

A Vercel cron job runs **every 15 minutes** (`/api/cron/kbf-sync`).

**What it does:**

1. Logs into KidsBowlFree.com's center admin portal using our center credentials
2. Downloads the full registration CSV (every family registered at our centers)
3. Parses the CSV — each row has up to 6 kid slots and 4 family adult slots
4. Upserts into our database: `kbf_passes` (one row per family per center) and `kbf_pass_members` (individual kids and adults)
5. Only syncs HeadPinz Fort Myers and HeadPinz Naples (ignores Lehigh Lanes)

**Current numbers** (as of today):

- Fort Myers: ~1,500 registered passes
- Naples: ~843 registered passes
- ~6,959 total individual members

**If it breaks:** The cron has built-in retry logic (1 automatic retry with a 2-second backoff). If the KBF site is down or the password changes, it fails gracefully and tries again next hour. The most common failure is KBF's Cloudflare proxy returning a 5xx — it self-heals on the next run.

---

## The Booking Flow (What Parents See)

### Step by step:

1. **Choose center** — Fort Myers or Naples
2. **Sign in** — Enter email or phone + 6-digit verification code (OTP sent via email or SMS)
3. **Existing reservation check** — If they already have a future KBF reservation, the system shows it with options to:
   - **View My Reservation** — opens the confirmation page
   - **Change Date & Time** — reschedule to a different day/time
   - **Cancel** — cancels and lets them start over
4. **Select bowlers** — Toggle which kids are bowling (at least one kid required). For KBF accounts, adults can be added at the displayed per-game price. For FBF accounts, everyone is free.
5. **Pick a date** — Any weekday within the program season
6. **Pick a time** — Available slots from QAMF (our lane management system). Only shows times within the allowed hours (11 AM+, before 5 PM on Fridays).
7. **Shoe rental** (optional)
8. **Review** — Shows all line items, including adult game charges if applicable
9. **Contact info + payment** — If there are charges (adult games, shoes), the parent pays via credit card. If everything is free, they just confirm.
10. **Confirmation** — Email + SMS confirmation with booking details and a short link

### Behind the scenes:

- A QAMF reservation is created to hold the lane
- If there are charges, a Square order is created with the correct catalog items (Adult Game Mon-Thur or Adult Game Fri-Sun) so everything flows into Square reporting
- The reservation is stored in our Neon database with full player details

---

## Guardrails — One Reservation, One Redemption

### Only one active reservation at a time

When a parent signs in, the system checks for any existing future KBF reservation tied to their email. If one exists, they **cannot create a second one** — they're shown the existing reservation with options to view, reschedule, or cancel it first.

### Per-day redemption limit (2 free games = 1 session per day)

Each registered bowler (kid or FBF adult) gets **one free session per day**. The system enforces this:

- When booking, the system checks if any of the selected free bowlers already have a non-cancelled KBF reservation on that date
- If they do, the booking is **blocked** with a message naming the specific bowlers: _"Ada already used their free games for May 15."_
- **Paid adults are not subject to this limit** — only the free game allotment is capped
- A bowler who already used their free games CAN still be added as a **paid adult** for the same day

### Rescheduling respects the limit

When rescheduling to a new date, the system checks the new date's redemptions but **excludes the reservation being rescheduled** — so moving from Monday to Tuesday doesn't falsely block on Tuesday if the same kids are on both.

---

## Adult Game Pricing (Square Integration)

When KBF adults are added to a booking, the charges use these Square catalog items:

| Product             | Price      | When              |
| ------------------- | ---------- | ----------------- |
| Adult Game Mon-Thur | $5.00/game | Monday – Thursday |
| Adult Game Fri-Sun  | $6.00/game | Friday            |

Each adult plays 2 games per session, so the total per adult is **$10 Mon–Thu** or **$12 on Fridays**.

The server determines pricing from the booking date — it never trusts what the app sends. This prevents any price manipulation.

---

## VIP Lane Upcharge

Parents can choose between **Regular** and **VIP** lanes during the booking flow.

|                | Regular                 | VIP                                                    |
| -------------- | ----------------------- | ------------------------------------------------------ |
| **Lane type**  | Standard HeadPinz lanes | VIP suite with NeoVerse video walls                    |
| **Upcharge**   | None                    | **$1.00 per person per game**                          |
| **Per bowler** | $0                      | $2.00 (2 games × $1)                                   |
| **Applies to** | —                       | **Everyone** — kids, FBF adults, and paid adults alike |

Example: A family of 4 (2 kids + 2 paid adults) on a VIP Wednesday KBF booking:

- Kids: 2 × $2 VIP = **$4**
- Adults: 2 × ($10 adult games + $2 VIP) = **$24**
- **Total: $28** (plus booking fee + tax)

The VIP flag is determined server-side from the QAMF web offer ID — the client never controls whether VIP pricing applies.

---

## Rescheduling & Cancellation

- **Reschedule:** Changes the date/time. The old QAMF lane hold is released and a new one is created. Confirmation email/SMS is resent. Any attraction add-ons are cancelled (they're time-specific and can be re-added after).
- **Cancel:** Releases the QAMF lane hold, marks the reservation as cancelled in our database, and frees the bowlers to book again.
- Payment is not touched during reschedule — Square deposits and day-of orders remain as-is.

---

## Key System Components

| Component                                      | What it does                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/cron/kbf-sync`                           | Hourly import from KidsBowlFree.com → Neon DB                                                  |
| `/api/kbf/lookup` + `/api/kbf/verify`          | OTP sign-in (email or phone)                                                                   |
| `/api/kbf/offers`                              | Fetches available time slots from QAMF, applies schedule rules, returns adult pricing metadata |
| `/api/bowling/v2/reserve`                      | Creates reservation (QAMF + Square + Neon), enforces redemption cap                            |
| `/api/bowling/v2/reservations/[id]/reschedule` | Moves reservation to new date/time                                                             |
| `/api/bowling/v2/my-reservations`              | Checks for existing active reservation                                                         |
| `BowlingWizard.tsx`                            | The booking UI (shared with regular bowling, KBF mode)                                         |
| `kbf-schedule.ts`                              | Schedule rules (dates, times, program season)                                                  |
| `bowling-db.ts`                                | Database queries including redemption check                                                    |

---

## FAQ

**Q: What happens if a family registers on KidsBowlFree.com at 2 PM?**
A: They'll be in our system within 15 minutes (next sync cycle). They can book immediately after that.

**Q: Can a parent book for just adults, no kids?**
A: No. At least one registered kid must be included in every KBF booking.

**Q: What if the KBF site goes down?**
A: Existing registrations are already in our database and unaffected. New registrations just won't appear until the next successful sync. The cron retries automatically every hour.

**Q: Can someone book the same kid twice on the same day?**
A: No. The per-day redemption check blocks it. They'd need to cancel the first reservation or add the kid as a paid adult.

**Q: Do FBF adults count against the daily limit?**
A: Yes — FBF adults get one free session per day just like kids. If they want to play again the same day, they can be added as paid adults.
