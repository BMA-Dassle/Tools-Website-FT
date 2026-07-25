# Kiosk i18n — Spanish (Phase 1 language)

**Status:** Plan approved (2026-07-25). No code written yet — awaiting go-ahead on Phase 0 spike.
**Owner ask:** eric@headpinz.com — "let's see a plan for Spanish."

## Decisions locked (2026-07-25)

| Decision | Choice | Why |
| --- | --- | --- |
| Formatting library | **`intl-messageformat`** (FormatJS ICU core) under our own `useT()` hook | Tiny, framework-agnostic, real Spanish plural + interpolation handling. NOT `next-intl` (URL/middleware locale model fights the client-only localStorage kiosk + the modified Next.js — see `apps/web/AGENTS.md`). NOT hand-rolled (re-implementing plural rules is a bug farm on the interpolated business-rule strings). |
| Center scope | **All centers** — FastTrax FM, HeadPinz FM, HeadPinz Naples | Owner call. FM is the high-value target (~20-27% Spanish-speaking households); Naples is ~90% English-only but included for a single uniform rollout. Flag-gated regardless. |
| First language | **Spanish (`es`)** only | English → Spanish → Haitian Creole is the SWFL order. Creole is a later language pass on the same scaffolding. |

## Research basis (SWFL language demographics)

- Fort Myers: ~27% of households speak a non-English language at home; ~19.6% Spanish.
- Lee County overall: ~15% Spanish; ~21% non-English.
- Collier (Southwest PUMA): Spanish 31,135 households; Haitian ~5,016 (clear #3).
- Naples city: ~90% English-only, ~3.1% Spanish.
- Haitian/French Creole is now the **3rd** most-spoken language in Florida statewide → the natural language #3 after Spanish.

## Grounding — code seams confirmed (read in full 2026-07-25)

- **Mount point:** `KioskShell` wraps every kiosk route and already hosts `KioskConfigProvider` — `apps/web/src/features/kiosk/components/KioskShell.tsx:170`. The `LocaleProvider` mounts here, sibling to config.
- **Config is client-only + localStorage, no URL locale segment** — `apps/web/src/features/kiosk/config.ts:150-333`. Locale rides in `KioskConfig` exactly like `variant`/`brand`, NOT in the URL path.
- **Precedent for presentation switching:** `variant: "podium" | "pitcrew"` and the `brand-fasttrax`/`brand-headpinz` class switch (`KioskShell.tsx:148`). `locale` is the same pattern.
- **Modified Next.js:** `apps/web/AGENTS.md` — "NOT the Next.js you know." Reinforces: keep i18n in our own React layer, avoid framework-coupled routing i18n.
- **Backend sends hardcoded `Accept-Language: "en"`** (e.g. `app/api/booking/v2/reserve/route.ts:111`). OUT OF SCOPE this effort — upstream (Pandora/BMI/QAMF) content stays English.

## Scope

**IN:** guest-facing kiosk flow copy — Attract, Categories, People/Bowling steps, Slot/Time, Checkout + Upsell, Rewards, Confirmation, Check-in chrome, race-info hub, mobile-join guest-facing screens.

**OUT:**
- `kiosk/admin` + all device/card-reader/QR/MSR staff surfaces (staff-facing English).
- **Legal waiver body text** — liability document, originates server-side (Pandora), English-only upstream. Kiosk chrome around it may be translated; the legal body is not AI-translated/shipped blind. Separate professional-translation track if ever needed.
- Backend `Accept-Language` headers (stay `en`).
- Brand/product proper nouns — never translated: **FastTrax, HeadPinz, Game Zone, Podium, Pit Crew, Duckpin** (locked glossary).

## Phases

### Phase 0 — Spike + decision gate (~½ day) — NOTHING SHIPPED
- [ ] Add `locale?: "en" | "es"` to `KioskConfig`, default `"en"`.
- [ ] Stand up `LocaleProvider` + `useT()` (backed by `intl-messageformat`) in `KioskShell`.
- [ ] Add a language toggle (ES/EN) component.
- [ ] Convert ONE screen fully (Attract + one step) EN↔ES end-to-end.
- [ ] Prove: toggle works, persists, layout holds in portrait. **Gate before mass extraction.**

### Phase 1 — Infrastructure (~2-3 days)
- [ ] `locale` in `config.ts`: launch param `?lang=es`, persist, bump `CONFIG_VERSION` 2 → 3, self-heal default in `resolveKioskConfig`.
- [ ] `LocaleProvider` + `useT()` mounted in `KioskShell`; set kiosk container `lang` attribute dynamically from `config.locale`.
- [ ] `en.json` bundled (source of truth); `es.json` lazy-loaded.
- [ ] Language toggle: default from `config.locale`, guest can switch mid-session, **resets to configured default on Start-Over** (shared public device).
- [ ] Everything behind flag `NEXT_PUBLIC_KIOSK_I18N`, default OFF.

### Phase 2 — String extraction (the bulk, ~1.5-2.5 wks)
Extract guest-facing copy from ~50 components into `en.json`, in flow order:
- [ ] Attract / Categories / Flow shell
- [ ] `KioskPeopleStep.tsx` (2,256 lines — **heaviest**; convert conditional/interpolated messages to ICU params + plurals)
- [ ] Bowling steps (People/Time/Details/Offer/Tier) + `KioskSlotStep`
- [ ] Checkout + Upsell + Rewards + VIP overview
- [ ] Confirmation + Check-in chrome
- [ ] race-info hub + mobile-join guest screens
- [ ] Verify NO admin/staff strings pulled in.

### Phase 3 — Translation (~few days + review loop)
- [ ] AI first-pass `es.json` with locked glossary (brand/product nouns untranslated).
- [ ] **Native-Spanish human review pass** (owner-designated reviewer).
- [ ] Portrait-touchscreen layout QA — Spanish ~15-30% longer; check cinematic copy, buttons, `OnScreenKeyboard`.

### Phase 4 — Ship gated
- [ ] Enable at Fort Myers first (FT + HPFM); one full end-to-end ES booking smoke.
- [ ] Then enable Naples; smoke.
- [ ] Owner sign-off per center.

## Guardrails (repo hard rules)

- **Do NOT touch backend `Accept-Language: "en"`** — upstream content is English.
- **`CONFIG_VERSION` bump discards old localStorage envelopes** → kiosks re-provision. They recover from Neon by `kioskId`, but this is the same "re-save the FM kiosks" caution from the cloud-config work — call it out at deploy.
- Run **`node scripts/a11y-gate.mjs`** + react-hooks lint before any push.
- **Multi-writer kiosk branch (Alex also pushes)** — `git fetch` + status + diff before commit.
- Single final `turbo build`, not per-PR (tsc/lint per PR).
- No emoji in UI — `@tabler/icons-react` for the language-toggle glyph.

## Effort estimate

- Phase 0: ~½ day · Phase 1: ~2-3 days · Phase 2: ~1.5-2.5 wks (dominant) · Phase 3: ~few days + review loop.
- Each **additional** language later (Haitian Creole next) is mostly a translation + QA pass on this scaffolding.

## Open questions for owner

- Who is the native-Spanish reviewer for the Phase 3 pass?
- Language toggle placement — persistent globe in a corner, or a first-screen "English / Español" choice on Attract? (Lean: both — Attract choice + persistent toggle.)
