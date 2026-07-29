/** Party manager (KioskPartyManager) i18n fragment. Add `"party.*"` keys; mirror
 *  every key in es. First-pass AI translation pending native review.
 *
 *  Glossary nouns left untranslated in every locale: FastTrax, HeadPinz, Game
 *  Zone, Podium, Pit Crew, Duckpin (and "Express Lane" / the MM/DD/YYYY input
 *  token, which the DOB parser enforces positionally). `peopleReady()` block
 *  reasons run at module scope (shared with canAdvance + checkin/server.ts), so
 *  they stay English with a TODO(i18n) in the component. */
export const partyEn = {
  // Intro line (roster present vs. empty)
  "party.intro.signedIn":
    "Your group is signed in — everyone here needs an account and a signed waiver.",
  "party.intro.empty":
    "Add everyone playing. Each person gets an account and signs the waiver right here — so check-in is the Express Lane, not a line.",

  // "Before you continue" block banner (reason itself is module-scope English)
  "party.beforeContinue": "Before you continue",

  // Driver's-license scan progress / outcome + in-form tip
  "party.license.checking": "Checking your license for an account…",
  "party.license.checkFail": "We couldn’t check for an account just now — let’s set you up here.",
  "party.license.tip": "Tip: scan a driver’s license / state ID to fill this in.",

  // Attraction include toggle (aria)
  "party.member.aria.removeFromActivity": "Remove {name} from this activity",
  "party.member.aria.addToActivity": "Add {name} to this activity",

  // Member-card badges + status
  "party.badge.main": "Main",
  "party.badge.minor": "Minor",
  // Race tier badge — "Starter" is the tier name (product data); only "only" is prose.
  "party.badge.starterOnly": "Starter only",
  "party.credits": "{n, plural, one {# credit} other {# credits}}",
  "party.status.ready": "Account & waiver ready",
  "party.status.checkingWaiver": "Checking waiver…",
  "party.status.waiverNeeded": "Waiver needed",
  "party.status.accountWaiverNeeded": "Account + waiver needed",
  "party.guardianLabel": "Guardian: {name}",
  "party.makeMain": "Make main",
  "party.signWaiver": "Sign waiver",
  "party.setUp": "Set up",
  "party.guardianBadge": "Guardian",
  "party.guardianBadge.title": "Guardian for a minor in your group — remove the minor first",
  "party.aria.remove": "Remove {name}",
  "party.remove": "Remove",

  // Add / sign-in entry points
  "party.addNewPlayer": "Add a new player",
  "party.signInFindPeople": "Sign in — find my people",

  // Linked-family opt-in suggestions
  "party.linked.heading": "On this account — tap to add",
  "party.linked.age": "Age {age}",
  "party.linked.family": "Family",
  "party.linked.tooYoung": " · under 7 — too young to race",
  "party.linked.waiverOnFile": " · waiver on file",
  "party.linked.needsWaiver": " · needs waiver",

  // Person form (new / setup)
  "party.form.newPlayer": "New player",
  "party.form.setUpName": "Set up {name}",
  "party.form.firstName": "First name",
  "party.form.lastName": "Last name",
  "party.form.birthday": "Birthday MM/DD/YYYY",
  "party.form.mobilePhone": "Mobile phone",
  "party.form.emailMain": "Email (for your confirmation)",
  "party.form.emailOptional": "Email (optional)",
  "party.form.guardianPrompt": "Responsible guardian (a registered adult):",
  "party.form.guardianLegalNote":
    "Must be this minor’s parent or legal guardian. Under Florida Statute § 831.01, misrepresenting yourself as a minor’s guardian is a criminal offense.",
  "party.form.cancel": "Cancel",
  "party.form.settingUp": "Setting up…",
  "party.form.continueToWaiver": "Continue to waiver",

  // Returning-racer lookup panel
  "party.lookup.title": "Sign in",
  "party.lookup.close": "Close",

  // Waiver overlay (heading/subheading passed to WaiverSigning + cancel)
  "party.waiver.headingRace": "Racing Waiver",
  "party.waiver.headingActivity": "Activity Waiver",
  "party.waiver.subheading": "Read and sign below — it stays on file for your whole visit.",
  // Guardian signs for a minor (mobile /waiver flow): who signs, and for whom.
  "party.waiver.subheadingGuardian":
    "{signer} — sign below for {minor}. It stays on file for the whole visit.",
  "party.waiver.theMinor": "the minor",
  "party.waiver.cancelLater": "Cancel — sign later",
  "party.guest": "Guest",

  // Form / handler error messages
  "party.err.name": "Enter a first and last name.",
  "party.err.dob": "Enter the birthday as MM/DD/YYYY.",
  "party.err.tooYoung":
    "{name} is under 7 — too young to race. Kids under 7 are welcome trackside, or check out Duckpin bowling.",
  "party.thisRacer": "This racer",
  "party.err.phone": "Enter a mobile phone number.",
  "party.err.emailMain": "The main person needs an email for the confirmation.",
  "party.err.needAdult": "Add an adult to the group first — a minor needs a guardian.",
  "party.err.pickGuardian": "Pick this minor’s guardian.",
  "party.err.setupFailMsg": "Couldn’t set that person up: {msg}",
  "party.err.setupFail": "Couldn’t set that person up. Please try again or see the front desk.",
  "party.err.finishFailMsg": "Couldn’t finish setup: {msg}",
  "party.err.finishFail": "Couldn’t finish setup. Please try again or see the front desk.",
  "party.err.alreadySignedIn": "{name} is already signed in.",
  "party.err.licenseMismatch":
    "That license doesn’t look like {name}’s — enter their birthday instead.",
  "party.member.checkCodeFail": "We couldn’t check that code just now — sign in below instead.",
  "party.member.codeNotFound": "We couldn’t find an account for that code — sign in below instead.",
} as const;

