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

  // --- Product step (1 Race vs Race Packs — karting-product-page layout) ---
  "racesim.product.intro": "How many races?",
  "racesim.product.introHelp": "Prices are per racer — pick one option for your group.",
  // Tier-rung section header's right-side meta (mirrors karting's
  // "Everyone starts here").
  "racesim.product.sectionMeta": "Everyone rides here",
  // Card track line (mirrors karting's "Runs on … Track" dot row).
  "racesim.product.trackLine": "Runs on 3 rotating tracks — pick yours next",
  // Product display names key by catalog slug (race-sims/products.ts).
  "racesim.product.sim-single": "1 Race",
  "racesim.product.sim-3-pack": "3-Race Pack",
  "racesim.product.sim-5-pack": "5-Race Pack",
  "racesim.product.single.sub": "One race on the track of your choice.",
  "racesim.product.perRacer": "per racer",
  /** {price} pre-formatted ("$13.33"), {count} = races in the pack. */
  "racesim.product.perRace": "{price}/race · {count} races",
  /** {amount} pre-formatted ("$15") — the amber pack-savings chip. */
  "racesim.product.save": "Save {amount}",
  "racesim.product.selected": "Selected",

  // --- Track step (Track A/B/C, rotating lineup) ---
  "racesim.track.intro": "Three tracks in rotation — a fresh lineup every week or two.",
  "racesim.track.a": "Track A",
  "racesim.track.b": "Track B",
  "racesim.track.c": "Track C",
  "racesim.track.rotates": "Rotating lineup",

  // --- KioskFlow shell lookups (activity label lives in parts/flow.ts) ---
  "stepTitle.raceOptions": "Race Options",
  "stepTitle.track": "Track",
  "stepReason.racesimProduct": "Pick 1 Race or a Race Pack.",
  "stepReason.racesimTrack": "Pick a track.",
} as const;

export const racesimEs: Record<keyof typeof racesimEn, string> = {
  "racesim.tile.name": "Race Sims",
  "racesim.tile.blurb": "Simuladores de carreras profesionales — pistas reales, competencia real.",
  "racesim.tile.comingSoon": "Próximamente",
  "racesim.tile.comingSoonNote": "Los simuladores de carreras ya casi llegan — ¡mantente atento!",

  "racesim.product.intro": "¿Cuántas carreras?",
  "racesim.product.introHelp": "Los precios son por piloto — elige una opción para tu grupo.",
  "racesim.product.sectionMeta": "Todos corren aquí",
  "racesim.product.trackLine": "Corre en 3 pistas rotativas — elige la tuya después",
  "racesim.product.sim-single": "1 carrera",
  "racesim.product.sim-3-pack": "Paquete de 3 carreras",
  "racesim.product.sim-5-pack": "Paquete de 5 carreras",
  "racesim.product.single.sub": "Una carrera en la pista que elijas.",
  "racesim.product.perRacer": "por piloto",
  "racesim.product.perRace": "{price}/carrera · {count} carreras",
  "racesim.product.save": "Ahorra {amount}",
  "racesim.product.selected": "Seleccionado",

  "racesim.track.intro": "Tres pistas en rotación — alineación nueva cada una o dos semanas.",
  "racesim.track.a": "Pista A",
  "racesim.track.b": "Pista B",
  "racesim.track.c": "Pista C",
  "racesim.track.rotates": "Alineación rotativa",

  "stepTitle.raceOptions": "Opciones de carrera",
  "stepTitle.track": "Pista",
  "stepReason.racesimProduct": "Elige 1 carrera o un paquete.",
  "stepReason.racesimTrack": "Elige una pista.",
};
