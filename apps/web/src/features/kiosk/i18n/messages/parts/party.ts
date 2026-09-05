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
  "party.license.onFile": "Licence on file",
  "party.license.needed": "+ {price} licence",
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

  // Linked-family opt-in suggestions + the family picker sheet (Option A, 2026-09-05)
  "party.linked.age": "Age {age}",
  "party.linked.family": "Family",
  "party.linked.tooYoung": " · under 7 — too young to race",
  "party.linked.waiverOnFile": " · waiver on file",
  "party.linked.needsWaiver": " · needs waiver",
  // The pill on a signed-in member's own card — family belongs to the person.
  "party.linked.pill": "{n, plural, one {# family member} other {# family members}}",
  "party.linked.aria": "Add family from {name}’s account",
  "party.linked.eyebrow": "On this account",
  "party.linked.titleRace": "Who’s racing today?",
  "party.linked.titlePlay": "Who’s playing today?",
  "party.linked.selectAll": "Select all",
  "party.linked.clearAll": "Clear all",
  "party.linked.add": "{n, plural, one {Add # player} other {Add # players}}",
  "party.linked.selectPrompt": "Tap everyone who’s joining",
  "party.linked.notToday": "Not today",
  "party.linked.willSign": " · will sign waiver next",

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
  "party.form.checkingAccount": "Checking for your account…",
  "party.form.continueToWaiver": "Continue to waiver",

  // Returning-racer lookup panel
  "party.lookup.title": "Sign in",
  "party.lookup.close": "Close",

  // Waiver overlay (heading/subheading passed to WaiverSigning + cancel)
  "party.waiver.headingRace": "Racing Waiver",
  "party.waiver.headingActivity": "Activity Waiver",
  // Sign-time guardian resolution (mobile /waiver): the minor is registered, now
  // find the adult who signs.
  "party.guardian.eyebrow": "Adult signature needed",
  "party.guardian.heading": "Who signs for {name}?",
  "party.guardian.checking": "Checking {name}…",
  "party.guardian.addNewAdult": "Add a new adult",
  "party.guardian.findAccount": "Find their account",
  "party.guardian.continueToSign": "Continue to waiver",
  "party.guardian.signerOnly": "Signing only — not playing",
  "party.guardian.joinTheFun": "Join the fun",
  "party.gErr.cantVerifyName": "We need a phone or email for {name} before they can sign.",
  "party.gErr.underAge": "{name} is under 18 and can’t sign as a guardian.",
  "party.gErr.verifyAdultFallback": "Couldn’t verify that adult — try another.",
  "party.gErr.enterName": "Enter the adult’s first and last name.",
  "party.gErr.enterDob": "Enter the adult’s birthday as MM/DD/YYYY.",
  "party.gErr.mustBe18": "A guardian must be 18 or older.",
  "party.gErr.enterPhone": "Enter the adult’s mobile number.",
  "party.gErr.accountIsMinor": "That account belongs to a minor — a guardian must be 18 or older.",
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
  "party.license.onFile": "Licencia registrada",
  "party.license.needed": "+ {price} de licencia",
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

  "party.linked.age": "Edad {age}",
  "party.linked.family": "Familia",
  "party.linked.tooYoung": " · menor de 7 — muy pequeño para correr",
  "party.linked.waiverOnFile": " · exención registrada",
  "party.linked.needsWaiver": " · necesita exención",
  "party.linked.pill": "{n, plural, one {# familiar} other {# familiares}}",
  "party.linked.aria": "Agregar familia de la cuenta de {name}",
  "party.linked.eyebrow": "En esta cuenta",
  "party.linked.titleRace": "¿Quién corre hoy?",
  "party.linked.titlePlay": "¿Quién juega hoy?",
  "party.linked.selectAll": "Seleccionar todos",
  "party.linked.clearAll": "Quitar selección",
  "party.linked.add": "{n, plural, one {Agregar # jugador} other {Agregar # jugadores}}",
  "party.linked.selectPrompt": "Toca a todos los que participan",
  "party.linked.notToday": "Hoy no",
  "party.linked.willSign": " · firmará la exención después",

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
  "party.form.checkingAccount": "Buscando tu cuenta…",
  "party.form.continueToWaiver": "Continuar a la exención",

  "party.lookup.title": "Iniciar sesión",
  "party.lookup.close": "Cerrar",

  "party.waiver.headingRace": "Exención de Carreras",
  "party.waiver.headingActivity": "Exención de Actividad",
  "party.guardian.eyebrow": "Se necesita la firma de un adulto",
  "party.guardian.heading": "¿Quién firma por {name}?",
  "party.guardian.checking": "Verificando a {name}…",
  "party.guardian.addNewAdult": "Agregar un adulto nuevo",
  "party.guardian.findAccount": "Buscar su cuenta",
  "party.guardian.continueToSign": "Continuar a la exención",
  "party.guardian.signerOnly": "Solo firma — no va a jugar",
  "party.guardian.joinTheFun": "Únete a la diversión",
  "party.gErr.cantVerifyName":
    "Necesitamos un teléfono o correo de {name} antes de que pueda firmar.",
  "party.gErr.underAge": "{name} es menor de 18 años y no puede firmar como tutor.",
  "party.gErr.verifyAdultFallback": "No pudimos verificar a ese adulto — intenta con otro.",
  "party.gErr.enterName": "Ingresa el nombre y apellido del adulto.",
  "party.gErr.enterDob": "Ingresa la fecha de nacimiento del adulto como MM/DD/YYYY.",
  "party.gErr.mustBe18": "Un tutor debe tener 18 años o más.",
  "party.gErr.enterPhone": "Ingresa el número de celular del adulto.",
  "party.gErr.accountIsMinor":
    "Esa cuenta pertenece a un menor — el tutor debe tener 18 años o más.",
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