export const partyEs: Record<keyof typeof partyEn, string> = {
  "party.intro.signedIn":
    "Tu grupo ya inició sesión — cada persona aquí necesita una cuenta y una exención firmada.",
  "party.intro.empty":
    "Agrega a todos los que van a jugar. Cada persona obtiene una cuenta y firma la exención aquí mismo — así el registro es el Express Lane, no una fila.",

  "party.beforeContinue": "Antes de continuar",

  "party.license.checking": "Revisando tu licencia para encontrar una cuenta…",
  "party.license.checkFail": "No pudimos buscar una cuenta ahora mismo — vamos a registrarte aquí.",
  "party.license.tip":
    "Consejo: escanea una licencia de conducir / identificación estatal para llenar esto.",

  "party.member.aria.removeFromActivity": "Quitar a {name} de esta actividad",
  "party.member.aria.addToActivity": "Agregar a {name} a esta actividad",

  "party.badge.main": "Principal",
  "party.badge.minor": "Menor",
  "party.badge.starterOnly": "Solo Starter",
  "party.credits": "{n, plural, one {# crédito} other {# créditos}}",
  "party.status.ready": "Cuenta y exención listas",
  "party.status.checkingWaiver": "Revisando exención…",
  "party.status.waiverNeeded": "Falta la exención",
  "party.status.accountWaiverNeeded": "Falta cuenta + exención",
  "party.guardianLabel": "Tutor: {name}",
  "party.makeMain": "Hacer principal",
  "party.signWaiver": "Firmar exención",
  "party.setUp": "Registrar",
  "party.guardianBadge": "Tutor",
  "party.guardianBadge.title": "Tutor de un menor en tu grupo — quita primero al menor",
  "party.aria.remove": "Quitar a {name}",
  "party.remove": "Quitar",

  "party.addNewPlayer": "Agregar un nuevo jugador",
  "party.signInFindPeople": "Inicia sesión — encuentra a tu gente",

  "party.linked.heading": "En esta cuenta — toca para agregar",
  "party.linked.age": "Edad {age}",
  "party.linked.family": "Familia",
  "party.linked.tooYoung": " · menor de 7 — muy pequeño para correr",
  "party.linked.waiverOnFile": " · exención registrada",
  "party.linked.needsWaiver": " · necesita exención",

  "party.form.newPlayer": "Nuevo jugador",
  "party.form.setUpName": "Registrar a {name}",
  "party.form.firstName": "Nombre",
  "party.form.lastName": "Apellido",
  "party.form.birthday": "Fecha de nacimiento MM/DD/YYYY",
  "party.form.mobilePhone": "Teléfono móvil",
  "party.form.emailMain": "Correo electrónico (para tu confirmación)",
  "party.form.emailOptional": "Correo electrónico (opcional)",
  "party.form.guardianPrompt": "Tutor responsable (un adulto registrado):",
  "party.form.guardianLegalNote":
    "Debe ser el padre, la madre o el tutor legal de este menor. Conforme a la Ley de Florida § 831.01, declarar falsamente que usted es el tutor de un menor constituye un delito.",
  "party.form.cancel": "Cancelar",
  "party.form.settingUp": "Registrando…",
  "party.form.continueToWaiver": "Continuar a la exención",

  "party.lookup.title": "Iniciar sesión",
  "party.lookup.close": "Cerrar",

  "party.waiver.headingRace": "Exención de Carreras",
  "party.waiver.headingActivity": "Exención de Actividad",
  "party.waiver.subheading": "Lee y firma abajo — queda registrada durante toda tu visita.",
  "party.waiver.subheadingGuardian":
    "{signer} — firma abajo por {minor}. Queda registrada durante toda la visita.",
  "party.waiver.theMinor": "el menor",
  "party.waiver.cancelLater": "Cancelar — firmar después",
  "party.guest": "Invitado",

  "party.err.name": "Ingresa un nombre y apellido.",
  "party.err.dob": "Ingresa la fecha de nacimiento como MM/DD/YYYY.",
  "party.err.tooYoung":
    "{name} es menor de 7 — muy pequeño para correr. Los niños menores de 7 son bienvenidos junto a la pista, o prueba el boliche Duckpin.",
  "party.thisRacer": "Este corredor",
  "party.err.phone": "Ingresa un número de teléfono móvil.",
  "party.err.emailMain":
    "La persona principal necesita un correo electrónico para la confirmación.",
  "party.err.needAdult": "Agrega primero un adulto al grupo — un menor necesita un tutor.",
  "party.err.pickGuardian": "Elige el tutor de este menor.",
  "party.err.setupFailMsg": "No pudimos registrar a esa persona: {msg}",
  "party.err.setupFail":
    "No pudimos registrar a esa persona. Inténtalo de nuevo o acude a la recepción.",
  "party.err.finishFailMsg": "No pudimos completar el registro: {msg}",
  "party.err.finishFail":
    "No pudimos completar el registro. Inténtalo de nuevo o acude a la recepción.",
  "party.err.alreadySignedIn": "{name} ya inició sesión.",
  "party.err.licenseMismatch":
    "Esa licencia no parece ser de {name} — ingresa su fecha de nacimiento en su lugar.",
  "party.member.checkCodeFail": "No pudimos revisar ese código ahora mismo — inicia sesión abajo.",
  "party.member.codeNotFound": "No encontramos una cuenta para ese código — inicia sesión abajo.",
};
