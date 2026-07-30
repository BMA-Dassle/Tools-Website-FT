/**
 * Game Zone card buy/reload flow (KioskGameZone) i18n fragment.
 *
 * Own file so screen conversions never collide on the core en.ts/es.ts. Add
 * `"gamezone.*"` keys to `gamezoneEn`; mirror EVERY key in `gamezoneEs` (the
 * Record type makes a gap a compile error). es values are a first-pass AI
 * translation pending native-Spanish review. "Game Zone" stays untranslated
 * (locked glossary); so do "eTickets" (product term) and card numbers/prices/
 * balances (server-supplied, passed through as params).
 */
export const gamezoneEn = {
  // --- Comp-voucher redemption (BMI "Complimentary N Token Game Card") ---
  // A comp is free play, so the copy never says "paid" or shows a price. The
  // grant ("100 bonus tokens") is server-derived and passed through as a param.
  "gamezone.chooser.voucher.title": "Redeem a voucher",
  "gamezone.chooser.voucher.sub": "Free game card — scan your voucher code",
  "gamezone.voucher.title": "Redeem a voucher",
  "gamezone.voucher.scanTitle": "Scan your voucher",
  "gamezone.voucher.scanBody":
    "Hold the voucher under the scanner. Your free game card comes out right here.",
  "gamezone.voucher.scanLabel": "Scan the voucher",
  "gamezone.voucher.scanSub": "or type the code below",
  "gamezone.voucher.inputLabel": "Voucher code",
  "gamezone.voucher.placeholder": "Voucher code",
  "gamezone.voucher.redeem": "Redeem",
  "gamezone.voucher.add": "Add",
  "gamezone.voucher.scanMoreTitle": "Got another one?",
  "gamezone.voucher.getCard": "Get my card",
  "gamezone.voucher.getCards": "Get my {n} cards",
  "gamezone.voucher.dispensingN": "Card {n} of {total}…",
  "gamezone.voucher.loadedOk": "Loaded",
  "gamezone.voucher.notIssued": "Not issued",
  "gamezone.voucher.done.bodyN":
    "{n, plural, one {Your card is loaded and ready.} other {Your # cards are loaded and ready.}}",
  "gamezone.voucher.err.alreadyAdded": "That voucher is already on the list.",
  "gamezone.voucher.err.tooMany": "That’s the most we can do at once ({n}).",
  "gamezone.voucher.checking": "Checking your voucher…",
  "gamezone.voucher.checkingSub": "one moment",
  "gamezone.voucher.dispensing": "Getting your card…",
  "gamezone.voucher.loading": "Loading your card…",
  "gamezone.voucher.takeCard": "Take your card",
  "gamezone.voucher.done.title": "Enjoy!",
  "gamezone.voucher.done.body": "Your card is loaded with {grant}.",
  "gamezone.voucher.error.title": "We couldn’t finish that",
  // Refusals — each says what to do next, because nobody is standing here.
  "gamezone.voucher.err.badFormat": "That doesn’t look like a voucher code — check and try again.",
  "gamezone.voucher.err.unknown": "That voucher isn’t valid or has expired.",
  "gamezone.voucher.err.voided": "That voucher was cancelled — please see Guest Services.",
  "gamezone.voucher.err.expired": "That voucher has expired.",
  "gamezone.voucher.err.notRedeemable":
    "That voucher isn’t for a game card — take it to Guest Services to use it.",
  "gamezone.voucher.err.unverifiable":
    "We couldn’t check that voucher right now — please see Guest Services.",
  "gamezone.voucher.err.unsupported":
    "That voucher isn’t for a game card — please see Guest Services.",
  "gamezone.voucher.err.multiItem":
    "That voucher covers more than one thing — please see Guest Services to redeem it.",
  "gamezone.voucher.err.used": "That voucher has already been used.",
  "gamezone.voucher.err.generic": "Something went wrong — please see Guest Services.",

  // --- Shared chrome / units ---
  "gamezone.back": "Back",
  "gamezone.cancel": "Cancel",
  "gamezone.done": "Done",
  "gamezone.edit": "Edit",
  "gamezone.remove": "Remove",
  "gamezone.check": "Check",
  "gamezone.tryAgain": "Try again",
  "gamezone.addAnotherCard": "+ Add another card",
  "gamezone.addToVisit": "Add to my visit",
  "gamezone.tokensUnit": "tokens",
  "gamezone.bonusUnit": "bonus",
  "gamezone.freeBonus": "+{n} free",
  "gamezone.tkAbbrev": "tk",
  "gamezone.cardN": "Card {n}",
  "gamezone.card": "Card {ref}",
  "gamezone.cardHash": "Card #{num}",
  "gamezone.stat.tokens": "Tokens",
  "gamezone.stat.bonusTokens": "Bonus tokens",
  "gamezone.stat.eTickets": "eTickets",
  "gamezone.stat.timePlay": "Time play (min)",

  // --- Insert / take card prompts ---
  "gamezone.insertCard": "Insert your card",
  "gamezone.insertCard.subLeft":
    "Use the card slot on the left — it reads in a second and comes right back out",
  "gamezone.insertCard.subLeftShort":
    "Use the card slot on the left — it reads in a second and comes right back",
  "gamezone.insertCard.subShort": "It reads in a second and comes right back out",
  "gamezone.takeYourCard": "Take your card",
  "gamezone.takeYourCard.sub": "It’s coming back out now",

  // --- Attendant fallbacks ---
  "gamezone.seeAttendant": "Please see an attendant.",
  "gamezone.seeAttendantSafe": "Your payment is safe — please see an attendant.",

  // --- Dispenser unavailable ---
  "gamezone.unavailable.title": "Game Zone is temporarily unavailable",
  "gamezone.unavailable.body":
    "The card machine is offline right now, so we can’t sell or reload cards here. Please see an attendant — they can help at the front desk.",

  // --- Connecting loaders ---
  "gamezone.connecting.label": "Connecting to the card dispenser…",
  "gamezone.connecting.sub": "One moment",
  "gamezone.connectingReader": "Connecting to the card reader…",

  // --- Mode chooser ---
  "gamezone.chooser.title": "Game Zone cards",
  "gamezone.chooser.new.title": "New Game Zone cards",
  "gamezone.chooser.new.unavailable":
    "Not available at this kiosk — new Game Zone cards can be purchased at the front kiosk or at Guest Services",
  "gamezone.chooser.new.ready": "Set up 1–10 fresh cards — pick a token package for each",
  "gamezone.chooser.new.offline": "Card dispenser unavailable — see an attendant",
  "gamezone.chooser.reload.title": "Reload existing cards",
  "gamezone.chooser.reload.sub": "Add tokens to 1–10 cards you already have",
  "gamezone.chooser.balance.title": "Check card balance",
  "gamezone.chooser.balance.subSwipe": "Swipe a card to see its tokens, bonus tokens & eTickets",
  "gamezone.chooser.balance.subInsert": "Insert a card to see its tokens, bonus tokens & eTickets",
  "gamezone.combineCards": "Combine cards",
  "gamezone.chooser.combine.sub": "Move the tokens from several cards onto one card to keep",

  // --- Combine cards (consolidate) ---
  "gamezone.conso.step1": "Step 1 of 2",
  "gamezone.conso.step2": "Step 2 of 2",
  "gamezone.conso.insertKeep.title": "Insert the card you want to keep",
  "gamezone.conso.insertKeep.body":
    "This is the card you’ll walk away with — every other card’s tokens move onto it.",
  "gamezone.conso.reading.label": "Reading your card…",
  "gamezone.conso.reading.sub": "Coming right back out",
  "gamezone.conso.keeping": "Keeping this card",
  "gamezone.conso.addTitle": "Add cards to combine",
  "gamezone.conso.addBody": "Insert each card one at a time — its tokens move onto your kept card.",
  "gamezone.conso.notWorking": "Combining isn’t working right now",
  "gamezone.conso.combining.label": "Combining…",
  "gamezone.conso.combining.sub": "Moving the tokens over",
  "gamezone.conso.insertCombine.label": "Insert a card to combine",
  "gamezone.conso.insertCombine.sub": "One card at a time — tap Done when you’re finished",
  "gamezone.conso.combinedIn": "Combined in ({count})",
  "gamezone.conso.sourceRow": "{num}. Card {ref}",
  "gamezone.conso.done.finished": "Done — I’m finished",
  "gamezone.conso.allSet": "All set — your tokens are on the card you kept.",
  "gamezone.conso.cardsCombined": "{count, plural, one {# card combined} other {# cards combined}}",
  "gamezone.conso.sameCard":
    "That’s the card you’re keeping (or already combined) — insert a different one.",
  "gamezone.conso.declined": "That card couldn’t be combined — your card is back.",
  "gamezone.conso.serviceError": "Combine service error (HTTP {status})",
  "gamezone.conso.timeout": "The combine service didn’t answer in time.",
  "gamezone.conso.unreachable": "Couldn’t reach the combine service.",

  // --- Loading / dispense progress ---
  "gamezone.processingPayment": "Processing payment…",
  "gamezone.dispensingCardN": "Dispensing card {n} of {total}…",
  "gamezone.loadingOntoCard": "Loading tokens onto card {n}…",
  "gamezone.takeCardN": "Take card {n}…",
  "gamezone.settingUp":
    "{count, plural, one {Setting up your card…} other {Setting up your cards…}}",
  "gamezone.status.loaded": "Loaded ✓",
  "gamezone.status.seeAttendant": "See attendant",
  "gamezone.status.dispensing": "Dispensing…",
  "gamezone.status.loadingTokens": "Loading tokens…",
  "gamezone.status.waiting": "Waiting…",
  "gamezone.loadingTokens.label": "Loading your tokens…",
  "gamezone.loadingTokens.sub": "Charging once, loading each card",

  // --- Done screens ---
  "gamezone.cardsReady": "{count, plural, one {Card ready!} other {Cards ready!}}",
  "gamezone.tokensAcross": "{tokens} tokens across {count, plural, one {# card} other {# cards}}.",
  "gamezone.grabCards":
    "{count, plural, one {Grab your card from the dispenser — tap in at the games.} other {Grab your cards from the dispenser — tap in at the games.}}",
  "gamezone.closingIn": "Closing automatically in {seconds}s",
  "gamezone.paymentReceived": "Payment received!",
  "gamezone.tokensLoaded": "Tokens loaded!",
  "gamezone.reloadPendingBody":
    "Your tokens may take a minute to appear — if your balance looks off, see an attendant.",
  "gamezone.cardsReadyBody":
    "{count, plural, one {Your card is ready — tap in at the games.} other {All # cards are ready — tap in at the games.}}",

  // --- Error banners ---
  "gamezone.err.paymentFailedDesk": "Payment failed. Please see the front desk.",
  "gamezone.err.paymentFailedRetry": "Payment failed. Please try again or see the front desk.",
  "gamezone.err.cleanRead": "Couldn’t get a clean read from the dispenser.",
  "gamezone.err.cardRetained": "A card couldn’t be loaded and was retained.",
  "gamezone.err.reloadFailedDesk": "Reload failed. Please see the front desk.",
  "gamezone.err.reloadFailedRetry": "Reload failed. Please try again or see the front desk.",
  "gamezone.err.startReader": "Couldn’t start the reader payment.",
  "gamezone.err.sessionExpired": "Payment session expired. Please see the front desk.",
  "gamezone.err.paidNotFinished":
    "We received your payment but couldn’t finish — please see the front desk (do not pay again).",

  // --- Balance check ---
  "gamezone.balance.title": "Card balance",
  "gamezone.checkingBalance": "Checking balance…",
  "gamezone.balance.recentActivity": "Recent activity",
  "gamezone.txn.activity": "Activity",
  "gamezone.balance.checkAnother": "Check another card",
  "gamezone.balance.reloadThis": "Reload this card",
  "gamezone.balance.notFoundSwipe": "We couldn’t find that card — try swiping it again.",
  "gamezone.balance.notFoundInsert": "We couldn’t find that card — try inserting it again.",
  "gamezone.blockedFlip": "Couldn’t read — flip the card & tap to try again",
  "gamezone.balance.insertToCheck": "Insert your card to check it",
  "gamezone.balance.swipeToCheck": "Swipe your card to check it",
  "gamezone.badSwipe": "Couldn’t read that swipe — flip the card and swipe again, slow and steady.",
  "gamezone.cardNumberPlaceholder": "Card number",

  // --- Reload / new-card carts ---
  "gamezone.reload.title": "Reload game cards",
  "gamezone.newCards.title": "New cards",
  "gamezone.newCards.intro":
    "Add a card for everyone in your group and pick each one’s token package. One payment covers them all.",
  "gamezone.reload.intro.insert":
    "Add each card and pick its token package — insert each card to read it. One payment covers them all.",
  "gamezone.reload.intro.swipe":
    "Add each card and pick its token package — swipe each card on the reader. One payment covers them all.",
  "gamezone.reload.intro.type":
    "Add each card and pick its token package — scan the barcode or type the number. One payment covers them all.",
  "gamezone.newCards.activationNote": "includes {price} activation per card",
  "gamezone.payDispense": "Pay & dispense",
  "gamezone.payLoad": "Pay & load",
  "gamezone.newCards.checkoutNote":
    "Cards are paid with your booking at checkout and dispense on the confirmation screen.",
  "gamezone.reload.checkoutNote":
    "Tokens are paid with your booking at checkout and load right after payment.",
  "gamezone.dispenserOffline.new":
    "Card dispenser is offline — please see an attendant to buy new cards.",
  "gamezone.dispenserOutOfCards": "The card dispenser is out of cards — please see an attendant.",
  "gamezone.payTakeEach": "Pay, then take each card as it’s dispensed.",
  "gamezone.reload.insertHold": "Insert your card…",
  "gamezone.reload.insertDifferent": "Insert a different card",
  "gamezone.reload.insertToRead": "Insert card to read",
  "gamezone.checkingCard": "Checking your card…",
  "gamezone.msr.replaceCard": "Card #{num} — swipe a different card to replace it",
  "gamezone.swipeOnReader": "Swipe your card on the reader",
  "gamezone.balanceTokens": "balance {n} tokens",
  "gamezone.notFoundSwipe": "Card not found — try swiping it again.",
  "gamezone.notFoundNumber": "Card not found — check the number.",
  "gamezone.noCardNumber": "No card number",
  "gamezone.needsCheck": "needs check",
  "gamezone.cardNumberScanType": "Card number (scan or type)",
  "gamezone.checkEachToContinue": "Check each card number to continue.",

  // --- Payment screen ---
  "gamezone.pay": "Pay {amount}",
  "gamezone.payCount": "{count, plural, one {# card} other {# cards}}",
  "gamezone.paySubNew": "cards dispense once payment clears",
  "gamezone.paySubReload": "tokens load the moment payment clears",
} as const;

