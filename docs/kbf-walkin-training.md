# Kids Bowl Free — Walk-In Guest Training Guide

**For:** Front desk staff
**Last updated:** May 13, 2026

---

## Overview

When a KBF family walks in without a reservation, use the **KBF Admin** page to look up their account, select bowlers, and open a lane. The system handles everything — QAMF reservation, lane assignment, and sending shoe orders to KDS.

**You still need to charge for shoes in Conqueror.** KBF only covers bowling — shoes are always paid.

---

## Accessing KBF Admin

Open the admin portal and navigate to the KBF section. The URL follows this pattern:

```
https://headpinz.com/admin/{token}/kbf
```

The page has a single-row header with the search bar and center selector (Fort Myers / Naples).

---

## Step-by-Step: Walk-In Bowl Now

### 1. Search for the Guest

Type the guest's **name**, **email**, or **phone number** into the search bar and press Enter or click Search.

- Full names work (e.g., "Eric Osborn")
- Partial matches work (e.g., "osborn" or "eric")
- Phone numbers and emails also work

If multiple accounts match, you'll see a list — click the correct one.

### 2. Review the Account

Once you select an account, you'll see:

- **Account holder name** and email at the top
- **Center badge** (Fort Myers or Naples) and **KBF or FBF** badge
- The center selector auto-switches to match the account

**If there's no phone number on file**, a yellow box appears. **You must enter their phone number to continue.** This is required — the buttons won't activate without it.

### 3. Select Bowlers

All registered kids appear with checkboxes. Kids are **auto-selected** unless they've already played today.

- **Kid** (green badge) — free under KBF
- **Family** (blue badge) — only appears on FBF (Families Bowl Free) accounts, also free
- **Played today** (red badge) — already used their 2 free games today, checkbox is off

You can:
- **Uncheck** a kid who isn't bowling
- **Check** a family member (FBF accounts only)
- **Set shoe sizes** — click the shoe size button on each row
- **Toggle bumpers** — click the **B** button (blue = on, gray = off)

**At least one kid must be selected** for KBF. The buttons stay disabled until this is true.

### 4. Click "Bowl Now"

Once bowlers are selected and a phone number is on file, the green **Bowl Now** button activates. Click it.

**What happens behind the scenes:**
- The system creates a temporary reservation in QAMF
- QAMF automatically picks the best available lane
- A green card appears showing the **assigned lane number**

**After clicking Bowl Now, the bowler list locks.** You cannot change selections without cancelling.

### 5. Confirm — Open the Lane

You'll see a green box:

> **Lane 22 assigned**
> Temp hold active — confirm to open the lane

You have two options:
- **Cancel** — releases the hold, lets you change bowlers or pick a different time
- **Open Lane [number]** — finalizes everything

Click **Open Lane** to confirm. The system will:

1. Confirm the QAMF reservation
2. Create the internal reservation record
3. Send shoe orders to KDS
4. Set the lane to Running in Conqueror

You'll see a progress indicator as each step completes.

### 6. CHARGE FOR SHOES

A **big red flashing box** appears:

> **CHARGE FOR SHOES**
> Return to Conqueror and ring up shoe rentals now.
> KBF does NOT include shoes — they must be paid for.

**This is the most important step.** Switch to Conqueror and ring up shoe rentals for each bowler. KBF only covers the bowling games — shoes are always a separate charge.

### 7. Done — New Lookup

Click **New Lookup** to reset and help the next guest.

---

## What Can Go Wrong

| Situation | What You'll See | What to Do |
|---|---|---|
| All kids show "Played today" | Red badges on every kid, buttons disabled | They've already used their free games. They can still bowl but need to pay full price — book through regular Conqueror. |
| "Already has a reservation" warning | Yellow box with date/time | They already have a future booking. Book Lane is disabled but Bowl Now still works. |
| No accounts found | "No accounts found" message | Double-check spelling. Try email or phone instead. They may not be registered at KidsBowlFree.com. |
| Hold fails | Error message appears | Usually means no lanes are available (all open/running). Check Conqueror for lane availability. |
| Lane open fails partway | Progress shows which step failed | The reservation may be partially created. Check Conqueror — if the lane is running, just charge shoes normally. Contact management if it's stuck. |
| Guest wants to change bowlers after hold | Bowler list is locked (greyed out) | Click **Cancel** on the hold card, make changes, then click Bowl Now again. |

---

## Quick Reference

| Item | Detail |
|---|---|
| **Free games** | 2 per registered bowler per day |
| **Days** | Monday – Friday only |
| **Hours** | 11 AM – close (Mon–Thu), 11 AM – 5 PM (Fri) |
| **Shoes** | NOT included — always charge separately |
| **KBF** | Kids free, adults pay |
| **FBF** | Everyone free (paid upgrade families) |
| **Phone required** | Yes — must be on file or entered at desk |
| **Lane assignment** | Automatic — system picks the best lane |

---

## Book Lane (Future Reservation)

If the guest wants to **book for a future date** instead of bowling right now:

1. Search and select bowlers (same as above)
2. Click **Book Lane** instead of Bowl Now
3. Pick a date from the calendar (only KBF-eligible weekdays are selectable)
4. Pick a start time (hour, then minute)
5. The system automatically holds the time slot (10-minute expiry)
6. Click **Confirm** to finalize the booking

The guest will receive confirmation and can check in normally when they arrive. No lane is assigned until arrival — the system handles that at check-in time.

**Note:** Book Lane is disabled if the family already has an upcoming reservation.
