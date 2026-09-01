/** Race Sims (racing simulators, FastTrax FM) — the kiosk tile + the wizard's
 *  product and track steps. PLACEHOLDER PHASE 2026-08: prices and track names
 *  ("Track A/B/C") are stand-ins from features/race-sims/products.ts; the tile
 *  is a locked "Coming Soon" card for guests (staff PIN opens the flow — the
 *  PIN sheet itself is a staff surface and stays hardcoded English).
 *
 *  Keys live under `racesim.*` plus this screen's `stepTitle.*`/`stepReason.*`
 *  entries for KioskFlow's English→key lookup maps. Mirror every key in es.
 *
 *  es values are a first-pass AI translation pending native-Spanish review.
 *  Locked glossary — NEVER translated: FastTrax, HeadPinz, Game Zone, Podium,
 *  Pit Crew, Duckpin. "Race Sims" is the product name and stays English. */
export const racesimEn = {
  // --- Tile (attractions shelf, FastTrax FM only) ---
  "racesim.tile.name": "Race Sims",
  "racesim.tile.blurb": "Pro racing simulators — real tracks, real competition.",
  "racesim.tile.comingSoon": "Coming Soon",
  "racesim.tile.comingSoonNote": "Racing simulators are almost here — stay tuned!",

  // --- Product step (karting KIOSK product page: one simple card per sellable) ---
  // Karting's heading is "Choose Your Race"; its helper talks about tiers
  // ("races you've qualified for"), which sims don't have — hence ours.
  "racesim.product.heading": "Choose Your Race",
  "racesim.product.helper": "Pick the race that fits your group.",
  // Tier-rung section header's right-side meta (mirrors karting's
  // "Everyone starts here").
  "racesim.product.sectionMeta": "Everyone rides here",
  // Card track line (mirrors karting's "Runs on … Track" dot row).
  "racesim.product.trackLine": "Runs on 3 rotating tracks — pick yours next",
  // Product display names key by catalog slug (race-sims/products.ts).
  "racesim.product.sim-single": "1 Race",
  "racesim.product.single.sub": "One race on the track of your choice.",
  /** Renders after "$14.00 / " — karting's price row reads "$20.99 / racer". */
  "racesim.product.perRacer": "racer",
  /** Karting's group-math footer: "$20.99 × 3 racers = $62.97 total".
   *  {unit}/{total} pre-formatted, {count} = racers in the party. */
  "racesim.product.groupTotal":
    "{unit} × {count, plural, one {# racer} other {# racers}} = {total} total",
  "racesim.product.selected": "Selected",

  // --- Track step (Track A/B/C, rotating lineup) ---
  "racesim.track.intro": "Three tracks in rotation — a fresh lineup every week or two.",
  "racesim.track.a": "Track A",
  "racesim.track.b": "Track B",
  "racesim.track.c": "Track C",
  "racesim.track.tagline": "Rotating layout — a new lineup every week or two.",

  // --- Time step (racing heat-picker layout) ---
  "racesim.slot.heading": "Pick a Time",
  "racesim.slot.bookingFor": "Booking for {count, plural, one {# racer} other {# racers}}",
  "racesim.slot.full": "Full",
  "racesim.slot.spotsLeft": "{count, plural, one {# spot} other {# spots}} left",
  "racesim.slot.open": "{free} of {cap} open",
  "racesim.slot.needOnly": "Need {need}, only {free} left",
  "racesim.slot.tooClose": "Too close to another activity",
  "racesim.slot.tooCloseExisting": "Too close to an existing reservation",
  "racesim.slot.retry": "Retry",
  "racesim.slot.empty": "No sessions available today.",
  // Racing's scheduling-rule statuses on the sim grid.
  "racesim.slot.reservedForEvent": "Reserved for event",
  "racesim.slot.privateEvent.title": "Private Event",
  "racesim.slot.privateEvent.body":
    "Today is reserved for a private event and is not available for public booking.",
  /** Track switcher helper under the cards — {track} = "Track A". */
  "racesim.slot.trackHint": "Showing {track} sessions — tap another track to switch.",
  /** Same start already picked on another sim track — {track} = that track. */
  "racesim.slot.pickedOtherTrack": "Picked on {track}",
  /** Status line on a picked card BMI stopped proposing (our hold took the rigs). */
  "racesim.slot.picked": "Picked",
  "racesim.slot.pickedCount": "{count, plural, one {# session picked} other {# sessions picked}}",

  // --- KioskFlow shell lookups (activity label lives in parts/flow.ts) ---
  "stepReason.racesimConflict": "That time is too close to another activity — pick another.",
  "stepReason.racesimSelfConflict":
    "You picked the same time on two tracks — remove one to continue.",
  "stepTitle.raceOptions": "Race Options",
  "stepTitle.track": "Track",
  "stepReason.racesimProduct": "Pick a race to continue.",
  "stepReason.racesimTrack": "Pick a track.",
} as const;