export const gamezoneEs: Record<keyof typeof gamezoneEn, string> = {
  // --- Canje de vale (comp) ---
  "gamezone.chooser.voucher.title": "Canjear un vale",
  "gamezone.chooser.voucher.sub": "Tarjeta de juego gratis — escanea el código de tu vale",
  "gamezone.voucher.title": "Canjear un vale",
  "gamezone.voucher.scanTitle": "Escanea tu vale",
  "gamezone.voucher.scanBody":
    "Coloca el vale bajo el escáner. Tu tarjeta de juego gratis sale aquí mismo.",
  "gamezone.voucher.scanLabel": "Escanea el vale",
  "gamezone.voucher.scanSub": "o escribe el código abajo",
  "gamezone.voucher.inputLabel": "Código del vale",
  "gamezone.voucher.placeholder": "Código del vale",
  "gamezone.voucher.redeem": "Canjear",
  "gamezone.voucher.add": "Agregar",
  "gamezone.voucher.scanMoreTitle": "¿Tienes otro?",
  "gamezone.voucher.getCard": "Obtener mi tarjeta",
  "gamezone.voucher.getCards": "Obtener mis {n} tarjetas",
  "gamezone.voucher.dispensingN": "Imprimiendo tarjeta {n} de {total}…",
  "gamezone.voucher.loadedOk": "Cargada",
  "gamezone.voucher.notIssued": "No emitida",
  "gamezone.voucher.done.bodyN":
    "{n, plural, one {Tu tarjeta está cargada y lista.} other {Tus # tarjetas están cargadas y listas.}}",
  "gamezone.voucher.err.alreadyAdded": "Ese vale ya está en la lista.",
  "gamezone.voucher.err.tooMany": "Ese es el máximo a la vez ({n}).",
  "gamezone.voucher.checking": "Verificando tu vale…",
  "gamezone.voucher.checkingSub": "un momento",
  "gamezone.voucher.dispensing": "Imprimiendo tu tarjeta…",
  "gamezone.voucher.loading": "Cargando tu tarjeta…",
  "gamezone.voucher.takeCard": "Toma tu tarjeta",
  "gamezone.voucher.done.title": "¡Que lo disfrutes!",
  "gamezone.voucher.done.body": "Tu tarjeta está cargada con {grant}.",
  "gamezone.voucher.error.title": "No pudimos completarlo",
  "gamezone.voucher.err.badFormat":
    "Eso no parece un código de vale — revísalo e inténtalo de nuevo.",
  "gamezone.voucher.err.unknown": "Ese vale no es válido o ya venció.",
  "gamezone.voucher.err.voided": "Ese vale fue cancelado — acude a Servicio al Cliente.",
  "gamezone.voucher.err.expired": "Ese vale ya venció.",
  "gamezone.voucher.err.notRedeemable":
    "Ese vale no es para una tarjeta de juego — llévalo a Servicio al Cliente para usarlo.",
  "gamezone.voucher.err.unverifiable":
    "No pudimos verificar ese vale en este momento — acude a Servicio al Cliente.",
  "gamezone.voucher.err.unsupported":
    "Ese vale no es para una tarjeta de juego — acude a Servicio al Cliente.",
  "gamezone.voucher.err.multiItem":
    "Ese vale cubre más de una cosa — acude a Servicio al Cliente para canjearlo.",
  "gamezone.voucher.err.used": "Ese vale ya fue utilizado.",
  "gamezone.voucher.err.generic": "Algo salió mal — acude a Servicio al Cliente.",

  // --- Shared chrome / units ---
  "gamezone.back": "Atrás",
  "gamezone.cancel": "Cancelar",
  "gamezone.done": "Listo",
  "gamezone.edit": "Editar",
  "gamezone.remove": "Quitar",
  "gamezone.check": "Verificar",
  "gamezone.tryAgain": "Intentar de nuevo",
  "gamezone.addAnotherCard": "+ Agregar otra tarjeta",
  "gamezone.addToVisit": "Agregar a mi visita",
  "gamezone.tokensUnit": "fichas",
  "gamezone.bonusUnit": "de bono",
  "gamezone.freeBonus": "+{n} gratis",
  "gamezone.tkAbbrev": "fi",
  "gamezone.cardN": "Tarjeta {n}",
  "gamezone.card": "Tarjeta {ref}",
  "gamezone.cardHash": "Tarjeta #{num}",
  "gamezone.stat.tokens": "Fichas",
  "gamezone.stat.bonusTokens": "Fichas de bono",
  "gamezone.stat.eTickets": "eTickets",
  "gamezone.stat.timePlay": "Tiempo de juego (min)",

  // --- Insert / take card prompts ---
  "gamezone.insertCard": "Inserta tu tarjeta",
  "gamezone.insertCard.subLeft":
    "Usa la ranura de tarjetas a la izquierda — se lee en un segundo y sale de vuelta",
  "gamezone.insertCard.subLeftShort":
    "Usa la ranura de tarjetas a la izquierda — se lee en un segundo y sale de vuelta",
  "gamezone.insertCard.subShort": "Se lee en un segundo y sale de vuelta enseguida",
  "gamezone.takeYourCard": "Toma tu tarjeta",
  "gamezone.takeYourCard.sub": "Está saliendo ahora",

  // --- Attendant fallbacks ---
  "gamezone.seeAttendant": "Por favor, consulta a un encargado.",
  "gamezone.seeAttendantSafe": "Tu pago está seguro — por favor, consulta a un encargado.",

  // --- Dispenser unavailable ---
  "gamezone.unavailable.title": "Game Zone no está disponible temporalmente",
  "gamezone.unavailable.body":
    "La máquina de tarjetas está fuera de servicio en este momento, así que no podemos vender ni recargar tarjetas aquí. Por favor, consulta a un encargado — te pueden ayudar en la recepción.",

  // --- Connecting loaders ---
  "gamezone.connecting.label": "Conectando con el dispensador de tarjetas…",
  "gamezone.connecting.sub": "Un momento",
  "gamezone.connectingReader": "Conectando con el lector de tarjetas…",

  // --- Mode chooser ---
  "gamezone.chooser.title": "Tarjetas Game Zone",
  "gamezone.chooser.new.title": "Tarjetas Game Zone nuevas",
  "gamezone.chooser.new.unavailable":
    "No disponible en este kiosco — las tarjetas Game Zone nuevas se pueden comprar en el kiosco principal o en Atención al Cliente",
  "gamezone.chooser.new.ready":
    "Configura de 1 a 10 tarjetas nuevas — elige un paquete de fichas para cada una",
  "gamezone.chooser.new.offline": "Dispensador de tarjetas no disponible — consulta a un encargado",
  "gamezone.chooser.reload.title": "Recargar tarjetas existentes",
  "gamezone.chooser.reload.sub": "Agrega fichas a 1–10 tarjetas que ya tienes",
  "gamezone.chooser.balance.title": "Consultar saldo de la tarjeta",
  "gamezone.chooser.balance.subSwipe":
    "Desliza una tarjeta para ver sus fichas, fichas de bono y eTickets",
  "gamezone.chooser.balance.subInsert":
    "Inserta una tarjeta para ver sus fichas, fichas de bono y eTickets",
  "gamezone.combineCards": "Combinar tarjetas",
  "gamezone.chooser.combine.sub":
    "Pasa las fichas de varias tarjetas a una sola tarjeta que conservas",

  // --- Combine cards (consolidate) ---
  "gamezone.conso.step1": "Paso 1 de 2",
  "gamezone.conso.step2": "Paso 2 de 2",
  "gamezone.conso.insertKeep.title": "Inserta la tarjeta que quieres conservar",
  "gamezone.conso.insertKeep.body":
    "Esta es la tarjeta con la que te quedarás — las fichas de todas las demás tarjetas pasan a esta.",
  "gamezone.conso.reading.label": "Leyendo tu tarjeta…",
  "gamezone.conso.reading.sub": "Sale de vuelta enseguida",
  "gamezone.conso.keeping": "Conservando esta tarjeta",
  "gamezone.conso.addTitle": "Agrega tarjetas para combinar",
  "gamezone.conso.addBody":
    "Inserta cada tarjeta una por una — sus fichas pasan a tu tarjeta conservada.",
  "gamezone.conso.notWorking": "La combinación no está funcionando en este momento",
  "gamezone.conso.combining.label": "Combinando…",
  "gamezone.conso.combining.sub": "Pasando las fichas",
  "gamezone.conso.insertCombine.label": "Inserta una tarjeta para combinar",
  "gamezone.conso.insertCombine.sub": "Una tarjeta a la vez — toca Listo cuando termines",
  "gamezone.conso.combinedIn": "Combinadas ({count})",
  "gamezone.conso.sourceRow": "{num}. Tarjeta {ref}",
  "gamezone.conso.done.finished": "Listo — he terminado",
  "gamezone.conso.allSet": "Todo listo — tus fichas están en la tarjeta que conservaste.",
  "gamezone.conso.cardsCombined":
    "{count, plural, one {# tarjeta combinada} other {# tarjetas combinadas}}",
  "gamezone.conso.sameCard":
    "Esa es la tarjeta que conservas (o ya combinada) — inserta una diferente.",
  "gamezone.conso.declined": "Esa tarjeta no se pudo combinar — te devolvemos tu tarjeta.",
  "gamezone.conso.serviceError": "Error del servicio de combinación (HTTP {status})",
  "gamezone.conso.timeout": "El servicio de combinación no respondió a tiempo.",
  "gamezone.conso.unreachable": "No se pudo conectar con el servicio de combinación.",

  // --- Loading / dispense progress ---
  "gamezone.processingPayment": "Procesando el pago…",
  "gamezone.dispensingCardN": "Dispensando la tarjeta {n} de {total}…",
  "gamezone.loadingOntoCard": "Cargando fichas en la tarjeta {n}…",
  "gamezone.takeCardN": "Toma la tarjeta {n}…",
  "gamezone.settingUp":
    "{count, plural, one {Configurando tu tarjeta…} other {Configurando tus tarjetas…}}",
  "gamezone.status.loaded": "Cargada ✓",
  "gamezone.status.seeAttendant": "Consulta a un encargado",
  "gamezone.status.dispensing": "Dispensando…",
  "gamezone.status.loadingTokens": "Cargando fichas…",
  "gamezone.status.waiting": "Esperando…",
  "gamezone.loadingTokens.label": "Cargando tus fichas…",
  "gamezone.loadingTokens.sub": "Un solo cargo, cargando cada tarjeta",

  // --- Done screens ---
  "gamezone.cardsReady": "{count, plural, one {¡Tarjeta lista!} other {¡Tarjetas listas!}}",
  "gamezone.tokensAcross":
    "{tokens} fichas en {count, plural, one {# tarjeta} other {# tarjetas}}.",
  "gamezone.grabCards":
    "{count, plural, one {Toma tu tarjeta del dispensador — pásala en los juegos.} other {Toma tus tarjetas del dispensador — pásalas en los juegos.}}",
  "gamezone.closingIn": "Cerrando automáticamente en {seconds} s",
  "gamezone.paymentReceived": "¡Pago recibido!",
  "gamezone.tokensLoaded": "¡Fichas cargadas!",
  "gamezone.reloadPendingBody":
    "Tus fichas pueden tardar un minuto en aparecer — si tu saldo se ve mal, consulta a un encargado.",
  "gamezone.cardsReadyBody":
    "{count, plural, one {Tu tarjeta está lista — pásala en los juegos.} other {Las # tarjetas están listas — pásalas en los juegos.}}",

  // --- Error banners ---
  "gamezone.err.paymentFailedDesk": "El pago falló. Por favor, dirígete a la recepción.",
  "gamezone.err.paymentFailedRetry": "El pago falló. Inténtalo de nuevo o dirígete a la recepción.",
  "gamezone.err.cleanRead": "No se pudo leer bien desde el dispensador.",
  "gamezone.err.cardRetained": "No se pudo cargar una tarjeta y fue retenida.",
  "gamezone.err.reloadFailedDesk": "La recarga falló. Por favor, dirígete a la recepción.",
  "gamezone.err.reloadFailedRetry":
    "La recarga falló. Inténtalo de nuevo o dirígete a la recepción.",
  "gamezone.err.startReader": "No se pudo iniciar el pago en el lector.",
  "gamezone.err.sessionExpired": "La sesión de pago expiró. Por favor, dirígete a la recepción.",
  "gamezone.err.paidNotFinished":
    "Recibimos tu pago pero no pudimos finalizar — por favor, dirígete a la recepción (no pagues de nuevo).",

  // --- Balance check ---
  "gamezone.balance.title": "Saldo de la tarjeta",
  "gamezone.checkingBalance": "Consultando el saldo…",
  "gamezone.balance.recentActivity": "Actividad reciente",
  "gamezone.txn.activity": "Actividad",
  "gamezone.balance.checkAnother": "Consultar otra tarjeta",
  "gamezone.balance.reloadThis": "Recargar esta tarjeta",
  "gamezone.balance.notFoundSwipe": "No encontramos esa tarjeta — intenta deslizarla de nuevo.",
  "gamezone.balance.notFoundInsert": "No encontramos esa tarjeta — intenta insertarla de nuevo.",
  "gamezone.blockedFlip": "No se pudo leer — voltea la tarjeta y toca para intentar de nuevo",
  "gamezone.balance.insertToCheck": "Inserta tu tarjeta para consultarla",
  "gamezone.balance.swipeToCheck": "Desliza tu tarjeta para consultarla",
  "gamezone.badSwipe":
    "No se pudo leer ese deslizamiento — voltea la tarjeta y deslízala de nuevo, lento y firme.",
  "gamezone.cardNumberPlaceholder": "Número de tarjeta",

  // --- Reload / new-card carts ---
  "gamezone.reload.title": "Recargar tarjetas de juego",
  "gamezone.newCards.title": "Tarjetas nuevas",
  "gamezone.newCards.intro":
    "Agrega una tarjeta para cada persona de tu grupo y elige el paquete de fichas de cada una. Un solo pago las cubre todas.",
  "gamezone.reload.intro.insert":
    "Agrega cada tarjeta y elige su paquete de fichas — inserta cada tarjeta para leerla. Un solo pago las cubre todas.",
  "gamezone.reload.intro.swipe":
    "Agrega cada tarjeta y elige su paquete de fichas — desliza cada tarjeta en el lector. Un solo pago las cubre todas.",
  "gamezone.reload.intro.type":
    "Agrega cada tarjeta y elige su paquete de fichas — escanea el código de barras o escribe el número. Un solo pago las cubre todas.",
  "gamezone.newCards.activationNote": "incluye {price} de activación por tarjeta",
  "gamezone.payDispense": "Pagar y dispensar",
  "gamezone.payLoad": "Pagar y cargar",
  "gamezone.newCards.checkoutNote":
    "Las tarjetas se pagan con tu reserva al finalizar la compra y se dispensan en la pantalla de confirmación.",
  "gamezone.reload.checkoutNote":
    "Las fichas se pagan con tu reserva al finalizar la compra y se cargan justo después del pago.",
  "gamezone.dispenserOffline.new":
    "El dispensador de tarjetas está fuera de servicio — por favor, consulta a un encargado para comprar tarjetas nuevas.",
  "gamezone.dispenserOutOfCards":
    "El dispensador de tarjetas se quedó sin tarjetas — por favor, consulta a un encargado.",
  "gamezone.payTakeEach": "Paga y luego toma cada tarjeta a medida que se dispensa.",
  "gamezone.reload.insertHold": "Inserta tu tarjeta…",
  "gamezone.reload.insertDifferent": "Inserta una tarjeta diferente",
  "gamezone.reload.insertToRead": "Inserta la tarjeta para leerla",
  "gamezone.checkingCard": "Consultando tu tarjeta…",
  "gamezone.msr.replaceCard": "Tarjeta #{num} — desliza una tarjeta diferente para reemplazarla",
  "gamezone.swipeOnReader": "Desliza tu tarjeta en el lector",
  "gamezone.balanceTokens": "saldo {n} fichas",
  "gamezone.notFoundSwipe": "Tarjeta no encontrada — intenta deslizarla de nuevo.",
  "gamezone.notFoundNumber": "Tarjeta no encontrada — revisa el número.",
  "gamezone.noCardNumber": "Sin número de tarjeta",
  "gamezone.needsCheck": "falta verificar",
  "gamezone.cardNumberScanType": "Número de tarjeta (escanear o escribir)",
  "gamezone.checkEachToContinue": "Verifica el número de cada tarjeta para continuar.",

  // --- Payment screen ---
  "gamezone.pay": "Pagar {amount}",
  "gamezone.payCount": "{count, plural, one {# tarjeta} other {# tarjetas}}",
  "gamezone.paySubNew": "las tarjetas se dispensan cuando se acredita el pago",
  "gamezone.paySubReload": "las fichas se cargan en cuanto se acredita el pago",
};
