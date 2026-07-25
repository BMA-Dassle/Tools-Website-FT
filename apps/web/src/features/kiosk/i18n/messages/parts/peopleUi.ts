/** Racing/attraction people-step VISIBLE UI (KioskPeopleStep add-people, guardian,
 *  sign-in, waiver chrome) i18n fragment. The validation/error messages already
 *  live in the core catalog under `people.err.*`; this holds the `"peopleUi.*"`
 *  display copy. Add keys to `peopleUiEn`; mirror every key in `peopleUiEs`.
 *  AGE-GATE LOGIC IS NEVER TOUCHED — only display strings are keyed.
 *  Glossary terms stay untranslated: FastTrax, HeadPinz, Game Zone, Podium,
 *  Pit Crew, Duckpin, Mega Tuesday, Starter (also proper nouns Express Lane,
 *  Junior, Blue/Red). */
export const peopleUiEn = {
  // intro
  "peopleUi.introSignedIn":
    "Your group is signed in — everyone here needs an account and a signed waiver.",
  "peopleUi.introAddEveryone":
    "Add everyone playing. Each person gets an account and signs the waiver right here — so check-in is the Express Lane, not a line.",

  // Mega Tuesday junior notice (racing only)
  "peopleUi.megaTuesday": "Mega Tuesday",
  "peopleUi.megaJuniorWarning":
    "First-time Junior racers can’t race today — Juniors must qualify on a split-track (Blue/Red) day first.",

  // block reason banner + license scan progress
  "peopleUi.beforeYouContinue": "Before you continue",
  "peopleUi.checkingLicense": "Checking your license for an account…",

  // roster card
  "peopleUi.aria.addToActivity": "Add {name} to this activity",
  "peopleUi.aria.removeFromActivity": "Remove {name} from this activity",
  "peopleUi.main": "Main",
  "peopleUi.minor": "Minor",
  "peopleUi.starterOnly": "Starter only",
  "peopleUi.credits": "{n, plural, one {# credit} other {# credits}}",
  "peopleUi.accountWaiverReady": "✓ Account & waiver ready",
  "peopleUi.checkingWaiver": "Checking waiver…",
  "peopleUi.waiverNeededMinor": "Waiver needed — a parent/guardian signs",
  "peopleUi.waiverNeeded": "Waiver needed",
  "peopleUi.accountWaiverNeeded": "Account + waiver needed",
  "peopleUi.guardianLabel": "Guardian: {name}",
  "peopleUi.makeMain": "Make main",
  "peopleUi.signWaiver": "Sign waiver",
  "peopleUi.setUp": "Set up",
  "peopleUi.aria.remove": "Remove {name}",
  "peopleUi.remove": "Remove",

  // signer-only guardians section
  "peopleUi.guardiansHeading": "Guardians — signed, not playing",
  "peopleUi.signedFor": "Signed for {names}",
  "peopleUi.waiverOnFile": "Waiver on file",
  "peopleUi.needsOwnWaiver": "Needs own waiver",
  "peopleUi.joinTheFun": "Join the fun",

  // add / sign-in entry points
  "peopleUi.addNewPlayer": "Add a new player",
  "peopleUi.signInFindMyPeople": "Sign in — find my people",

  // linked-family suggestions
  "peopleUi.onThisAccount": "On this account — tap to add",
  "peopleUi.age": "Age {age}",
  "peopleUi.family": "Family",
  "peopleUi.tooYoungSuffix": " · under 7 — too young to race",
  "peopleUi.waiverOnFileSuffix": " · waiver on file",
  "peopleUi.needsWaiverSuffix": " · needs waiver",

  // person form (new OR setup)
  "peopleUi.newPlayer": "New player",
  "peopleUi.firstName": "First name",
  "peopleUi.lastName": "Last name",
  "peopleUi.birthday": "Birthday MM/DD/YYYY",
  "peopleUi.mobilePhone": "Mobile phone",
  "peopleUi.emailConfirmation": "Email (for your confirmation)",
  "peopleUi.emailOptional": "Email (optional)",
  "peopleUi.scanTip": "Tip: scan a driver’s license / state ID to fill this in.",
  "peopleUi.minorHeadsUp":
    "Under 18 — if their waiver needs signing, a parent or guardian signs it next. The adult doesn’t have to play.",
  "peopleUi.cancel": "Cancel",
  "peopleUi.settingUp": "Setting up…",
  "peopleUi.continueToWaiver": "Continue to waiver",

  // returning lookup
  "peopleUi.signIn": "Sign in",
  "peopleUi.close": "Close",

  // guardian resolution overlay
  "peopleUi.thisMinor": "this minor",
  "peopleUi.they": "They",
  "peopleUi.guardianNeeded": "Parent / guardian needed",
  "peopleUi.guardianSignsFor": "A parent or guardian signs for {name}",
  "peopleUi.selectGuardianFor": "Select a guardian for {name} — or add one below",
  "peopleUi.addGuardianFor": "Add a guardian for {name}",
  "peopleUi.guardianExplain":
    "{name} is under 18, so an adult signs the waiver. The adult doesn’t have to play — they won’t be added to the purchase.",
  "peopleUi.tapNameToSelect": "Tap a name to select",
  "peopleUi.checkingTheirWaiver": "Checking their waiver…",
  "peopleUi.cantVerifyHereShort": "Can’t verify here — use Find their account",
  "peopleUi.waiverOnFileTapSign": "Waiver on file — tap to sign",
  "peopleUi.tapToSignOwnFirst": "Tap to sign — their own waiver first",
  "peopleUi.addNewGuardian": "Add a new guardian",
  "peopleUi.findTheirAccount": "Find their account",
  "peopleUi.newAdultGuardian": "New adult — guardian",
  "peopleUi.back": "Back",
  "peopleUi.findTheGuardian": "Find the guardian",
  "peopleUi.backArrow": "← Back",

  // waiver overlay
  "peopleUi.guest": "Guest",
  "peopleUi.racingWaiver": "Racing Waiver",
  "peopleUi.activityWaiver": "Activity Waiver",
  "peopleUi.theMinor": "the minor",
  "peopleUi.waiverSubSigner":
    "{signer} — sign below for {name}. It stays on file for the whole visit.",
  "peopleUi.waiverSubSelf": "Read and sign below — it stays on file for your whole visit.",

  // split-payment warning
  "peopleUi.beforeAddMore": "Before you add more players",
  "peopleUi.onePaymentCoversEveryone": "One payment covers everyone",
  "peopleUi.splitPaymentBody":
    "Payments can’t be split at this kiosk — your whole group checks out together. To split payments, split your party between multiple kiosks.",
  "peopleUi.continueAddingPlayers": "Continue adding players",
  "peopleUi.neverMind": "Never mind",

  // license/member-QR scan outcome notes (setScanNote)
  "peopleUi.scan.alreadySignedIn": "{name} is already signed in.",
  "peopleUi.scan.lookupUnavailable":
    "We couldn’t check for an account just now — let’s set you up here.",
  "peopleUi.scan.codeCheckFailed": "We couldn’t check that code just now — sign in below instead.",
  "peopleUi.scan.codeNotFound":
    "We couldn’t find an account for that code — sign in below instead.",

  // guardian-flow error messages (setGError / thrown Error → shown on screen)
  "peopleUi.gErr.cantVerifyName": "We can’t verify {name} here — use “Find their account”.",
  "peopleUi.gErr.underAge": "{name} is under 18 — a guardian must be an adult.",
  "peopleUi.gErr.verifyAdultFallback":
    "Couldn’t verify that adult. Please try again or see the front desk.",
  "peopleUi.gErr.enterName": "Enter the adult’s first and last name.",
  "peopleUi.gErr.enterDob": "Enter the birthday as MM/DD/YYYY.",
  "peopleUi.gErr.mustBe18": "A guardian must be 18 or older.",
  "peopleUi.gErr.enterPhone": "Enter a mobile phone number.",
  "peopleUi.gErr.setupFailMsg": "Couldn’t set the guardian up: {msg}",
  "peopleUi.gErr.setupFail":
    "Couldn’t set the guardian up. Please try again or see the front desk.",
  "peopleUi.gErr.accountIsMinor": "That account belongs to a minor — a guardian must be an adult.",
  "peopleUi.gErr.verifyAccountMsg": "Couldn’t verify that account: {msg}",
  "peopleUi.gErr.verifyAccountFallback":
    "Couldn’t verify that account. Please try again or see the front desk.",
} as const;

