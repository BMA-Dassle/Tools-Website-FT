/**
 * Competitor data used by /alternatives/[slug] landing pages.
 *
 * These pages target high-intent "alternative to X" queries (e.g.
 * "dave and busters alternative fort myers", "topgolf fort myers
 * alternative"). Users searching these are already looking for
 * something like us but haven't committed — perfect conversion window.
 *
 * Each entry drives a full landing page:
 *   <h1>: "{their.name} Alternative in Fort Myers"
 *   JSON-LD: FAQPage + BreadcrumbList
 *   Metadata: canonical + OG tailored to the "vs" query
 */

export type AlternativeBrand = "ft" | "hp";

export interface AlternativeData {
  /** URL slug — `/alternatives/{slug}` on FT, `/hp/alternatives/{slug}` on HP. */
  slug: string;
  /** Which brand's alternatives page this goes under. */
  brand: AlternativeBrand;
  /** Competitor's display name. */
  competitor: string;
  /** Short tagline shown under the hero headline. */
  tagline: string;
  /** Targeted search query for metadata + OG. */
  searchTerm: string;
  /** Opening paragraph — frames the comparison. */
  intro: string;
  /** Side-by-side comparison points. */
  comparison: Array<{
    feature: string;
    /** Us column — what we offer. */
    us: string;
    /** Them column — what the competitor offers. */
    them: string;
    /** Whether "us" wins (for subtle visual emphasis). */
    usWins?: boolean;
  }>;
  /** 3-6 reasons bullet list. */
  reasons: Array<{ title: string; body: string }>;
  /** FAQ entries → FAQPage schema + rendered accordion. */
  faqs: Array<{ q: string; a: string }>;
  /** Primary CTA label ("Book a heat", "Book a lane", etc.). */
  ctaLabel: string;
  /** Primary CTA href. */
  ctaHref: string;
  /** Secondary CTA (optional). */
  secondaryCta?: { label: string; href: string };
}

// ── FastTrax competitors ────────────────────────────────────────────────────

