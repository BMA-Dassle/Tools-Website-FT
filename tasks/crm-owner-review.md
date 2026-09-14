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