export const peopleUiEs: Record<keyof typeof peopleUiEn, string> = {
  // intro
  "peopleUi.introSignedIn":
    "Tu grupo ha iniciado sesión — todos aquí necesitan una cuenta y una exención firmada.",
  "peopleUi.introAddEveryone":
    "Agrega a todos los que van a jugar. Cada persona obtiene una cuenta y firma la exención aquí mismo — así el registro es el Express Lane, no una fila.",

  // Mega Tuesday junior notice (racing only)
  "peopleUi.megaTuesday": "Mega Tuesday",
  "peopleUi.megaJuniorWarning":
    "Los pilotos Junior por primera vez no pueden correr hoy — los Junior deben clasificar primero en un día de pista dividida (Blue/Red).",

  // block reason banner + license scan progress
  "peopleUi.beforeYouContinue": "Antes de continuar",
  "peopleUi.checkingLicense": "Verificando tu licencia para buscar una cuenta…",

  // roster card
  "peopleUi.aria.addToActivity": "Agregar a {name} a esta actividad",
  "peopleUi.aria.removeFromActivity": "Quitar a {name} de esta actividad",
  "peopleUi.main": "Principal",
  "peopleUi.minor": "Menor",
  "peopleUi.starterOnly": "Solo Starter",
  "peopleUi.credits": "{n, plural, one {# crédito} other {# créditos}}",
  "peopleUi.accountWaiverReady": "✓ Cuenta y exención listas",
  "peopleUi.checkingWaiver": "Verificando exención…",
  "peopleUi.waiverNeededMinor": "Se necesita exención — la firma un padre/tutor",
  "peopleUi.waiverNeeded": "Se necesita exención",
  "peopleUi.accountWaiverNeeded": "Se necesita cuenta + exención",
  "peopleUi.guardianLabel": "Tutor: {name}",
  "peopleUi.makeMain": "Hacer principal",
  "peopleUi.signWaiver": "Firmar exención",
  "peopleUi.setUp": "Configurar",
  "peopleUi.aria.remove": "Quitar a {name}",
  "peopleUi.remove": "Quitar",

  // signer-only guardians section
  "peopleUi.guardiansHeading": "Tutores — firmaron, no juegan",
  "peopleUi.signedFor": "Firmó por {names}",
  "peopleUi.waiverOnFile": "Exención en archivo",
  "peopleUi.needsOwnWaiver": "Necesita su propia exención",
  "peopleUi.joinTheFun": "Únete a la diversión",

  // add / sign-in entry points
  "peopleUi.addNewPlayer": "Agregar un nuevo jugador",
  "peopleUi.signInFindMyPeople": "Iniciar sesión — encontrar a mi gente",

  // linked-family suggestions
  "peopleUi.onThisAccount": "En esta cuenta — toca para agregar",
  "peopleUi.age": "Edad {age}",
  "peopleUi.family": "Familia",
  "peopleUi.tooYoungSuffix": " · menor de 7 — demasiado joven para correr",
  "peopleUi.waiverOnFileSuffix": " · exención en archivo",
  "peopleUi.needsWaiverSuffix": " · necesita exención",

  // person form (new OR setup)
  "peopleUi.newPlayer": "Nuevo jugador",
  "peopleUi.firstName": "Nombre",
  "peopleUi.lastName": "Apellido",
  "peopleUi.birthday": "Fecha de nacimiento MM/DD/AAAA",
  "peopleUi.mobilePhone": "Teléfono móvil",
  "peopleUi.emailConfirmation": "Correo electrónico (para tu confirmación)",
  "peopleUi.emailOptional": "Correo electrónico (opcional)",
  "peopleUi.scanTip":
    "Consejo: escanea una licencia de conducir / identificación estatal para completar esto.",
  "peopleUi.minorHeadsUp":
    "Menor de 18 — si su exención necesita firma, un padre o tutor la firma a continuación. El adulto no tiene que jugar.",
  "peopleUi.cancel": "Cancelar",
  "peopleUi.settingUp": "Configurando…",
  "peopleUi.continueToWaiver": "Continuar a la exención",

  // returning lookup
  "peopleUi.signIn": "Iniciar sesión",
  "peopleUi.close": "Cerrar",

  // guardian resolution overlay
  "peopleUi.thisMinor": "este menor",
  "peopleUi.they": "Esta persona",
  "peopleUi.guardianNeeded": "Se necesita padre / tutor",
  "peopleUi.guardianSignsFor": "Un padre o tutor firma por {name}",
  "peopleUi.selectGuardianFor": "Selecciona un tutor para {name} — o agrega uno abajo",
  "peopleUi.addGuardianFor": "Agrega un tutor para {name}",
  "peopleUi.guardianExplain":
    "{name} es menor de 18, por lo que un adulto firma la exención. El adulto no tiene que jugar — no se agregará a la compra.",
  "peopleUi.tapNameToSelect": "Toca un nombre para seleccionar",
  "peopleUi.checkingTheirWaiver": "Verificando su exención…",
  "peopleUi.cantVerifyHereShort": "No se puede verificar aquí — usa Buscar su cuenta",
  "peopleUi.waiverOnFileTapSign": "Exención en archivo — toca para firmar",
  "peopleUi.tapToSignOwnFirst": "Toca para firmar — primero su propia exención",
  "peopleUi.addNewGuardian": "Agregar un nuevo tutor",
  "peopleUi.findTheirAccount": "Buscar su cuenta",
  "peopleUi.newAdultGuardian": "Nuevo adulto — tutor",
  "peopleUi.back": "Atrás",
  "peopleUi.findTheGuardian": "Buscar al tutor",
  "peopleUi.backArrow": "← Atrás",

  // waiver overlay
  "peopleUi.guest": "Invitado",
  "peopleUi.racingWaiver": "Exención de Carreras",
  "peopleUi.activityWaiver": "Exención de Actividad",
  "peopleUi.theMinor": "el menor",
  "peopleUi.waiverSubSigner":
    "{signer} — firma abajo por {name}. Queda en archivo durante toda la visita.",
  "peopleUi.waiverSubSelf": "Lee y firma abajo — queda en archivo durante toda tu visita.",

  // split-payment warning
  "peopleUi.beforeAddMore": "Antes de agregar más jugadores",
  "peopleUi.onePaymentCoversEveryone": "Un solo pago cubre a todos",
  "peopleUi.splitPaymentBody":
    "Los pagos no se pueden dividir en este kiosco — todo tu grupo paga junto. Para dividir los pagos, reparte tu grupo entre varios kioscos.",
  "peopleUi.continueAddingPlayers": "Continuar agregando jugadores",
  "peopleUi.neverMind": "No importa",

  // license/member-QR scan outcome notes (setScanNote)
  "peopleUi.scan.alreadySignedIn": "{name} ya inició sesión.",
  "peopleUi.scan.lookupUnavailable":
    "No pudimos buscar una cuenta en este momento — vamos a registrarte aquí.",
  "peopleUi.scan.codeCheckFailed":
    "No pudimos verificar ese código en este momento — inicia sesión abajo.",
  "peopleUi.scan.codeNotFound": "No encontramos una cuenta para ese código — inicia sesión abajo.",

  // guardian-flow error messages (setGError / thrown Error → shown on screen)
  "peopleUi.gErr.cantVerifyName": "No podemos verificar a {name} aquí — usa “Buscar su cuenta”.",
  "peopleUi.gErr.underAge": "{name} es menor de 18 — un tutor debe ser un adulto.",
  "peopleUi.gErr.verifyAdultFallback":
    "No se pudo verificar a ese adulto. Inténtalo de nuevo o consulta a la recepción.",
  "peopleUi.gErr.enterName": "Ingresa el nombre y apellido del adulto.",
  "peopleUi.gErr.enterDob": "Ingresa la fecha de nacimiento como MM/DD/AAAA.",
  "peopleUi.gErr.mustBe18": "Un tutor debe tener 18 años o más.",
  "peopleUi.gErr.enterPhone": "Ingresa un número de teléfono móvil.",
  "peopleUi.gErr.setupFailMsg": "No se pudo configurar al tutor: {msg}",
  "peopleUi.gErr.setupFail":
    "No se pudo configurar al tutor. Inténtalo de nuevo o consulta a la recepción.",
  "peopleUi.gErr.accountIsMinor": "Esa cuenta pertenece a un menor — un tutor debe ser un adulto.",
  "peopleUi.gErr.verifyAccountMsg": "No se pudo verificar esa cuenta: {msg}",
  "peopleUi.gErr.verifyAccountFallback":
    "No se pudo verificar esa cuenta. Inténtalo de nuevo o consulta a la recepción.",
};