const ftAlternatives: AlternativeData[] = [
  {
    slug: "topgolf",
    brand: "ft",
    competitor: "Topgolf",
    tagline: "Looking for a different group-outing vibe? Here's what we offer.",
    searchTerm: "Topgolf alternative Fort Myers",
    intro:
      "Topgolf does golf-based group entertainment really well. If you're looking for something different — indoor, multi-activity, no golf experience required — FastTrax is another option in Southwest Florida. Our main attraction is high-performance electric go-kart racing, and we pair it with duckpin bowling, shuffleboard, 50+ arcade games, and Nemo's Trackside for full-service dining — all climate-controlled under one 63,000 sq ft roof.",
    comparison: [
      { feature: "Main attraction", us: "Multi-level indoor electric kart racing (Blue + Red + Mega tracks)", them: "Driving-range golf bays with ball-tracking tech", usWins: true },
      { feature: "Venue", us: "100% indoor, climate-controlled year-round", them: "Open-air climate-controlled bays" },
      { feature: "Learning curve", us: "5-min briefing and you're racing", them: "Golf swing basics help" },
      { feature: "Group size", us: "2–300+ (full buyouts available)", them: "Bays seat ~6" },
      { feature: "Variety on-site", us: "Karts + duckpin bowling + shuffleboard + 50+ arcade games", them: "Golf-focused with dining" },
      { feature: "Dining", us: "Nemo's Trackside — wood-fired pizza, craft cocktails, full bar", them: "Full-service kitchen + bar" },
      { feature: "Youngest age", us: "Age 3 (Mini karts)", them: "All ages welcome, best for kids who can swing a club" },
    ],
    reasons: [
      { title: "Zero learning curve", body: "Everyone in your group races the first time they sit in a kart. No prior experience needed — a 5-minute briefing and you're on track." },
      { title: "Indoor and climate-controlled", body: "We're fully enclosed and air-conditioned year-round. Useful for Florida summer afternoons or rainy days when you still want to get out." },
      { title: "Multi-activity in one trip", body: "Karts + bowling + arcade + shuffleboard + dining. Groups who want to do more than one thing often pick us for the variety." },
      { title: "Mini karts for little kids", body: "Our Mini class (ages 3-6) means 4-year-olds can race. Junior (7-13) and Adult (13+) rounds out the full family." },
      { title: "Trackside dining at Nemo's", body: "Wood-fired pizza, craft cocktails, and a full bar. You can eat and watch heats run from the same table." },
    ],
    faqs: [
      { q: "How does FastTrax pricing compare to Topgolf?", a: "Our Adult race heat is $20.99, Junior is $15.99, Mini is $9.99 per heat. Topgolf is bay-time based rather than per-heat, so best to compare based on group size and what you're booking. Our group packages bundle multi-activity discounts for corporate/birthday events." },
      { q: "Can we book a group event at FastTrax like a Topgolf event?", a: "Yes — we do corporate events, team building, birthdays, bachelor/bachelorette parties, and full buyouts. Event guide with packages and floor plans is on the group events page." },
      { q: "Does FastTrax have food and drinks?", a: "Yes. Nemo's Trackside is a full-service restaurant inside FastTrax with a wood-fired pizza oven, sandwiches, salads, shareables, craft cocktails, and a full bar. You can eat trackside and watch heats run." },
      { q: "Is there an age minimum?", a: "No minimum — Mini karts for ages 3-6, Junior karts for 7-13, Adult karts for 13+. Everyone in your group can race." },
      { q: "Do I need to reserve ahead?", a: "For Friday/Saturday evenings and weekends, yes — book online. Weekdays and afternoons are usually walk-in friendly." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "See packages & pricing", href: "/pricing" },
  },
  {
    slug: "dave-and-busters",
    brand: "ft",
    competitor: "Dave & Buster's",
    tagline: "Arcades + food, with indoor electric kart racing on top",
    searchTerm: "Dave and Busters alternative Fort Myers",
    intro:
      "Dave & Buster's has built a great arcade-and-dining experience. If you're in Southwest Florida and want a similar eat-drink-play atmosphere but with indoor electric go-kart racing added in, FastTrax is another option to consider. We're locally owned and run 50+ arcade games, duckpin bowling, shuffleboard, and Nemo's Trackside alongside our main attraction — Florida's largest indoor electric kart track.",
    comparison: [
      { feature: "Arcade", us: "50+ games, ticket redemption", them: "100+ games, ticket redemption" },
      { feature: "Go-kart racing", us: "Multi-level electric karts, 3 tracks, 40+ mph", them: "Not offered", usWins: true },
      { feature: "Bowling", us: "Duckpin lanes", them: "Not offered", usWins: true },
      { feature: "Shuffleboard", us: "Yes", them: "Not offered", usWins: true },
      { feature: "Food", us: "Nemo's — wood-fired pizza, craft cocktails, full menu", them: "Full-service bar menu" },
      { feature: "Ownership", us: "Locally owned (SWFL family-run)", them: "National chain" },
      { feature: "Layout", us: "Separate activity zones (track, lanes, arcade, dining)", them: "Open floor arcade + dining" },
    ],
    reasons: [
      { title: "Indoor electric karting is our specialty", body: "The Blue + Red + Mega tracks at FastTrax are one of the few indoor electric kart experiences of this size in Southwest Florida." },
      { title: "Locally owned in SWFL", body: "Family-run in Fort Myers. The same team you meet on your first visit is here on your tenth." },
      { title: "Multi-activity event packages", body: "Our corporate and birthday packages bundle race heats, arcade credits, food, and private space in one booking — useful when you want the group doing more than one thing." },
      { title: "Family-friendly all day", body: "Mini karts start at age 3, Junior from 7, Adult from 13. Arcade is all-ages. Full bar for the adults in the group." },
      { title: "Real activities beside the arcade", body: "Karts and bowling give groups something memorable outside of ticket-redemption arcade play — nice if you want variety in one trip." },
    ],
    faqs: [
      { q: "Is FastTrax similar to Dave & Buster's?", a: "There's overlap — arcades, food, drinks, group events — and FastTrax adds indoor electric go-kart racing, duckpin bowling, and shuffleboard as core attractions. D&B's arcade is larger; our variety across attraction types is broader." },
      { q: "Can kids play at FastTrax?", a: "Yes. Mini karts for ages 3-6, Junior for 7-13, Adult for 13+. Arcade is all-ages." },
      { q: "Does FastTrax have a bar?", a: "Yes — Nemo's Trackside is a full-service restaurant and bar with craft cocktails, draft beer, and wine. Trackside seating lets you eat while heats run." },
      { q: "How does pricing work?", a: "Arcade is pay-per-play or card-based. Karting is per-heat pricing ($20.99 adult, $15.99 Junior, $9.99 Mini). No ticket-redemption math required for the main activities." },
      { q: "Are there corporate event packages?", a: "Yes. Team-building packages include race heats, arcade credits, food/drink, and private space. See the event guide on the group-events page." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "See the arcade + attractions", href: "/attractions" },
  },
  {
    slug: "810-bowling",
    brand: "ft",
    competitor: "810 Billiards & Bowling",
    tagline: "If you want more than bowling in one trip",
    searchTerm: "810 bowling alternative Fort Myers",
    intro:
      "810 Billiards & Bowling is a solid Fort Myers spot for bowling, pool, and a bar menu. If you're looking for a multi-activity venue that adds indoor electric go-kart racing, 50+ arcade games, shuffleboard, and trackside dining to the same \"let's hang out and play\" idea, FastTrax is another option a short drive away. Bonus: HeadPinz (traditional 10-pin, laser tag, gel blasters) shares our parking lot, so one trip can cover both bowling styles.",
    comparison: [
      { feature: "Bowling format", us: "Duckpin (smaller balls, shorter lanes)", them: "Traditional 10-pin" },
      { feature: "Electric kart racing", us: "Multi-level indoor tracks, 40+ mph", them: "Not offered", usWins: true },
      { feature: "Billiards / pool", us: "Not offered", them: "Yes", usWins: false },
      { feature: "Arcade", us: "50+ games", them: "Smaller footprint" },
      { feature: "Shuffleboard", us: "Yes", them: "Yes" },
      { feature: "Dining", us: "Nemo's Trackside — wood-fired pizza, craft cocktails", them: "Full-service bar menu" },
      { feature: "Sister location", us: "HeadPinz (10-pin + laser tag) same complex", them: "Single location" },
    ],
    reasons: [
      { title: "Duckpin is beginner-friendly", body: "Smaller balls and shorter lanes mean first-timers and kids get more strikes and have more fun. Great if your group isn't all experienced bowlers." },
      { title: "Electric karting for variety", body: "Our main attraction is Florida's largest indoor electric kart track. Adds a whole extra activity on top of bowling and arcade." },
      { title: "Nemo's Trackside dining", body: "Wood-fired pizza, craft cocktails, and a rotating craft beer list. Sit-down service with a view of the track." },
      { title: "Corporate and birthday packages", body: "Bundle race heats, private space, food, and drinks into one fixed per-person price." },
      { title: "Two venues, same complex", body: "FastTrax and HeadPinz share the Global Parkway complex. Families can do karts at FastTrax and 10-pin bowling + laser tag at HeadPinz in one trip." },
    ],
    faqs: [
      { q: "Does FastTrax have 10-pin bowling?", a: "Duckpin only at FastTrax. HeadPinz (same complex) has traditional 10-pin lanes if that's what you want. One trip can cover both styles of bowling." },
      { q: "Does FastTrax have billiards / pool tables?", a: "No, we don't have billiards. If pool is the main thing you want, 810 is a better fit. FastTrax's variety is across karts, bowling, shuffleboard, and arcade instead." },
      { q: "How does FastTrax pricing compare?", a: "Duckpin lanes are lane-time based. Karting is per-heat ($20.99 adult, $15.99 Junior, $9.99 Mini). Group packages bundle for fixed per-person rates." },
      { q: "Can we do a mixed birthday party (bowling + karts)?", a: "Yes — it's one of our most-booked combos. Group packages bundle duckpin + karts + food across HeadPinz and FastTrax together." },
      { q: "Do you offer bowling leagues?", a: "HeadPinz (sister center) runs traditional 10-pin bowling leagues. FastTrax runs racing leagues and league nights for competitive racers." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "Book duckpin bowling", href: "/book/duck-pin" },
  },
  {
    slug: "gator-mikes",
    brand: "ft",
    competitor: "Gator Mike's",
    tagline: "For when you want indoor, multi-activity, and rain-proof",
    searchTerm: "Gator Mikes alternative Fort Myers",
    intro:
      "Gator Mike's in Cape Coral is a classic outdoor family fun park — gas-kart racing, mini golf, bumper boats, batting cages. If you're looking for an indoor alternative that runs rain-or-shine, FastTrax is another Southwest Florida option. Our electric kart track is multi-level and climate-controlled, and we pair it with duckpin bowling, arcade, shuffleboard, and Nemo's Trackside for a fully indoor day.",
    comparison: [
      { feature: "Setting", us: "Indoor, climate-controlled", them: "Outdoor park setting" },
      { feature: "Kart type", us: "High-performance electric karts (multi-level)", them: "Gas karts on flat outdoor track" },
      { feature: "Weather dependency", us: "Open rain or shine", them: "Outdoor attractions affected by weather" },
      { feature: "Kart speed", us: "Adult class 40+ mph", them: "Gas karts, speed varies by class" },
      { feature: "Mini golf", us: "Not offered", them: "Yes", usWins: false },
      { feature: "Bumper boats", us: "Not offered", them: "Yes", usWins: false },
      { feature: "Indoor dining", us: "Nemo's Trackside restaurant", them: "Park snack bar" },
      { feature: "Other activities on-site", us: "Duckpin bowling, shuffleboard, 50+ arcade games", them: "Mini golf, batting cages, playground" },
    ],
    reasons: [
      { title: "Indoor works year-round in SWFL", body: "We're 72°F, fully enclosed, open rain or shine. Nice complement to outdoor parks like Gator Mike's for days the weather isn't cooperating." },
      { title: "Electric karts", body: "No fumes, low noise, consistent power delivery. Different experience from outdoor gas karting — some people prefer one, some the other." },
      { title: "Indoor dining + cocktails", body: "Nemo's Trackside is a full-service restaurant with a wood-fired pizza oven and a full bar. Groups can eat and socialize between activities." },
      { title: "Mini karts for toddlers", body: "Ages 3-6 race in Mini karts inside the climate-controlled facility — parents like that for very young kids." },
      { title: "School and field-trip packages", body: "Group rates for 20+ students bundle karts, arcade credits, and food. Indoor setting works for any forecast." },
    ],
    faqs: [
      { q: "Does FastTrax have mini golf like Gator Mike's?", a: "No mini golf at FastTrax. If mini golf is a must-have, Gator Mike's or PopStroke are the picks. Our variety is duckpin bowling + shuffleboard + arcade + racing inside." },
      { q: "Does FastTrax have bumper boats or batting cages?", a: "Neither — our specialty is indoor electric kart racing + bowling + arcade. Outdoor family parks like Gator Mike's cover those other attractions." },
      { q: "Is FastTrax kid-friendly?", a: "Yes — Mini karts for ages 3-6 (the smallest kids welcome), Junior for 7-13, Adult for 13+. Indoor setting is a bonus for young kids and hot afternoons." },
      { q: "How does kart speed compare?", a: "Our Adult class tops out at 40+ mph on the Adult track. Outdoor gas karts at family parks are typically restricted for safety and insurance — different experience." },
      { q: "Do you offer school groups and field trips?", a: "Yes — group rates for 20+ students including karts, arcade credits, and food. Contact the events team for a quote." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "Group events & school trips", href: "/group-events" },
  },
  {
    slug: "gametime",
    brand: "ft",
    competitor: "GameTime",
    tagline: "Locally owned, with indoor electric kart racing added",
    searchTerm: "GameTime alternative Fort Myers",
    intro:
      "GameTime is a well-run Florida chain with arcade, 10-pin bowling, laser tag, and bowling leagues. If you're in Southwest Florida and want a locally-owned alternative that adds indoor electric kart racing to the mix, FastTrax is worth a look. Our main attraction is Florida's largest indoor electric kart track, paired with duckpin bowling, shuffleboard, 50+ arcade games, and Nemo's Trackside for dining.",
    comparison: [
      { feature: "Arcade", us: "50+ games", them: "100+ games (location-dependent)" },
      { feature: "Electric kart racing", us: "Multi-level tracks, 40+ mph", them: "Not offered", usWins: true },
      { feature: "Bowling", us: "Duckpin", them: "Traditional 10-pin" },
      { feature: "Laser tag", us: "Available at HeadPinz (same complex)", them: "Yes" },
      { feature: "Shuffleboard", us: "Yes", them: "Location-dependent" },
      { feature: "Food", us: "Nemo's Trackside — wood-fired pizza, craft cocktails", them: "Full-service bar menu" },
      { feature: "Ownership", us: "Locally owned (SWFL family-run)", them: "Florida chain (multi-location)", usWins: true },
    ],
    reasons: [
      { title: "Indoor electric karting is our specialty", body: "One of the few indoor electric kart experiences of this size in SWFL. Adds an attraction that most family entertainment centers don't have." },
      { title: "Locally owned", body: "Family-run in Fort Myers. Same team every visit, direct line to the owners for event planning questions." },
      { title: "Nemo's Trackside dining", body: "Wood-fired pizza, craft cocktails, full bar. Sit-down service you can enjoy between heats." },
      { title: "Duckpin as a bowling option", body: "Smaller balls, shorter lanes — beginner-friendly. Different format from traditional 10-pin; some groups prefer it." },
      { title: "Corporate event packages", body: "Race heats + private space + food/drink in bundled per-person pricing. Works for team-building, birthdays, buyouts." },
    ],
    faqs: [
      { q: "Is FastTrax similar to GameTime?", a: "Overlap in arcade + dining + group events. FastTrax adds indoor electric kart racing, which GameTime doesn't offer. We're single-location and locally owned; GameTime has multiple Florida locations." },
      { q: "Do you have laser tag like GameTime?", a: "HeadPinz (sister center in the same Global Parkway complex) has NEXUS laser tag. Families often combine FastTrax karting + HeadPinz laser tag in one trip." },
      { q: "Is there a FastTrax anywhere else?", a: "FastTrax is exclusively in Fort Myers. One location. GameTime has multiple Florida locations if you're traveling." },
      { q: "Do you have cocktails and a full bar?", a: "Yes — Nemo's Trackside has craft cocktails, wine, beer, and a full menu." },
      { q: "Can I do a corporate event at FastTrax?", a: "Yes — team-building packages bundle race heats, private space, food/drink. Contact the events team for a custom quote." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "Plan a corporate event", href: "/group-events" },
  },
  {
    slug: "pop-stroke",
    brand: "ft",
    competitor: "PopStroke",
    tagline: "When you want indoor, multi-activity, year-round",
    searchTerm: "PopStroke alternative Fort Myers",
    intro:
      "PopStroke (Tiger Woods' putting course brand) has built a great experience for a casual round of mini golf with drinks and food. If you're looking for an indoor alternative with racing, bowling, and arcade under one roof, FastTrax is another Southwest Florida option. Our main attraction is indoor electric kart racing, paired with duckpin bowling, shuffleboard, 50+ arcade games, and Nemo's Trackside.",
    comparison: [
      { feature: "Main activity", us: "Multi-level indoor electric kart racing", them: "Outdoor putting course (Tiger Woods-designed)" },
      { feature: "Setting", us: "Indoor, climate-controlled", them: "Outdoor course" },
      { feature: "Mini golf", us: "Not offered", them: "Yes, their specialty", usWins: false },
      { feature: "Typical session length", us: "Race heats ~8-12 min, do as many as you like", them: "18-hole round, 60-90 min" },
      { feature: "Group scale", us: "2-300+ (full buyouts, corporate)", them: "Typically 2-8 per tee time" },
      { feature: "Kids welcome", us: "Mini karts ages 3-6, Junior 7-13", them: "All ages" },
      { feature: "Food", us: "Nemo's Trackside restaurant + full bar", them: "On-course food + drink service" },
    ],
    reasons: [
      { title: "Indoor, rain or shine", body: "Fully enclosed and climate-controlled. Nice complement to outdoor venues on days the SWFL weather isn't cooperating." },
      { title: "Pay-as-you-go pricing", body: "Adult heat is $20.99, Junior $15.99, Mini $9.99. Mix in arcade and duckpin at their own rates. Good fit for families who want to try several things." },
      { title: "Shorter per-activity commitment", body: "Race heats are 8-12 minutes, so you can fit karts + bowling + arcade + dinner into one trip." },
      { title: "Mini karts for the youngest kids", body: "Ages 3-6 race in Mini karts. Indoor setting makes it comfortable for toddlers and their parents." },
      { title: "Full restaurant on-site", body: "Nemo's Trackside is a sit-down restaurant with a wood-fired pizza oven and full bar. Adults can eat and drink between activities." },
    ],
    faqs: [
      { q: "Does FastTrax have mini golf?", a: "No mini golf at FastTrax. Our focus is indoor electric kart racing, duckpin bowling, shuffleboard, and arcade. If mini golf is the main thing you want, PopStroke is the specialist." },
      { q: "How does FastTrax pricing compare to PopStroke?", a: "Different pricing models — we charge per heat ($9.99-$20.99 depending on kart class), PopStroke charges per round. Depends on how long your group wants to play and what you want to do." },
      { q: "Can we do a date night at FastTrax?", a: "Yes — races, drinks at Nemo's, arcade. A typical date night runs 1.5-2 hours and $60-80 for two." },
      { q: "Do you have putting greens?", a: "No — we focus on racing, bowling, and arcade. If putting is a must-have, PopStroke is the pick." },
      { q: "Is FastTrax good for a first date?", a: "Yes — karting is low-pressure, there's plenty to talk about between heats, and Nemo's is a full restaurant for dinner after." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "Attractions & pricing", href: "/attractions" },
  },
  {
    slug: "high-five",
    brand: "ft",
    competitor: "Hi-5",
    tagline: "Indoor electric kart racing added to the family-entertainment mix",
    searchTerm: "Hi-5 alternative Fort Myers",
    intro:
      "Hi-5 is a well-known local family entertainment center with arcade, laser tag, bumper cars, and birthday-party spaces. If you're looking for an alternative that swaps bumper cars for indoor electric kart racing and adds duckpin bowling + shuffleboard + full-service dining at Nemo's, FastTrax is another SWFL option worth knowing about.",
    comparison: [
      { feature: "Main attraction", us: "Indoor electric kart racing (multi-level)", them: "Bumper cars, arcade, laser tag" },
      { feature: "Kart style", us: "High-performance electric, 40+ mph, Adult track", them: "Bumper-style vehicles" },
      { feature: "Bowling", us: "Duckpin lanes", them: "Not offered", usWins: true },
      { feature: "Shuffleboard", us: "Yes", them: "Not offered", usWins: true },
      { feature: "Arcade", us: "50+ games", them: "Similar size" },
      { feature: "Laser tag", us: "Available at HeadPinz (sister center)", them: "Yes, their specialty" },
      { feature: "Food + bar", us: "Nemo's Trackside — full restaurant + cocktails", them: "Concession-style" },
      { feature: "Target age", us: "All ages; full bar + adult leagues", them: "Lean family / younger kids" },
    ],
    reasons: [
      { title: "High-performance electric karts", body: "Our karts are built for racing with timing systems and leaderboards. Different experience from bumper-style vehicles — nice if you want real racing." },
      { title: "Works for adults solo or in groups", body: "Adult leagues, corporate events, date nights, 21+ bar nights. Many adults visit FastTrax without kids." },
      { title: "Duckpin bowling adds variety", body: "Smaller balls, shorter lanes — beginner-friendly. An extra activity on top of karts and arcade." },
      { title: "Nemo's Trackside full service", body: "Sit-down restaurant with craft cocktails, wood-fired pizza, full bar. Groups can eat and socialize between attractions." },
      { title: "Group events scale", body: "Corporate packages handle 60+. Private rooms, bundled pricing, race heats + food + drinks included." },
    ],
    faqs: [
      { q: "Is FastTrax like Hi-5?", a: "Some overlap in the 'indoor entertainment complex' format. FastTrax's specialty is high-performance electric kart racing, and we add duckpin bowling and shuffleboard. Hi-5's specialty is the bumper-car and laser-tag side — different strengths." },
      { q: "Which is better for a kids birthday party?", a: "Depends on age. Hi-5 is great for 3-8 year olds who love bumper cars and laser tag. FastTrax works from age 3 (Mini karts) through teens — particularly strong for 7+ when kids can handle Junior or Adult karts." },
      { q: "Does FastTrax have laser tag?", a: "HeadPinz (sister center in the same complex) has NEXUS laser tag. Many families combine FastTrax karting with HeadPinz laser tag in one evening." },
      { q: "Is there a full bar at FastTrax?", a: "Yes — Nemo's Trackside has a full bar, craft cocktails, wine, beer, and a sit-down restaurant menu." },
      { q: "Can adults go without kids?", a: "Yes — FastTrax is built for all ages. Date nights, adult leagues, corporate events, and bachelor/bachelorette parties all work here." },
    ],
    ctaLabel: "Book a heat",
    ctaHref: "/book/race",
    secondaryCta: { label: "See attractions", href: "/attractions" },
  },
];

// ── HeadPinz competitors ────────────────────────────────────────────────────

const hpAlternatives: AlternativeData[] = [
  {
    slug: "810-bowling",
    brand: "hp",
    competitor: "810 Billiards & Bowling",
    tagline: "Full entertainment center, not just bowling",
    searchTerm: "810 bowling alternative Fort Myers Naples",
    intro:
      "810 Billiards & Bowling does bowling + pool well, but HeadPinz is a full entertainment center — bowling lanes, NEXUS laser tag, gel blasters, HyperBowling, NeoVerse, 40+ arcade games, and Nemo's Sports Bistro. Your whole group does more than bowl. Two SWFL locations (Fort Myers + Naples) so you're never far.",
    comparison: [
      { feature: "Bowling lanes", us: "24 lanes (FM) / 32 lanes (Naples)", them: "Standard lane count" },
      { feature: "Laser tag", us: "NEXUS laser tag arena — multi-level", them: "None", usWins: true },
      { feature: "Gel blasters", us: "Dedicated arena", them: "None", usWins: true },
      { feature: "HyperBowling / NeoVerse", us: "Interactive projection-mapped lanes", them: "Traditional lanes only", usWins: true },
      { feature: "Arcade", us: "40+ games + redemption", them: "Limited" },
      { feature: "Food", us: "Nemo's Sports Bistro — full menu, full bar", them: "Bar food" },
      { feature: "Locations", us: "Fort Myers + Naples", them: "Fort Myers only" },
    ],
    reasons: [
      { title: "More than just bowling", body: "810 is a bowling-first place. HeadPinz is bowling + laser tag + gel blasters + arcade + dining — your group never gets bored." },
      { title: "HyperBowling and NeoVerse", body: "Projection-mapped interactive lanes that turn every frame into a game. 810 doesn't have this tech." },
      { title: "Better for mixed-age groups", body: "Kids can laser tag, teens can arcade, adults can bowl and have cocktails at Nemo's. 810 leans adult." },
      { title: "Two locations", body: "Fort Myers AND Naples — whichever is closer. 810 is Fort Myers only." },
      { title: "Real birthday parties", body: "Bronze, Silver, and VIP birthday packages include lanes, arcade cards, laser tag, and food — way more than an 810 lane-time rental." },
    ],
    faqs: [
      { q: "Does HeadPinz have pool tables like 810?", a: "No pool tables at HeadPinz. Our focus is bowling + laser tag + gel blasters + arcade + HyperBowling. If pool is critical, 810 is your spot; otherwise HeadPinz has more variety." },
      { q: "Is HeadPinz cheaper than 810?", a: "Per lane, comparable. Our birthday and group packages are typically better value because they bundle lanes + arcade + laser tag + food." },
      { q: "Can we do a corporate event at HeadPinz?", a: "Yes — group event packages include lanes, private party rooms, buffet catering (Taco Bar, Fajita Bar, Pizza Buffet, etc.), and optional laser tag or gel blasters." },
      { q: "Is HeadPinz kid-friendly?", a: "Yes — arcade, laser tag, and bowling all welcome kids. Birthday parties (Bronze / Silver / VIP) are our biggest volume." },
      { q: "Do you have leagues like 810?", a: "Yes — we run bowling leagues out of both Fort Myers and Naples. Sign-ups on the leagues page." },
    ],
    ctaLabel: "Book a lane",
    ctaHref: "/book/bowling",
    secondaryCta: { label: "See attractions", href: "/fort-myers/attractions" },
  },
  {
    slug: "bowlero",
    brand: "hp",
    competitor: "Bowlero",
    tagline: "Same premium bowling, locally owned, way more extras",
    searchTerm: "Bowlero alternative Fort Myers Naples",
    intro:
      "Bowlero is the chain. HeadPinz is the local SWFL alternative — same premium lanes, HyperBowling and NeoVerse interactive tech, plus NEXUS laser tag and gel blasters that Bowlero doesn't have. Two Florida locations, locally staffed, better birthday packages.",
    comparison: [
      { feature: "Bowling lanes", us: "24+ lanes per center, VIP lanes", them: "Similar" },
      { feature: "HyperBowling / NeoVerse", us: "Yes — projection-mapped", them: "Varies by location", usWins: true },
      { feature: "Laser tag", us: "NEXUS arena", them: "None typically", usWins: true },
      { feature: "Gel blasters", us: "Dedicated arena", them: "None", usWins: true },
      { feature: "Food", us: "Nemo's Sports Bistro — full menu", them: "Bar food, chain menu" },
      { feature: "Ownership", us: "Locally owned, SWFL staff", them: "National chain", usWins: true },
      { feature: "Birthday packages", us: "Bronze / Silver / VIP with bowling + arcade + food bundled", them: "Bowling-heavy packages" },
    ],
    reasons: [
      { title: "Local > chain", body: "When you book a birthday, you talk to someone who'll remember you next year. Bowlero is a call center." },
      { title: "More attractions per trip", body: "Laser tag + gel blasters beside the lanes means the group does more than just bowl." },
      { title: "Better food", body: "Nemo's Sports Bistro is a real restaurant. Bowlero food is chain-standard bar menu." },
      { title: "Fort Myers + Naples", body: "Whichever is closer, we're there. Bowlero is sparse in SWFL." },
      { title: "Kids + adults + corporate all fit", body: "Birthday parties in the day, leagues in the evening, corporate events on weeknights. We flex." },
    ],
    faqs: [
      { q: "Is HeadPinz like Bowlero?", a: "Similar premium bowling experience with VIP lanes and interactive tech, but HeadPinz is locally owned and adds NEXUS laser tag, gel blasters, and a full restaurant — more per visit." },
      { q: "Is HeadPinz cheaper than Bowlero?", a: "Comparable per lane. Our birthday and event packages typically beat chain pricing because we bundle more (food, arcade, attractions) at fixed prices." },
      { q: "Can we book VIP lanes like Bowlero?", a: "Yes — our VIP Birthday package includes VIP-section lanes with NeoVerse LED video screens. Available at both Fort Myers and Naples." },
      { q: "Do you have cosmic bowling?", a: "Yes — HyperBowling and glow bowling with projection-mapped lanes. Booked by the lane like traditional cosmic bowling." },
      { q: "Where are the HeadPinz locations?", a: "Fort Myers (14513 Global Parkway) and Naples (8525 Radio Lane). Both have the same attraction set." },
    ],
    ctaLabel: "Book a lane",
    ctaHref: "/book/bowling",
    secondaryCta: { label: "Book a birthday party", href: "/fort-myers/birthdays" },
  },
  {
    slug: "gator-lanes",
    brand: "hp",
    competitor: "Gator Lanes",
    tagline: "More attractions, both locations, better packages",
    searchTerm: "Gator Lanes alternative Fort Myers",
    intro:
      "Gator Lanes is a long-standing Fort Myers bowling alley — traditional, no-frills. HeadPinz is the modern SWFL alternative: HyperBowling, NeoVerse projection-mapped lanes, NEXUS laser tag, gel blasters, plus the full arcade and Nemo's Sports Bistro. Same \"let's go bowling\" plan, but way more to do once you're there — and we're in Naples too.",
    comparison: [
      { feature: "Bowling lanes", us: "24 lanes (FM) / 32 lanes (Naples), VIP sections", them: "Traditional lanes" },
      { feature: "HyperBowling / NeoVerse", us: "Projection-mapped interactive lanes", them: "None", usWins: true },
      { feature: "Laser tag", us: "NEXUS multi-level arena", them: "None", usWins: true },
      { feature: "Gel blasters", us: "Dedicated arena", them: "None", usWins: true },
      { feature: "Arcade", us: "40+ modern games with redemption", them: "Limited older machines" },
      { feature: "Food", us: "Nemo's Sports Bistro — full menu, craft bar", them: "Bar / snack menu" },
      { feature: "Locations", us: "Fort Myers + Naples", them: "Fort Myers only" },
    ],
    reasons: [
      { title: "HyperBowling changes bowling nights", body: "Projection-mapped interactive lanes turn every frame into a mini-game. Kids and adults both stay engaged — not just the bowlers in your group." },
      { title: "Laser tag + gel blasters add another hour", body: "Gator Lanes is one activity. HeadPinz is three or four under the same roof. Your group stays longer and has more memorable moments." },
      { title: "VIP lanes for private events", body: "Bronze, Silver, and VIP birthday packages include private VIP-section lanes with NeoVerse LED video screens — not available at traditional alleys." },
      { title: "Naples coverage", body: "If you're south of Bonita, Naples HeadPinz is closer and has the same attraction set." },
      { title: "Real food and drinks", body: "Nemo's is a sports bistro with a full menu + craft cocktails. Gator Lanes is pub-grub casual." },
    ],
    faqs: [
      { q: "Does HeadPinz have bowling leagues like Gator Lanes?", a: "Yes — we run adult and youth leagues at both Fort Myers and Naples. Sign-ups on the leagues page." },
      { q: "Is HeadPinz cheaper than Gator Lanes?", a: "Per-lane pricing is comparable. HeadPinz tends to win on group packages because birthdays / corporate events bundle lanes + attractions + food at a fixed price." },
      { q: "Can we do a more classic bowling experience at HeadPinz?", a: "Yes — we have traditional 10-pin lanes in addition to HyperBowling/NeoVerse. Pick what your group wants when booking." },
      { q: "Is there a pro shop?", a: "Yes — pro shop on-site for ball drilling and gear. Same as Gator Lanes." },
      { q: "Kids birthday parties?", a: "Bronze, Silver, and VIP packages include lanes + arcade + laser tag + food. Way more than a lane rental at a traditional alley." },
    ],
    ctaLabel: "Book a lane",
    ctaHref: "/book/bowling",
    secondaryCta: { label: "Birthdays & parties", href: "/fort-myers/birthdays" },
  },
  {
    slug: "high-five",
    brand: "hp",
    competitor: "Hi-5",
    tagline: "Full bowling + laser tag + arcade, plus Nemo's for real food",
    searchTerm: "Hi-5 alternative Fort Myers",
    intro:
      "Hi-5 is a local SWFL rec center with an arcade, laser tag, and bumper cars — solid for kid birthdays. HeadPinz covers the same ground (arcade + NEXUS laser tag) AND adds 24+ bowling lanes with HyperBowling/NeoVerse tech plus Nemo's Sports Bistro. More attractions, better food, two locations, premium birthday packages.",
    comparison: [
      { feature: "Bowling lanes", us: "24 lanes (FM) / 32 lanes (Naples)", them: "None", usWins: true },
      { feature: "HyperBowling / NeoVerse", us: "Yes", them: "None", usWins: true },
      { feature: "Laser tag", us: "NEXUS multi-level arena", them: "Yes" },
      { feature: "Gel blasters", us: "Dedicated arena", them: "None", usWins: true },
      { feature: "Arcade", us: "40+ games + redemption", them: "Similar size" },
      { feature: "Food", us: "Nemo's Sports Bistro — full menu + craft bar", them: "Concession / snack bar" },
      { feature: "Adult-friendly", us: "Full bar, cocktails, adult leagues", them: "Lean family / kid" },
    ],
    reasons: [
      { title: "Bowling is the closer", body: "Hi-5 maxes out at arcade + laser tag. HeadPinz adds 24-32 lanes with modern tech — another whole hour of group activity under one roof." },
      { title: "Real food", body: "Nemo's Sports Bistro is a sit-down restaurant with cocktails. Hi-5 is concessions." },
      { title: "Adult events fit", body: "Corporate team-building, adult birthday parties, bachelor/bachelorette nights. Hi-5 is built for kids 3-12." },
      { title: "Two SWFL locations", body: "Fort Myers + Naples. Hi-5 is single-location." },
      { title: "Better birthday packages", body: "Bronze/Silver/VIP bundle lanes + arcade + laser tag + catered food at fixed per-person prices. Hi-5 is pay-per-activity." },
    ],
    faqs: [
      { q: "Is HeadPinz like Hi-5?", a: "Similar family-friendly entertainment format, but HeadPinz's core is 24-32 bowling lanes with modern HyperBowling/NeoVerse tech that Hi-5 doesn't have. Same arcade + laser tag." },
      { q: "Which is cheaper for a kid's birthday?", a: "Depends on group size and what's included. Hi-5 is often cheaper for small parties (6-10 kids). HeadPinz wins on bundled packages (lanes + arcade + laser tag + food) for groups of 15+." },
      { q: "Does HeadPinz have bumper cars?", a: "No bumper cars. Our equivalent group attractions are NEXUS laser tag and the gel blasters." },
      { q: "Can we do a mixed party (kids + adults) at HeadPinz?", a: "Yes — very common. Kids bowl/laser tag/arcade while adults hang at Nemo's with cocktails. Everyone happy." },
      { q: "Is Nemo's Sports Bistro full-service?", a: "Yes — sit-down service, full menu (burgers, wings, salads, wraps, pizza), full bar with craft cocktails. Not a counter / snack bar." },
    ],
    ctaLabel: "Book a lane",
    ctaHref: "/book/bowling",
    secondaryCta: { label: "See attractions", href: "/fort-myers/attractions" },
  },
];

// ── Exports ─────────────────────────────────────────────────────────────────

export const FT_ALTERNATIVES: Record<string, AlternativeData> = Object.fromEntries(
  ftAlternatives.map((a) => [a.slug, a]),
);

export const HP_ALTERNATIVES: Record<string, AlternativeData> = Object.fromEntries(
  hpAlternatives.map((a) => [a.slug, a]),
);

export function getAlternative(brand: AlternativeBrand, slug: string): AlternativeData | null {
  const registry = brand === "ft" ? FT_ALTERNATIVES : HP_ALTERNATIVES;
  return registry[slug] ?? null;
}

export function listAlternatives(brand: AlternativeBrand): AlternativeData[] {
  return brand === "ft" ? ftAlternatives : hpAlternatives;
}
