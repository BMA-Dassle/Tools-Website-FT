# Sales CRM — owner review to-dos

Everything the owner has raised while clicking through the `feat/crm` preview.
Newest at the top of each section. Kept because the owner asked: "Keep to-dos
I'm feeding you alot."

Preview: https://tools-website-ft-git-feat-crm-headpinz.vercel.app/admin/crm

---

## Open — functional

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
- [ ] **Status disagrees with BMI on the deal header.** Kara Simmons / 2950
      shows our status "New" beside "BMI · Confirmation" and "no quote yet".
      Decide which wins and make the header say so rather than showing both
      flatly.
- [ ] **The incremental BMI sync has never run for Fort Myers.** Only Naples has
      delta runs, and nothing schedules it on a preview, so our copy goes stale
      the moment something is booked. This is why H3447 (Edward Leslie, Sullivan
      State Farm) is missing entirely.
- [ ] **229 day-of Square orders never marked settled**, back to 28 May, and
      only 44 quotes in the whole table carry a settled id. Bounded out of the
      attention list so it stops burying real work, but the underlying rail
      needs looking at. Possibly money.

## Open — presentation

- [ ] **Collapse consecutive lanes into ranges** ("Lanes 1-24") on the Event
      tab's Schedule table, instead of one row per lane. Owner: "Take a look at
      how we do this stuff in reservation admin."
- [ ] **Icons look off** on the deal header (the row of small glyphs beside
      guest / time / guests / centre).
- [ ] **The deal drawer layout** — owner: "Hate this layout". Needs a proper
      pass against the Direction B prototype rather than piecemeal fixes.

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
