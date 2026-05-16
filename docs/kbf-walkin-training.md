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

| Situation                                | What You'll See                           | What to Do                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| All kids show "Played today"             | Red badges on every kid, buttons disabled | They've already used their free games. They can still bowl but need to pay full price — book through regular Conqueror.                           |
| "Already has a reservation" warning      | Yellow box with date/time                 | They already have a future booking. Book Lane is disabled but Bowl Now still works.                                                               |
| No accounts found                        | "No accounts found" message               | Double-check spelling. Try email or phone instead. They may not be registered at KidsBowlFree.com.                                                |
| Hold fails                               | Error message appears                     | Usually means no lanes are available (all open/running). Check Conqueror for lane availability.                                                   |
| Lane open fails partway                  | Progress shows which step failed          | The reservation may be partially created. Check Conqueror — if the lane is running, just charge shoes normally. Contact management if it's stuck. |
| Guest wants to change bowlers after hold | Bowler list is locked (greyed out)        | Click **Cancel** on the hold card, make changes, then click Bowl Now again.                                                                       |

---

## Quick Reference

| Item                | Detail                                      |
| ------------------- | ------------------------------------------- |
| **Free games**      | 2 per registered bowler per day             |
| **Days**            | Monday – Friday only                        |
| **Hours**           | 11 AM – close (Mon–Thu), 11 AM – 5 PM (Fri) |
| **Shoes**           | NOT included — always charge separately     |
| **KBF**             | Kids free, adults pay                       |
| **FBF**             | Everyone free (paid upgrade families)       |
| **Phone required**  | Yes — must be on file or entered at desk    |
| **Lane assignment** | Automatic — system picks the best lane      |

---

## Step-by-Step: Book Lane (Future Reservation)

Use this flow when a guest walks in (or calls) and wants to **reserve a lane for a future date** rather than bowling right now.

### 1. Search for the Guest

Same as Bowl Now — type the guest's **name**, **email**, or **phone number** into the search bar and select their account.

### 2. Select Bowlers

Same as Bowl Now — check off the kids (and family members for FBF accounts) who will be bowling. Set shoe sizes and bumpers if the guest knows them — these are saved for next time.

**Phone number is required** just like Bowl Now.

### 3. Click "Book Lane"

The blue **Book Lane** button takes you to the booking calendar (step 2 of the UI).

**Book Lane is disabled if:**

- The family already has an upcoming KBF reservation (yellow warning box shows the existing date/time)
- No kids are selected
- No phone number on file

### 4. Pick a Date

A calendar appears on the left side. Only **KBF-eligible weekdays** (Monday–Friday during the season) are clickable — weekends, past dates, and off-season dates are greyed out.

- **Today's date** has a blue outline
- **Selected date** fills solid blue
- Click a date to load available times on the right

### 5. Pick a Start Time

After selecting a date, available times load on the right side:

1. **Pick an hour** — click a time chip (e.g., "3 PM", "4 PM")
2. **Pick a minute** — click a minute chip (e.g., ":00", ":15", ":30", ":45")

Available times come directly from Conqueror (QAMF). If no times show up for a date, that day is fully booked or the KBF offer isn't configured for those hours.

### 6. Time Slot Held Automatically

As soon as you pick a minute, the system **automatically creates a temporary hold** on that time slot. You'll see:

> **Time slot held — 10 min expiry**

This means:

- The slot is reserved for **10 minutes** while you confirm
- No one else (online or at the desk) can take that slot
- If you don't confirm within 10 minutes, the hold expires and the slot opens back up

**If you change your mind:**

- Click a **different minute** — the old hold is cancelled, a new one is created
- Click a **different hour** — the old hold is cancelled
- Click a **different date** — the old hold is cancelled
- Click **Back** — the hold is cancelled and you return to the bowler selection

### 7. Confirm the Booking

The confirm button at the bottom shows the selected date and time:

> **Confirm: 2026-05-15 at 3:30 PM**

Click it to finalize. The system will:

1. Lock in the QAMF reservation (no longer temporary)
2. Create the internal reservation record with all bowler details
3. Save shoe size and bumper preferences for next time

A progress indicator shows each step completing.

### 8. Done

Once confirmed, the booking is final. The guest shows up on the selected date and checks in through the normal process — the lane is assigned at arrival, not at booking time.

Click **New Lookup** to help the next guest.

---

## Book Lane: What Can Go Wrong

| Situation                              | What You'll See                           | What to Do                                                                                                                     |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No times available for a date          | "No available start times for this date"  | That day may be fully booked, or the KBF offer hours are restricted. Try a different date.                                     |
| Already has a reservation              | Yellow warning, Book Lane button disabled | They can only have one upcoming KBF reservation at a time. They need to use or cancel the existing one first.                  |
| Hold expired before confirming         | Confirm may fail with an error            | Pick the time again — a new hold will be created. If the slot was taken, pick a different time.                                |
| Guest changes their mind on date/time  | Calendar and time chips still active      | Just pick a new date or time. The old hold is automatically cancelled.                                                         |
| Guest wants to cancel after confirming | Booking is finalized                      | Contact management — confirmed bookings need to be cancelled in the reservations admin.                                        |
| Only late-night times showing          | Times like "9 PM", "9:45 PM" only         | This is a Conqueror configuration issue — the KBF offer may be restricted to certain hours at that center. Contact management. |

---

## Key Differences: Bowl Now vs. Book Lane

|                       | Bowl Now                                  | Book Lane                                    |
| --------------------- | ----------------------------------------- | -------------------------------------------- |
| **When**              | Right now — guest is at the desk          | Future date — guest wants to reserve ahead   |
| **Lane assignment**   | Immediate — system picks and opens a lane | At arrival — no lane assigned until check-in |
| **Shoes to KDS**      | Yes — sent immediately                    | No — handled at check-in                     |
| **Charge for shoes**  | Yes — immediately after confirming        | At check-in, not at booking time             |
| **Hold expiry**       | No expiry (PlayNow)                       | 10 minutes (BookForLater)                    |
| **Square order**      | Created (shoe line items for KDS)         | Not created until check-in                   |
| **Lane in Conqueror** | Opens to Running immediately              | Created as future reservation                |
