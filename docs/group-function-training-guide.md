# Group Function Contract System — Training Guide

**Last updated:** May 28, 2026  
**For:** Event Planners, Guest Services, Management

---

## Overview

The group function system automates the full lifecycle of group events — from quote creation to payment collection to event day. When a planner sets up an event in BMI Office, the system automatically sends a branded contract to the customer, collects payment, and manages the event through completion.

**No manual contract creation is needed.** The system watches BMI Office and handles everything automatically.

---

## How It Works: The Customer Journey

### Step 1: Planner Creates the Event in BMI Office

Set up the event as normal in BMI Office:
- Event name, date, time
- Customer contact (name, email, phone)
- Products and pricing
- Public notes (customer-facing instructions)
- Set the state to **"New Deposit Requested"** (HPFM or FT)

**What happens automatically:**
- The system picks up the event within 1-2 minutes
- Event name is cleaned up (venue prefixes removed, title case applied)
- Notes are lightly edited for grammar and spelling
- Both the cleaned name and notes are written back to BMI Office
- A branded contract is sent to the customer via email and SMS

### Step 2: Customer Reviews and Signs the Contract

The customer receives an email with a link to their contract page. The contract walks them through:

1. **Review** — Event details, pricing, planner notes
2. **Event Info** — Helpful tips about the venue, food timing, waiver requirements
3. **Cancellation Policy** — Must acknowledge before signing
4. **Agree & Sign** — Checkboxes for deposit, balance charge, waivers + signature (typed or drawn)
5. **Pay Deposit** — 50% deposit via credit card (or 100% if event is within 96 hours)

**After payment:**
- A digital gift card is created with the deposit amount (used for day-of redemption)
- The customer's card is saved for the automatic balance charge
- BMI Office is updated: status changes to **"Confirmation + Waiver"** and the deposit is recorded as a payment
- A signed PDF contract is generated and emailed to the customer
- The customer sees a "You're All Set" page with event details, countdown, waiver link, and planner contact

### Step 3: 96-Hour Reminder (4 Days Before Event)

The customer receives an email and SMS:
- "Your event is almost here!"
- "Your balance will be charged tomorrow"
- Verify guest count, event details, card on file
- Link to update their credit card if needed
- Waiver reminder with link (if activities require waivers)

### Step 4: 72-Hour Auto-Charge (3 Days Before Event)

The remaining balance is automatically charged to the customer's saved card:
- Gift card is loaded to 100% of the event total
- Customer receives a payment receipt email with full breakdown
- If the card fails, a payment link is sent instead

### Step 5: Event Day

At event time:
- The gift card(s) are redeemed against the day-of Square order
- The order is completed automatically
- No staff interaction needed for payment

### Step 6: After the Event

The event is marked as completed in the system.

---

## Special Scenarios

### Events Within 96 Hours

If a contract is sent less than 96 hours before the event, **full payment (100%) is collected at signing** instead of the normal 50% deposit. There is no balance charge — the customer pays everything upfront.

### Post-Paid Accounts

Some events use a "GF Post Paid Account" product (set in BMI Office). These require **management approval** before the contract is sent:

1. System detects the post-paid product
2. Approval email sent to eric@headpinz.com and jacob@headpinz.com
3. Manager opens the approval page and reviews event details
4. **Approve** → contract sent to customer (no deposit collected)
5. **Deny** → planner notified with reason, contract NOT sent

Post-paid events do not go through the automatic payment cycle.

### Large Events (Over $4,000 Total)

Square limits gift cards to $2,000 each. For large events, the system automatically creates multiple gift cards:
- $5,000 deposit → 3 gift cards ($2,000 + $2,000 + $1,000)
- Each card has a unique GAN (e.g., GRPF12345678, GRPF12345678B, GRPF12345678C)
- All cards are redeemed automatically on event day

### Contract Updates After Signing

If the planner changes event details in BMI Office after the customer has already signed:
- **Contact info changes** (name, email, phone): Updated automatically, contract re-sent
- **Pricing/product changes**: Customer must re-sign the contract (previous signed PDF is archived)
- The customer receives a "Contract Updated" email with a link to review and re-sign

### Cancellation

When a planner sets the BMI Office state to **"Cancellation"**:
1. The contract is immediately blocked — customer can no longer sign or pay
2. All Square payments are **refunded** to the customer's card (5-10 business days)
3. Customer receives a cancellation email with refund confirmation
4. The contract page shows "Event Cancelled" with planner contact info

---

## What Planners Need to Know

### Setting Up an Event

