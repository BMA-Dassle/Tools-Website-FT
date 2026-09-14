# Sales CRM — owner review to-dos

Everything the owner has raised while clicking through the `feat/crm` preview.
Newest at the top of each section. Kept because the owner asked: "Keep to-dos
I'm feeding you alot."

Preview: https://tools-website-ft-git-feat-crm-headpinz.vercel.app/admin/crm

---

## Open — functional

- [ ] **Events needs a date / range filter and quick months.** Owner,
      2026-09-14: "Add date and range filter for events page. Plus ability to
      quickly select certain months." Today it is Day / Week plus
      back-forward-Today, so reaching November means ~10 presses of the arrow.
      Wants: a date picker for the anchor day, an explicit range (Day / Week /
      Month / a custom from-to), and month chips that jump straight there.
      `EVENTS_POLL_MS` is 120s and the read is per-day — a month range must not
      become 30 day-reads; widen the query instead. Keep the URL the state
      (`?date=` already is), so a range stays shareable.

- [ ] **Status filters on the Events page.** Owner, 2026-09-14: "filters based
      on statues on events page?" The header already shows PAID / DEPOSIT /
      UNSIGNED as legend pills and a "BMI state" control, but none of them
      FILTER — they only describe. Make the money pills togglable filters, and
      add our own pipeline status alongside the BMI state, so "show me every
      unsigned event in October" is one click. Same URL-as-state rule as the
      date range above, and it shares that work's query widening.

