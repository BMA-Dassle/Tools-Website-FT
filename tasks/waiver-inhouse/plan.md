# In-house waivers — own, store, and translate (plan)

## Why
Waivers are the last untranslated guest surface — because the legal BODY is fetched
from BMI/Pandora (English-only). Owning the template + signature in our own software
(Neon) lets us (a) serve a Spanish version and (b) control versions/retention. Owner
2026-07-26. **Default to internal; a flag flips back to BMI** if anything goes wrong.

## Grounding (from code map — file:line)
- Template today: `pandoraFetchWaiverTemplate(age, location)` `lib/pandora.ts:160` → `GET /api/pandora/waiver` `app/api/pandora/waiver/route.ts:17-69` → BMI. Body is BMI's HTML, rendered via `dangerouslySetInnerHTML` (`WaiverSigning.tsx:87`). No en/es, no adult/minor branch in OUR code (BMI's `waiver/search?age=` returns the age-right text).
- Sign today: `pandoraSignWaiver()` `lib/pandora.ts:178` → `POST /api/pandora/waiver` `route.ts:88-207` → multipart PNG to BMI, 3× retry + salvage probe. **Nothing stored on our side.**
- `waiverValid`: consumers read a boolean on `PartyMember` (loosely coupled, ~40 sites). Validity is DERIVED from BMI (`Pandora waiverExpiry > now`) at 4 points: `app/api/pandora/route.ts:46-51`, `app/api/pandora/waiver/route.ts:74-86`, `app/api/kiosk/waiver/roster/route.ts:37-56`, `service/qualification-refresh.ts:70-93`.
- Existing local persistence = `kiosk_waiver_joins` (a roster row, NOT a waiver) — but its Neon-first, self-creating-schema pattern is the template to reuse.

## The crux risk
Returning/pre-registered guests signed in BMI, not Neon. If we stop trusting BMI, they
regress to "invalid." **Mitigation: while internal is ON, still DUAL-WRITE to BMI** so
`waiverExpiry` keeps advancing and all 4 derivation points keep returning valid. Neon
becomes our system-of-record; BMI stays a mirror. No `waiverValid` consumer changes.

## Approach — flag `KIOSK_WAIVER_INHOUSE` (DEFAULT ON; set "0" to revert to BMI)

### Phase 1 (this build) — own + store + translate, BMI kept in sync
1. **Flag** `kioskWaiverInhouseEnabled()` in `src/features/kiosk/flags.ts` — kill-switch style, **defaults ON**; `KIOSK_WAIVER_INHOUSE=0` in Vercel reverts to today's BMI-only path.
2. **Template store** — our own HTML templates, versioned, keyed by `variant` (adult|minor) × `lang` (en|es), from `tasks/waiver-inhouse/waiver-source-en.md`. New `GET /api/kiosk/waiver/template?age=&location=&lang=` returns the same `PandoraWaiverTemplate` shape (`{ contentID, duration, body }`) so callers are untouched. Adult/minor branch on age `<18`; lang from the kiosk locale.
3. **Re-point the template fetch:** `pandoraFetchWaiverTemplate` (and `pandoraOnboardGuest`'s template branch, `lib/pandora.ts:236`) call our route when the flag is on, else Pandora. `WaiverSigning.tsx` unchanged (already renders arbitrary HTML → now our translated body).
4. **Signed-waiver store** — new Neon table `kiosk_waivers` (self-creating schema, Neon-first hard rule): `person_id, signer_person_id, template_variant, template_version, lang, location, signature (blob-store URL or base64), signed_at, expiry`. New `POST /api/kiosk/waiver/sign`.
5. **Dual-write:** the sign route persists to Neon FIRST (unconditional), THEN calls BMI `POST /v2/bmi/waiver` reusing the existing multipart + retry/salvage logic — so BMI stays mirrored and downstream gating is untouched. Flag OFF = Pandora-only (today).
6. **Signature capture** stays (`SignaturePad.tsx`) — just POST target changes.

### Phase 2 (later, separate) — stop depending on BMI for validity
Migrate the 4 derivation points to Neon-first / Pandora-fallback (fallback is REQUIRED for
returning guests with no Neon row). NOT needed for Phase 1 because we dual-write. Defer.

## ⚠ LEGAL — non-negotiable
The Spanish waiver is a binding legal document (indemnity, jury-trial waiver, **FL Statute
744.301** minor waiver, arbitration/venue, chargeback waiver). A mistranslation can render
clauses unenforceable. **I will produce a DRAFT Spanish translation, but it MUST be
attorney-reviewed before it is used to bind a Spanish-speaking signer.**
- The English in-house template is legally equivalent to today's BMI text (owner-provided) — safe to serve immediately.
- The Spanish body ships **gated**: served only when reviewed/approved (a second flag or a `reviewed: true` marker on the ES template), so a guest never signs an unreviewed legal translation. Until then, ES-locale guests get translated CHROME + the English legal body (as today).

## Verification
- Flag ON: kiosk waiver renders OUR English body, signature stores a `kiosk_waivers` Neon row AND advances BMI `waiverExpiry` (dual-write); `waiverValid` gating unaffected end-to-end (people-step → check-in → racing express-lane). Flag OFF: byte-identical to today.
- Seed + live smoke one full sign (adult + minor/guardian) on a real kiosk before wide rollout (per repo rule).
