# HeadPinz.com Website Rebuild — Dual-Branded Platform

## Vision

Build HeadPinz.com as a dual-branded site within the same Next.js app as FastTrax. Shares the booking system, components, and infrastructure but has its own branding, navigation, and content. Inspired by TopGolf's clean location-page approach and FastTrax's existing dark theme quality.

## Architecture: One App, Two Brands

```
fasttrax-web/
  app/
    (fasttrax)/          ← FastTrax branded routes (existing)
      page.tsx           ← fasttraxent.com homepage
      racing/
      attractions/
      book/
      ...
    (headpinz)/          ← HeadPinz branded routes (new)
      page.tsx           ← headpinz.com landing (location selector)
      fort-myers/        ← HeadPinz Fort Myers location page
        page.tsx
      naples/            ← HeadPinz Naples location page
        page.tsx
      bowling/           ← Bowling info/booking
      laser-tag/
      gel-blaster/
      specials/
      menu/
      parties/
      book/              ← HeadPinz booking (reuses attraction booking system)
```

**Domain routing:** Next.js middleware routes based on hostname:
- `fasttraxent.com` → `(fasttrax)` layout
- `headpinz.com` → `(headpinz)` layout
- `localhost:3000` → default (FastTrax), `localhost:3000/hp` → HeadPinz preview

## Branding

### HeadPinz Colors
| Token | Value | Usage |
|-------|-------|-------|
| `--hp-bg` | `#0a0518` | Page background (deeper purple-black) |
| `--hp-gradient-from` | `#240A2B` | Hero gradient start (deep purple) |
| `--hp-gradient-to` | `#273370` | Hero gradient end (deep blue) |
| `--hp-accent` | `#fd5b56` | Primary CTA (coral/red) |
| `--hp-accent-hover` | `#ff7a77` | CTA hover |
| `--hp-secondary` | `#9b51e0` | Secondary accent (vivid purple) |
| `--hp-cyan` | `#0693e3` | Links, highlights |

### HeadPinz Fonts
- Headers: **Dela Gothic One** (bold, display)
- Body: **Varela Round** (clean, rounded)
- Fallback: **Arimo** (sans-serif)

### FastTrax Colors (existing, for reference)
| Token | Value | Usage |
|-------|-------|-------|
| `--ft-bg` | `#000418` | Page background |
| `--ft-accent` | `#00E2E5` | Primary CTA (cyan) |
| `--ft-red` | `#E41C1D` | Secondary (red) |
| `--ft-purple` | `#8652FF` | Tertiary (purple) |

## Shared Components
- Booking system (attractions + racing)
- Contact form
- MiniCart
- OrderSummary / checkout
- SMS verification (Twilio)
- BMI API proxy
- Square checkout
- Pandora API

## HeadPinz-Specific Components
- HeadPinz Nav (different logo, links, colors)
- HeadPinz Footer (different contact info per location)
- Location Selector (landing page — two cards like current site)
- Bowling Reservations (MyBowlingPassport integration or custom)
- Specials page (daily deals, pricing tables)
- Menu page (Nemo's Food & Drinks)
- Parties page (kids birthday, group events)

## Locations

### Fort Myers
- 14513 Global Parkway, Fort Myers, FL 33913
- (239) 302-2155
- Hours: Sun-Thu 11AM-12AM, Fri-Sat 11AM-2AM
- Attractions: Bowling (regular + VIP), NeoVerse, HyperBowling, Laser Tag, Gel Blasters, Game Zone
- Food: Nemo's Food & Drinks
- BMI clientKey: `headpinzftmyers`

### Naples
- 8525 Radio Lane, Naples, FL 34104
- (239) 455-3755
- Hours: Sun-Thu 11AM-12AM, Fri-Sat 11AM-2AM
- Attractions: Bowling (regular + VIP), Laser Tag, Game Zone
- BMI clientKey: `headpinznaples`

## Landing Page: Location Selector

TopGolf-inspired clean entry:

```
┌─────────────────────────────────────────────────┐
│              HEADPINZ LOGO                       │
│         "Where Fun Comes Together"               │
│                                                  │
│   ┌──────────────┐   ┌──────────────┐          │
│   │  FORT MYERS  │   │    NAPLES    │          │
│   │  [hero img]  │   │  [hero img]  │          │
│   │  14513       │   │  8525 Radio  │          │
│   │  Global Pkwy │   │  Lane        │          │
│   │              │   │              │          │
│   │  [ENTER →]   │   │  [ENTER →]   │          │
│   └──────────────┘   └──────────────┘          │
│                                                  │
│         ── 10 Years of Fun ──                    │
└─────────────────────────────────────────────────┘
```

## Fort Myers Location Page

TopGolf + FastTrax inspired layout:

### Hero
- Full-width image/video of venue
- "HeadPinz Fort Myers" title
- Address, hours, phone
- "Book Now" CTA

### Quick Actions Bar (TopGolf-inspired)
- Book Bowling | Laser Tag | Gel Blasters | Parties | View Menu

### Attractions Grid
Cards for each activity with image, description, pricing, "Book Now" CTA:
- Premier Bowling (Regular + VIP)
- NeoVerse (VIP exclusive)
- HyperBowling (VIP exclusive)
- NEXUS Laser Tag
- NEXUS Gel Blaster Arena
- Game Zone

### Weekly Specials
Visual schedule of daily deals (current pricing table data)

### Food & Drinks
Nemo's menu highlights with "View Full Menu" CTA

### Testimonials
Customer reviews carousel

### Live Availability
Real-time lane availability (regular/VIP) — from BMI or MyBowlingPassport

## Implementation Order

### Phase 1: Infrastructure
1. Hostname-based routing middleware
2. HeadPinz layout (Nav, Footer, theme provider)
3. Landing page with location selector
4. Fort Myers location page

### Phase 2: Fort Myers Content
5. Attractions detail sections
6. Weekly specials page
7. Menu page
8. Parties/events page

### Phase 3: Booking Integration
9. Bowling reservations (MyBowlingPassport or custom)
10. Laser Tag / Gel Blaster booking (reuse attraction booking system)
11. Cross-sell between HeadPinz attractions

### Phase 4: Naples
12. Naples location page (same template, different data)
13. Naples-specific pricing and specials

### Phase 5: Polish
14. SEO optimization
15. Analytics
16. Performance
