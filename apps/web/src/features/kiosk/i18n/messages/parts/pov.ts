/** POV race-video i18n fragment — the video-only upsell step (RacePovStep) and
 *  the cart's POV row controls. Add `"pov.*"` keys; mirror every key in es.
 *
 *  es values are a first-pass AI translation pending native-Spanish review. Per
 *  the locked glossary, "POV", "ViewPoint" and FastTrax stay untranslated.
 *  {price}/{amount} are pre-formatted "$X.XX" strings built in the component
 *  (prices come from race-pricing constants, never hardcoded into copy);
 *  {count} interpolates. */
export const povEn = {
  "stepTitle.raceVideo": "Race Video",

  // --- Step header ---
  "pov.eyebrow": "Race Add-On",
  "pov.title": "Take The Race Home",
  "pov.save": "Save {amount} per camera when you add it now",

  // --- Product pitch ---
  "pov.productName": "ViewPoint POV Camera",
  "pov.description":
    "Relive every turn, overtake, and adrenaline-fueled moment from your kart's perspective. Your footage is ready to download after your race — perfect for sharing on social media.",
  "pov.perPerson": "/person",
  "pov.atCheckin": "{price} at check-in",
  "pov.coveredNote":
    "{count, plural, one {Your package already includes the race video for # racer.} other {Your package already includes the race video for # racers.}}",

  // --- Qty offer ---
  "pov.addForAll":
    "{count, plural, one {Add for # racer — {amount}} other {Add for all # racers — {amount}}}",
  "pov.noThanks": "No thanks — continue without the camera",
  "pov.cameraCount": "{count, plural, one {# camera} other {# cameras}}",
  "pov.setToAll": "{count, plural, one {Set to # racer} other {Set to all # racers}}",
  "pov.decrementAria": "Remove one camera",
  "pov.incrementAria": "Add one camera",
  "pov.maxHint": "Max {count} — one per racer",

  // --- Cart row + controls ---
  "pov.cart.rowLabel": "POV Race Video × {count}",
  "pov.cart.change": "Change",
  "pov.cart.remove": "Remove video",
} as const;

export const povEs: Record<keyof typeof povEn, string> = {
  "stepTitle.raceVideo": "Video de carrera",

  // --- Encabezado del paso ---
  "pov.eyebrow": "Complemento de carrera",
  "pov.title": "Llévate la carrera a casa",
  "pov.save": "Ahorra {amount} por cámara si lo agregas ahora",

  // --- Presentación del producto ---
  "pov.productName": "Cámara POV ViewPoint",
  "pov.description":
    "Revive cada curva, cada rebase y cada momento de adrenalina desde la perspectiva de tu kart. Tu video queda listo para descargar después de la carrera — perfecto para compartir en redes sociales.",
  "pov.perPerson": "/persona",
  "pov.atCheckin": "{price} al registrarte",
  "pov.coveredNote":
    "{count, plural, one {Tu paquete ya incluye el video de carrera para # corredor.} other {Tu paquete ya incluye el video de carrera para # corredores.}}",

  // --- Selección de cantidad ---
  "pov.addForAll":
    "{count, plural, one {Agregar para # corredor — {amount}} other {Agregar para los # corredores — {amount}}}",
  "pov.noThanks": "No, gracias — continuar sin la cámara",
  "pov.cameraCount": "{count, plural, one {# cámara} other {# cámaras}}",
  "pov.setToAll":
    "{count, plural, one {Poner para # corredor} other {Poner para los # corredores}}",
  "pov.decrementAria": "Quitar una cámara",
  "pov.incrementAria": "Agregar una cámara",
  "pov.maxHint": "Máx. {count} — uno por corredor",

  // --- Fila del carrito + controles ---
  "pov.cart.rowLabel": "Video POV de carrera × {count}",
  "pov.cart.change": "Cambiar",
  "pov.cart.remove": "Quitar video",
};