export const racesimEs: Record<keyof typeof racesimEn, string> = {
  "racesim.tile.name": "Race Sims",
  "racesim.tile.blurb": "Simuladores de carreras profesionales — pistas reales, competencia real.",
  "racesim.tile.comingSoon": "Próximamente",
  "racesim.tile.comingSoonNote": "Los simuladores de carreras ya casi llegan — ¡mantente atento!",

  "racesim.product.heading": "Elige tu carrera",
  "racesim.product.helper": "Elige la carrera que le convenga a tu grupo.",
  "racesim.product.sectionMeta": "Todos corren aquí",
  "racesim.product.trackLine": "Corre en 3 pistas rotativas — elige la tuya después",
  "racesim.product.sim-single": "1 carrera",
  "racesim.product.single.sub": "Una carrera en la pista que elijas.",
  "racesim.product.perRacer": "piloto",
  "racesim.product.groupTotal":
    "{unit} × {count, plural, one {# piloto} other {# pilotos}} = {total} en total",
  "racesim.product.selected": "Seleccionado",

  "racesim.track.intro": "Tres pistas en rotación — alineación nueva cada una o dos semanas.",
  "racesim.track.a": "Pista A",
  "racesim.track.b": "Pista B",
  "racesim.track.c": "Pista C",
  "racesim.track.tagline": "Trazado rotativo — alineación nueva cada una o dos semanas.",

  "racesim.slot.heading": "Elige una hora",
  "racesim.slot.bookingFor": "Reserva para {count, plural, one {# piloto} other {# pilotos}}",
  "racesim.slot.full": "Lleno",
  "racesim.slot.spotsLeft": "{count, plural, one {Queda # lugar} other {Quedan # lugares}}",
  "racesim.slot.open": "{free} de {cap} libres",
  "racesim.slot.needOnly": "Necesitas {need}, solo quedan {free}",
  "racesim.slot.tooClose": "Muy cerca de otra actividad",
  "racesim.slot.tooCloseExisting": "Muy cerca de una reserva existente",
  "racesim.slot.retry": "Reintentar",
  "racesim.slot.empty": "No hay sesiones disponibles hoy.",
  "racesim.slot.reservedForEvent": "Reservado para un evento",
  "racesim.slot.privateEvent.title": "Evento privado",
  "racesim.slot.privateEvent.body":
    "Hoy está reservado para un evento privado y no está disponible para reservas públicas.",
  "racesim.slot.trackHint": "Mostrando sesiones de {track} — toca otra pista para cambiar.",
  "racesim.slot.pickedOtherTrack": "Elegida en {track}",
  "racesim.slot.picked": "Elegida",
  "racesim.slot.pickedCount": "{count, plural, one {# sesión elegida} other {# sesiones elegidas}}",
  "stepReason.racesimConflict": "Esa hora está muy cerca de otra actividad — elige otra.",
  "stepReason.racesimSelfConflict":
    "Elegiste la misma hora en dos pistas — quita una para continuar.",

  "stepTitle.raceOptions": "Opciones de carrera",
  "stepTitle.track": "Pista",
  "stepReason.racesimProduct": "Elige una carrera para continuar.",
  "stepReason.racesimTrack": "Elige una pista.",
};