1. Create the event in BMI Office as normal
2. Make sure these fields are filled in:
   - **Event name** — Client name + event type (e.g., "Johnson Birthday Party")
   - **Date and time**
   - **Customer** — Name, email, phone (email is required for contract delivery)
   - **Products** — All items and pricing
   - **Public notes** — Customer-facing instructions (arrival time, food timing, special requests)
3. Set the state to **"New Deposit Requested"** (for HPFM) or **"New Deposit Requested - FT"** (for FastTrax)
4. The system handles everything from here

### Public Notes Tips

Write notes as you normally would. The system lightly cleans up grammar and spelling before the customer sees them. A few tips:
- **Be specific** — arrival time, food timing, lane assignments, special instructions
- **Don't worry about perfect grammar** — the system fixes spelling errors and formatting
- **Keep it factual** — the system will not add or change any information, only clean up wording
- **Include waiver info** — mention if waivers are required

### Making Changes

- **Before the customer signs:** Update anything in BMI Office. The system detects changes every 5 minutes and re-sends the contract.
- **After the customer signs:** Changes to pricing/products trigger a re-sign requirement. Contact changes update silently.
- **After deposit is paid:** Price changes require re-signing. The deposit and gift card are preserved.

### Cancelling an Event

Set the BMI Office state to **"Cancellation"**. The system will:
- Block the contract page
- Refund all payments to the customer's card
- Send the customer a cancellation email
- No further action needed from the planner

### Monitoring Events

All group events appear on the **admin reservations page** for the event date. You can see:
- Event name, number, status
- Customer and planner info
- Deposit/balance/total amounts
- Gift card GANs
- Card on file status
- Link to view the contract

---

## Email Timeline

| When | Email | To |
|------|-------|----|
| Contract created | "Your Event Contract" — review & sign link | Customer (CC planner) |
| Contract updated | "Contract Updated" — review changes | Customer (CC planner) |
| Deposit paid | "Deposit Received" — confirmation + reference | Customer (CC planner) |
| 96 hours before | "Your Event Is Almost Here" — verify details, update card, waivers | Customer (CC planner) |
| 72 hours before | "Payment Complete — See You Soon!" — receipt with breakdown | Customer (CC planner) |
| Balance link sent | "Balance Due" — payment link (if auto-charge failed) | Customer (CC planner) |
| Cancelled | "Event Cancelled" — refund confirmation | Customer (CC planner) |
| Post-paid approval | "Approval Needed" — review & approve/deny | Management |
| Post-paid denied | "Post-Paid Account Denied" — reason | Planner (CC management) |

All emails are BCC'd to vendorcases@dassle.us and jacob@headpinz.com.

---

## BMI Office States

| State | Meaning |
|-------|---------|
| New Deposit Requested (HPFM/FT) | Triggers contract creation |
| Confirmation | Deposit paid, no waiver activities |
| Confirmation + Waiver | Deposit paid, has waiver activities (laser tag, racing, etc.) |
| Cancellation | Triggers automatic refund + cancellation |

---

## Square Components per Event

| Component | Created When | Purpose |
|-----------|-------------|---------|
| Day-of Order | At deposit payment | Full event total — redeemed by gift card(s) on event day |
| Deposit Order | At deposit payment | 50% deposit charge to customer's card |
| Gift Card(s) | At deposit payment | Internal tracking — loaded to 100% at balance charge, redeemed on event day |
| Saved Card | At deposit payment | Used for automatic 72-hour balance charge |
| Balance Order | At 72hr charge | Remaining balance charged to saved card |

---

## FAQ

**Q: What if the customer's card declines at the 72-hour charge?**  
A: The system sends a payment link via email and SMS. The customer can pay with a different card.

**Q: Can the customer update their card?**  
A: Yes. The "You're All Set" page has an "Update Card on File" section where they can enter a new card.

**Q: What if I need to change the price after the customer paid?**  
A: Update the products in BMI Office. The system detects the change, adjusts the balance, and requires the customer to re-sign. The original deposit and gift card are preserved.

**Q: How do I know if a customer signed and paid?**  
A: Check the admin reservations page for the event date, or look at the BMI Office state — it will be "Confirmation" or "Confirmation + Waiver" after payment.

**Q: What about tax-exempt events?**  
A: Add the "GF Tax Exempt" product in BMI Office. The contract signing process asks the customer to upload their DR-14 letter.

**Q: Can I resend the contract link?**  
A: Re-queue the event in BMI Office (change state back to "New Deposit Requested" and then back). The system will resend the link to the customer.

**Q: What happens on the actual event day?**  
A: Nothing needed from staff regarding payment. The gift card(s) are automatically redeemed against the day-of Square order at event time. Focus on running a great event!