- [ ] **A SALES POLICIES tab.** Owner, 2026-09-14: "Really would want a place
      for sales policies, just a little tab where it lives. Don't want them to
      say they don't have access to something or didn't know."
      The point is ACCOUNTABILITY, not a document dump — "I didn't know" has to
      stop being available. So it needs more than a page:
      - policies authored by a director in the CRM (markdown), versioned, with
        an effective date — `crm_policies` + `crm_policy_versions`;
      - a rep sees unread/changed ones on My Day until they acknowledge, and
        the acknowledgement is a row (`crm_policy_acks`: rep, version, at), so
        a director can answer "who has read the deposit policy" with a list;
      - searchable, because a policy nobody can find is a policy nobody has;
      - lives beside Collateral in the nav (both are "things reps need to
        reach"), director-only to edit.
      Do NOT build it as a static file — the whole value is the ack trail.

- [ ] **A PRE-SHIFT NOTE FROM THE OWNER on My Day.** Owner, 2026-09-14: "Would
      be cool to have a little note for the day from me, something like a pre
      shift that appears on their 'my day'."
      Shape: one note per day per audience (all / a centre / one rep), written
      by a director, shown at the TOP of My Day for that date and then gone —
      it is a pre-shift, not a noticeboard. Keep it small: `crm_daily_notes`
      (date, centre|null, rep|null, body, author, created_at), a compose box on
      the director's own My Day, and a dismiss that is per-rep so it stops
      nagging once read but still exists for the record. Reuse the Statuses
      screen's editor pattern rather than inventing a second one.

- [ ] **The builder ignores the lines already on the project.** Opening "Build
      in BMI" on project 2950 says "Nothing on this quote yet" while the banner
      above it lists 8 lines the project already carries (G/F 16" Pizza Cheese
      qty 28, Soda Pitchers qty 28, two Nemos Wings lines, and four more by id).
      The owner wants to open an existing event and edit it; today the builder
      treats existing lines as foreign and starts empty. The one-writer rule was
      meant to stop us CLOBBERING Office, not to stop us reading it.
- [ ] **"Strikes for Scholarships" is assigned in Office but shows unassigned
      here.** Owner confirmed the assignment exists in BMI. Related to the
      per-centre Office id work already landed, but this one is Fort Myers, so
      it is a different cause — needs its own look.
- [~] **Status disagrees with the contract on the deal header.** Owner,
      2026-09-14, on Kara Simmons: "this event should be in lead its contract
      sent double check and fix."
      **REPAIRED.** L-129 (#2950) read `assigned` while its contract had been
      signed on 1 July and the deposit paid — the queue card was nagging "no
      touch · 1 h 33 m" about a booked, paid event. Our status and the contract
      are written by different rails (a rep drags the board; the contract moves
      when the guest signs or pays) and nothing reconciled them, so a deal that
      progressed through the guest's own actions kept whatever the rep last set.
      `scripts/crm-reconcile-lead-status.mts` advances a lead when its contract
      is demonstrably further along — FORWARD ONLY (a rep who moved a deal on
      knows something the money does not), and never touching Lost or
      No-response, which are a judgement about a guest rather than a state the
      money can infer. Measured: 4 of 151 leads were behind; all 4 advanced,
      each with a timeline row saying why; a re-run finds nothing.
      **STILL OPEN: it is a script, not a schedule.** Wire it into the crm-jobs
      cron as its own kind so the drift cannot come back — the same shape as
      `guest-intro-backstop`.

- [ ] **The BMI state on the header is still its own question.** L-129 also had
      `bmi_state_id` NULL beside `bmi_state_name` 'Confirmation'. Decide which
      side wins when OUR status, the contract and the BMI state disagree, and
      make the header say so rather than showing all three flatly.

- [ ] **The incremental BMI sync has never run for Fort Myers.** Only Naples has
      delta runs, and nothing schedules it on a preview, so our copy goes stale
      the moment something is booked. This is why H3447 (Edward Leslie, Sullivan
      State Farm) is missing entirely.
- [ ] **229 day-of Square orders never marked settled**, back to 28 May, and
      only 44 quotes in the whole table carry a settled id. Bounded out of the
      attention list so it stops burying real work, but the underlying rail
      needs looking at. Possibly money.

- [~] **The deal shows none of the contract or payment state it already holds,
      and none of the links a planner needs.** Owner, on Juniper Landscaping
      (H2892): "this one has contract payments everyting but not seeing that
      stuff in CRM. History could have been pulled in from notes. We should
      have links to customer confirmation page, waiver page for customer,
      latest contract, contract history, etc."
      **THE JOIN IS FIXED (2026-09-14).** `crm_leads.gf_short_id` is NULL on
      all 189 rows and nothing has ever written it, so every screen that gated
      on it said "no quote yet" over a paid deposit. `LEAD_FROM` now joins
      `group_function_quotes` on the BMI PROJECT id, which both sides already
      carry, and `gf_short_id` is COALESCEd over it. No backfill. Proven
      against live data: 152 of 187 live leads now carry a contract where ZERO
      did before, the join does not fan out (189 rows in, 189 out), and L-225 /
      H2892 resolves to contract e41b6fdf, $4,648.79 total, deposit $2,397.24
      paid, $2,251.55 outstanding. The Contract and Payments tabs were already
      built and were only ever starved of a short id, so they light up as-is.
      **LINKS SHIPPED (2026-09-14)** — a "Links" card in the deal rail:
      contract page (which is also the confirmation page — `ContractClient`
      renders sign, pay and done from the one route), signed PDF, pay-balance
      page (only while there is a balance left), the reservation-scoped guest
      waiver, and contract history. The brand host comes from the QUOTE's own
      `base_url`, falling back to the centre's brand, so a FastTrax event is
      never handed to a guest as a headpinz.com link.
      STILL OPEN on this item:
      - HISTORY FROM THE MEMO: Preferred Contact, Preferred Time, Event Type,
        Special Requests, Interests, the free-text brief, the
        `----- Portal Staff -----` block and the `── FastTrax Web ──` dated
        delivery log (on H2892 that carries a card-declined notice from 13
        Sep). B6's Notes tab already parses these — reuse
        `events/notes/office-notes.ts`, do not write a second parser.
      - Re-run the mirror so stored rows carry `logs`, then project the dated
        entries into `crm_activities`.

- [x] ~~**The BMI memo is never mirrored**~~ — FIXED. It lives in
      `logs[].memo`, one entry per note with its own `created` stamp and a
      `public` flag separating what the guest sees from the staff log.
      `trimRaw` was explicitly dropping `logs` and `projectLogs`, which is the
      single line that emptied the timeline. Now kept, trimmed to the fields a
      history needs. ALSO CORRECTED: I warned the parser's `── FastTrax Web ──`
      markers might not match Office's em dashes — they do match. Office writes
      U+2500 box-drawing dashes, verified byte by byte against project 3492.
      Still to do: re-run the mirror so stored rows carry logs, then project the
      dated entries into `crm_activities`.
- [ ] ~~The BMI memo is never mirrored, so no timeline can be built from it.~~
      Owner, on 3492 Select Specialty Hospital: "missing timeline history etc.
      You should be able to pull it from the notes."
      Verified: `crm_bmi_projects.raw` for 3492 has no `memo` key at all — the
      stored keys are id, date, name, bills, tasks, closed, kindId, number,
      userId, balance, confirm, created, persons, publish, stateId, styleId,
      updated, payments, personId, priority, products, companyId, invoiceId,
      partyInfo, schedules, resellerId, templateId, displayName, userAgentId,
      validityDate. The Notes tab reads the memo LIVE from Office, so the data
      is reachable, but nothing indexes it and the timeline has nothing to show.
      That memo is where the history lives. On 3492 it carries the contract
      link, "[08/18/2026, 1:03 PM] Contract sent to rblanchard@selectmedical.com"
      and "[09/11/2026, 11:00 PM] Final-headcount reminder sent". On H2892 it
      carries a card-declined notice.
      To do: mirror the memo, then feed the dated `— FastTrax Web —` lines into
      `crm_activities` so they appear on the deal's timeline. A parser already
      exists (`events/notes/sections.ts`) — CHECK ITS MARKERS FIRST: it looks
      for `── FastTrax Web ──` in box-drawing dashes while Office appears to
      write `— FastTrax Web —` in em dashes, which would make it match nothing.
      Could not confirm that because no memo is stored to test against.

- [ ] **Share a link to an event with another rep or the director.** Owner:
      "I'd like to be able to share link to event in our CRM with other reps or
      director." Every screen already keeps its state in the URL, so the deal
      drawer is addressable today — what is missing is a visible "copy link"
      and a link that survives being opened by somebody whose default view
      differs (a rep opening a director's link, a different centre filter).

- [ ] **The un-owned card still says "Guest Services" as the planner.** The
      Assignment Pending card's subtitle reads "FastTrax Fort Myers · Guest
      Services" on a lead the banner above it says nobody owns. Guest Services
      is the generic fallback used to build the card, not the owner. It should
      read "Unassigned".

## Open — presentation

- [ ] **The mobile header needs a proper pass** — owner, 2026-09-14: "Mobile
      layout of headers and such need lots of work." Seen on the Deal screen at
      phone width, with the screenshot in hand:
      - The app bar ("← Deal ☀") is a whole row that says nothing the card
        beneath it does not. It should carry the guest's name once the card
        scrolls, and otherwise give its height back.
      - The header card is SEVEN stacked rows — name, meta, type+source,
        status+BMI+number, timer+avatar+centre, money, actions, stepper — which
        is most of a phone screen before any content. The prototype's phone
        header is three.
      - The money row reads "— no quote yet · 5 days out" where the em dash IS
        the value: an empty number given the largest type on the screen.
      - The tab strip overflows ("His…" clipped at the right edge) with no
        affordance that it scrolls.
      Reference `direction-b.html` at 390px rather than nudging values.

- [~] **The board still scrolls sideways from the BOTTOM.** Owner, twice:
      "still had trouble scroll left and right on board I hate scrolling all
      the way to the bottom first. Can we use arrows or is there better way
      with the template?"
      **ARROWS SHIPPED (2026-09-14)** — `BoardArrows`, pinned to the vertical
      CENTRE of the queue and pipeline boards, one column per press, hidden at
      each end and absent entirely when the board does not overflow. A plain
      mouse wheel now pans the board too (it previously did nothing at all over
      a horizontal scroller, which is most of why it felt stuck), and a wheel
      aimed at a column's own vertical scroller is left alone. Hidden on touch,
      where the board is swiped.
      **STILL OPEN: WHY the bar is at the bottom.** The cascade reads correctly
      — `.board-wrap` is `height:100%` flex-column, `.board-scroll` is `flex:1;
      min-height:0; overflow:hidden`, `.board` is `overflow-x:auto;
      overflow-y:hidden; height:100%` — so the bar should already sit at the
      foot of a viewport-height board. It was NOT diagnosed, because it could
      not be reproduced here. The arrows are deliberately additive and touch
      none of that CSS. **Do not edit the overflow cascade until somebody has
      reproduced the symptom in a browser** — the last attempt shipped on
      theory from a rig that never reproduced it and made things worse
      ("Scroll is f'ed up", "looks like shit").

- [ ] **Install it as a PWA, and say so.** Owner: "We need to be able to add
      this as a PWA app and strongly recommend it. Design a logo for it too."
      Needs: a manifest scoped to `/admin/crm`, maskable icons at every size,
      an iOS `apple-touch-icon` (iOS ignores the manifest icons), a service
      worker that is a shell cache only — never a data cache, because a stale
      lead board is worse than a slow one — and an install prompt that is
      insistent rather than polite: reps live on their phones and the browser
      chrome costs a third of the screen. **And a logo** — not the HeadPinz
      mark, something that reads at 48px on a home screen beside it.

- [ ] **Collapse consecutive lanes into ranges** ("Lanes 1-24") on the Event
      tab's Schedule table, instead of one row per lane. Owner: "Take a look at
      how we do this stuff in reservation admin."
- [ ] **Icons look off** on the deal header (the row of small glyphs beside
      guest / time / guests / centre).
- [ ] **The deal drawer layout** — owner: "Hate this layout". Needs a proper
      pass against the Direction B prototype rather than piecemeal fixes.
- [ ] **The deal HEADER needs a design pass** — owner: "mAKE THIS LOOK BETTER".
      Observed on Juniper Landscaping / H2892. Specifics to fix, not just
      "tidy it":
      - A stray calendar glyph followed by an EMPTY pill sits after the centre
        name. It renders as a grey stub with no content. Either it has data and
        is not showing it, or it should not be drawn.
      - Seven separate chips and labels compete on two lines: status, BMI state,
        project number, no-touch timer, rep avatar, centre. No hierarchy — the
        eye has nowhere to land first.
      - The money is the largest thing on the header but is greyed almost to
        the background, so the one number a planner wants reads as disabled.
      - The meta row's icons are inconsistent in weight and size against the
        action row's, which is what the owner meant by "Icons look off".
      - The stage bar's labels (Assigned / Contacted / Quote / Contract /
        Booked) are cramped under full-width segments and wrap badly at narrow
        widths.
      Reference: `direction-b.html` deal header. Match its hierarchy rather
      than inventing one.

## Open — decisions the owner owes

- [ ] **Lost / No response → BMI Cancellation?** Deliberately left unmapped. BMI
      Cancellation drains the funding gift card, refunds Square and emails the
      guest, so a rep marking a dead deal "Lost" would fire a refund.
- [ ] **Goals seeding.** Last year's actuals as-is, last year plus a growth
      percentage, or typed in by hand. Two facts that make a straight copy
      wrong: Kelsea has almost no 2025 history (2 events last year, 251 this
      year), and December is genuinely 2.5x a normal month rather than a data
      artefact — Oct 116 events, Nov 124, Dec 300, Jan 128.
- [ ] **A test BMI project per centre**, so the builder's writes can be proven
      against something nobody will bill.
- [ ] **Deploy the sign-in gateway** so every preview address can sign in and
      roles refresh at sign-in. Built and tested, not pushed, because it
      deploys auth.headpinz.com.
- [ ] **Paste 7 values into Vercel** (4 Graph, 3 7shifts).

## Known and NOT being fixed now (owner's call)

- **A lead can only carry ONE BMI project.** One column, one project. A guest
  asking for two dates, or bowling against karting, is a planner building two
  projects for one enquiry — today that becomes two unlinked leads and the
  pipeline double-counts. Owner: "if not don't do it now."


---

## ARCHITECTURE DECISION (owner, 2026-09-13 night)

**The BMI project is the SPINE. The lead and the contract are OVERLAYS on it.**
Screens read the project and left-join the rest.

Owner: "I'm really concerned about the direction we took... our CRM is based on
leads which might have a BMI" — then, decisively, "Build it. Don't write rows to
block gaps we need to do this right before we start using it."

### Why, measured on production

| source | rows |
|---|---|
| BMI group events mirrored | 5,106 |
| contracts (`group_function_quotes`) | 559 |
| leads (`crm_leads`) | 185 |

- **4,615** BMI group events have no contract, so a contract-first screen can
  never show them.
- **Every one of the 185 leads has a BMI project id, and every one of those
  projects is mirrored. Zero exceptions.** The owner confirms historically a
  lead ALWAYS created a BMI event regardless.
- So the project is a true SUPERSET. Keying reads on it loses nothing and gains
  4,615.

### Why it matters

Every gap found tonight has this one cause: contracts missing from the pipeline,
events that would not open, a lead that arrived at 7:49 pm and was invisible.
Three symptoms, one shape. Daily Events already reads BMI-first and merges our
data on, and has never had this class of bug — there is a comment in its service
about an event where staff rang a real till check and nothing on our side
noticed, because the event had no quote row. Same failure, found July 2026.

### What does NOT change

Capture stays lead-first. A web enquiry becomes a `crm_leads` row FIRST and
mints its BMI project second, because our database must own guest data before an
external call can fail (hard rule, born from losing Pizza Bowl toppings).

### Standing rule from this decision

**Do not write rows to make a screen look populated.** If a project has no lead,
the screen shows it with no lead. The 179 rows adopted earlier tonight were
exactly that kind of patch; they carry real assignment data so they are not
being deleted yet, but the new read must not depend on them.

---

## Done 2026-09-14

- [x] **Lost and No response now map to BMI Cancellation** (owner decision,
      2026-09-14: "Map these to cancellation"). SAFE BY CONSTRUCTION: `-4` is a
      built-in Office state, and `bmiStateBranch` already refuses to write
      built-in states from a status change — it records "set from the Contract
      tab" instead. So the mapping is what the screens and reporting read, and
      the actual cancel still has to go through the deliberate, audited Cancel
      action. That matters here: a `-4` reaching Office makes
      `group-quote-sync` drain the gift cards, REFUND every Square payment and
      email the guest, so a rep dragging a deposit-paid deal to Lost must never
      be able to trigger a refund by accident.

- [x] **Juniper Landscaping (e41b6fdf) dropped without a refund** — owner:
      "Don't refund this event but this contract needs to go away. Just drop
      it." The quote was already `cancelled` here, and the sync cron's refund
      branch is `stateId === '-4' AND quote.status !== 'cancelled'` — so it was
      already unreachable for this row, proven before touching anything. What
      was left was the pending `contract-cancel-verify:e41b6fdf` job keeping
      the "Cancel pending" banner up; it is parked with the reason on the row.
      The $2,397.24 deposit and the two internal gift cards are untouched.

- [x] **The pending card said "Guest Services" on a lead nobody owns.** It read
      "FastTrax Fort Myers · Guest Services" directly under a banner saying the
      lead has nobody on it, because Guest Services is the placeholder every
      card needs to render its subtitle. That card now says "Unassigned"; only
      the copy changes, so nothing downstream is misaddressed.

- [x] **Every planner covers every centre** — owner: "they all do all". Kelsea
      was `["HPFM","FT"]`, Lori `["HPFM"]`, Stephanie `["HPN"]`, so the
      FastTrax form offered exactly one name and "first available" for 500
      people could only ever be Kelsea. Fixed in `crm_reps` AND in `REP_SEED`.
- [x] **The success screen lied about the planner.** L-228 was correctly held
      for the Marketing Director and the screen and the guest's text both said
      "Kelsea", because the planner was read off Pandora's `assignedAgent` —
      a round robin we do not control. Now resolved from OUR assignment; the
      two engines disagreeing is logged until Pandora stops minting.
- [x] **The guest's welcome is HELD until a planner owns the lead** — owner:
      "Do we just hold the emails, texts and who owns it till it gets
      assigned?" One message, from the person who will run the event.
      `assignLead` sends it on hand-off, `guest_intro_at` makes it once-only,
      and an hourly backstop sends the un-named Guest Services version after
      two hours so holding never becomes silence.
- [x] **The Assignment Pending chat id is a default, not a deploy step.** The
      first held lead reached nobody because the env var was never pasted into
      Vercel. The card now also @-mentions Jacob and Eric.
- [x] **The card links into the CRM** — owner: "This needs link that opens CRM
      to this lead for assignment." "Assign in CRM" on the pending card,
      "Open in CRM" on a planner's. An un-minted card keeps the link and loses
      only its Execute verbs.
- [x] **A hand-off now tells the person it hands to** — owner: "I assigned but
      teams didn't fire to kelsea's channel. I did get test email." At capture
      only an already-owned lead got a planner card, and nothing posted one
      when a held lead was later assigned. Fires on reassign too.
- [x] **The boards update live** — owner: "Lead board and other pages should
      update live." `refetchOnWindowFocus` is false app-wide (right for
      booking, wrong for a board somebody is watching), so the CRM opts in per
      query through one `live()` helper: queue and pipeline 15s, contracts
      (which had NO polling) and the open deal 30s, none of them in a
      background tab.

## Done tonight

- [x] Clicking an event opens the event. Was returning 400 twice over: an event
      type outside the allowed list, and an empty phone against a min-7 rule
      that had no business applying to a booking BMI already owns.
- [x] The whole card opens the deal, with a hover cue. Stretched overlay, so the
      inner buttons still work and no button nests inside another.
- [x] Drag replaced with dnd-kit (the library the portal already uses), on the
      board and the lead queue. Empty columns collapse to a rail and stay drop
      targets.
- [x] Phone layout: header space, the mock-up's tab bar, and a More screen so
      every entry is reachable.
- [x] The page no longer scrolls sideways; the sidebar stops being cut off.
- [x] The deal's right rail drops below instead of being crushed to one letter
      per line.
- [x] Pipeline: horizontal scrollbar stays in reach; person filter added.
- [x] Contracts date windows all work. Five of six were 500ing on a parameter
      Postgres could not type.
- [x] "Needs attention" 312 → real work only.
- [x] My Day tiles are clickable.
- [x] A contract out for signature is no longer in the assignment queue.
- [x] 85 live BMI deals adopted as leads; 8 ownerless ones repaired once the
      per-centre Office ids were taught (Guest Services is 30080112 at Fort
      Myers and 6400642 at Naples).
- [x] Status → BMI state mapping written for both centres, 16 rows.
- [x] BMI mirror backfilled 2023 → 2027: 5,102 group events, 4,062 accounts,
      3,935 contacts. 3 windows failed and need a re-run.
- [x] Same-time-last-year reach-outs moved to Accountability.
