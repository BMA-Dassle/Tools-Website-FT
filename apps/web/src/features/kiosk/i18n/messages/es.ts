/**
 * Spanish (es-US) message catalog.
 *
 * ⚠ FIRST-PASS AI TRANSLATION — Phase 3 native-Spanish human review is PENDING.
 * Every value below is a machine/first-pass rendering and must be verified by a
 * native-Spanish reviewer before this locale ships (see
 * tasks/kiosk-i18n-spanish-plan.md § Phase 3). Where wording is legal- or
 * safety-critical and a confident translation isn't possible, the value is left
 * in English with a `// TODO(i18n)` note rather than guessed.
 *
 * Typed to `MessageKey`, so it must cover exactly the English keys — a missing
 * or stray key is a compile error. Runtime still falls back to English per key
 * (getMessages) as a belt-and-suspenders guard.
 *
 * Proper nouns in the locked glossary (FastTrax, HeadPinz, Game Zone, Podium,
 * Pit Crew, Duckpin) stay untranslated in every locale.
 */
import type { MessageKey } from "./en";

export const es: Record<MessageKey, string> = {
  "attract.letsPlay": "¡A jugar!",
  "attract.subtitle.racing":
    "Reserva carreras, boliche y atracciones aquí mismo — toma como un minuto.",
  "attract.subtitle.bowling":
    "Reserva boliche, blasters y láser tag aquí mismo — toma como un minuto.",
  "attract.touchToStart": "Toca para comenzar",

  // --- Category chooser (KioskCategories) ---
  "categories.heading.addAnything": "¿Agregar algo más?",
  "categories.heading.whatToday": "¿Qué vamos a hacer hoy?",
  "categories.exp.title": "Experiencias",
  "categories.exp.eyebrowFallback": "Experiencias combinadas",
  "categories.exp.blurb": "Varias atracciones combinadas en un solo precio fácil",
  "categories.attr.title": "Atracciones",
  "categories.attr.eyebrow": "{count, plural, one {# atracción} other {# atracciones}}",
  "categories.attr.blurb.naples": "Boliche, gel blasters, láser tag y más — elige una hora y listo",
  "categories.attr.blurb.default": "Carreras, boliche, blasters y más — elige una hora y listo",
  "categories.gameZone.eyebrow.reload": "Recargar · consultar saldo",
  "categories.gameZone.eyebrow.full": "Recargar · comprar · 1 a 10 tarjetas",
  "categories.gameZone.blurb.reload":
    "Recarga tu tarjeta de arcade o consulta su saldo — sin esperas",
  "categories.gameZone.blurb.full": "Compra o recarga fichas de arcade — sin esperas",
  "categories.disabled.experience":
    "No disponible en este momento — vuelve más tarde o pregunta a un encargado.",
  "categories.disabled.attraction":
    "No queda nada para reservar hoy — la recepción puede ayudarte con visitas sin cita.",
  "categories.backToCategories": "Todas las categorías",
  "categories.pick.experience": "Elige tu experiencia",
  "categories.pick.attraction": "Elige una atracción",
  "categories.eyebrow.mostPopular": "Más popular",
  "categories.eyebrow.premiumRacing": "Carreras premium",
  "categories.combo.priceLine": "{weekday}/persona lun–jue · {weekend}/persona vie–dom",
  "categories.qualifier.blurb":
    "Califica en un Starter, luego sube de nivel — video POV, aperitivo gratis y licencia incluidos.",
  "categories.qualifier.fromWeekday": "Desde {price}/persona lun–jue",
  "categories.qualifier.fromWeekend": "Desde {price}/persona vie–dom",
  "categories.qualifier.disabled":
    "No queda suficiente tiempo hoy para las dos carreras — vuelve más tarde o pregunta a un encargado.",
  "categories.emptyShelf": "Hoy no hay experiencias combinadas disponibles en esta ubicación.",
  "categories.gameZone.unavailable.title":
    "Las tarjetas de Game Zone no están disponibles en este kiosco",
  "categories.gameZone.unavailable.note": "Usa otro kiosco o visita Servicio al Cliente",
  "categories.tile.unavailable": "No disponible",
  "categories.tile.atVenue": "En {venue}",
  "categories.exp.nextAvailable": "Próxima disponibilidad · {time}",
  "categories.exp.nextAvailableSlots":
    "Próxima disponibilidad · {time} · {count, plural, one {# lugar} other {# lugares}}",
  "categories.tile.nextLane": "Próxima pista · {time}",
  "categories.tile.countTables": "{count, plural, one {# mesa} other {# mesas}} · {time}",
  "categories.tile.countPlayers": "{count, plural, one {# jugador} other {# jugadores}} · {time}",

  // --- Confirmation (KioskConfirmation) ---
  "confirmation.booked": "¡Reservación confirmada!",
  "confirmation.receiptNote":
    "Acabamos de enviarte por mensaje y correo tu confirmación y los enlaces de registro — ese es tu boleto, no hay nada que imprimir.",
  "confirmation.racing.eyebrow": "Carreras — lo que sigue",
  "confirmation.racing.howButton": "¿Cómo funciona el registro de carreras?",
  "confirmation.lane.readyTitle": "{lane} está lista",
  "confirmation.lane.readyTitleGeneric": "Tu pista está lista",
  "confirmation.lane.readyPrompt":
    "¿Quieres que abramos tu pista ahora para que empieces a jugar boliche?",
  "confirmation.lane.opening": "Abriendo…",
  "confirmation.lane.openButton": "Abrir mi pista",
  "confirmation.lane.later": "Me registro más tarde",
  "confirmation.lane.openTitle": "{lane} está abierta",
  "confirmation.lane.openTitleGeneric": "Tu pista está abierta",
  "confirmation.lane.openBody.fasttrax": "Ve para allá — tu pista está lista.",
  "confirmation.lane.openBody.headpinz":
    "Ve para allá — tus zapatos te los llevarán directo a la pista.",
  "confirmation.lane.failedTitle": "No pudimos abrir tu pista",
  "confirmation.lane.failedBody":
    "Por favor acude a la recepción y te pondrán a jugar boliche de inmediato.",
  "confirmation.racePacks.eyebrow": "Paquetes de carreras",
  "confirmation.qr.alt": "Código de registro",
  "confirmation.bookingCode": "Código de reservación",
  "confirmation.done": "Listo — empezar de nuevo",
  "confirmation.dispensing": "Dispensando tus tarjetas…",
  "confirmation.dispensingHint": "Toma cada tarjeta cuando salga — terminamos automáticamente.",
  "confirmation.returningIn":
    "Volviendo al inicio en {seconds}s — toca en cualquier lugar para quedarte",
  "confirmation.raceCheckin.eyebrow": "Registro de carreras",
  "confirmation.raceCheckin.title": "Qué esperar",
  "confirmation.raceCheckin.gotIt": "Entendido",

  // --- Bowling tier step (KioskBowlingTierStep) ---
  "bowlingTier.loading": "Cargando pistas…",
  "bowlingTier.intro":
    "Pistas estándar o la suite VIP con servicio de salón — elige tu horario a continuación.",
  "bowlingTier.upgrade": "Mejora",
  "bowlingTier.perLaneHour": "/pista por hora",
  "bowlingTier.classic.title": "Pistas clásicas",
  "bowlingTier.classic.sub": "La favorita de la casa — hasta 8 por pista",
  "bowlingTier.vip.title": "Suites VIP",
  "bowlingTier.vip.sub": "Asientos en suite privada, servicio de salón en tu pista",

  // --- Bowling time step (KioskBowlingTimeStep) ---
  "bowlingTime.busy.racing": "Estás en carrera",
  "bowlingTime.busy.booked": "Ya tienes una reserva",
  "bowlingTime.busy.bowling": "Estás jugando boliche",
  "bowlingTime.heroEyebrow": "Próximas pistas disponibles · hoy en {center}",
  "bowlingTime.heroSelected": "Listo — continúa para elegir tu paquete de pista",
  "bowlingTime.heroUnselected": "Toca para jugar boliche en cuanto estés listo",
  "bowlingTime.noneToday":
    "No quedan horarios de pista hoy — la recepción puede ayudarte con disponibilidad sin cita.",
  "bowlingTime.orPickAnother": "O elige otro horario para hoy",
  "bowlingTime.conflictNote":
    "Los horarios tachados se cruzan con algo que ya reservaste en esta visita.",
  "bowlingTime.availabilityNote":
    "La disponibilidad exacta de pistas se confirma en el siguiente paso — si un horario se acaba de llenar, te ofreceremos el más cercano disponible.",

  // --- Attraction slot step (KioskSlotStep) ---
  "slot.finding": "Buscando tu próxima hora disponible…",
  "slot.nextAvailable": "Próxima disponibilidad · hoy",
  "slot.holding": "Apartando tu lugar…",
  "slot.held": "Apartado para ti — continúa para seguir",
  "slot.spotsOpen":
    "{count, plural, one {# lugar disponible} other {# lugares disponibles}} — toca para tomarlo",
  "slot.hold.filled": "Ese horario se acaba de llenar — elige otro abajo.",
  "slot.error": "No pudimos revisar los horarios de hoy — elige de la lista de abajo.",
  "slot.noneSoon":
    "No hay nada disponible para tu grupo en las próximas horas — los horarios restantes de hoy están abajo, o pregunta en la recepción por disponibilidad sin cita.",
  "slot.orPickAnother": "O elige otro horario para hoy",

  // --- Bowler roster / details (KioskBowlingDetailsStep) ---
  "bowlingDetails.intro.shoes":
    "Nombres, zapatos y bumpers — para que tu pista esté lista en cuanto tú lo estés.",
  "bowlingDetails.intro.noShoes":
    "Nombres y bumpers — para que tu pista esté lista en cuanto tú lo estés.",
  "bowlingDetails.readyCount": "{ready} de {total} listos",
  "bowlingDetails.bowlerN": "Jugador {num}",
  "bowlingDetails.ready": "Listo",
  "bowlingDetails.name": "Nombre",
  "bowlingDetails.shoeSize": "Talla de zapato",
  "bowlingDetails.shoeRentalNote": "alquiler {price}/par · zapatos propios gratis",
  "bowlingDetails.ownShoes": "Zapatos propios",
  "bowlingDetails.cat.toddler": "Infantil",
  "bowlingDetails.cat.mens": "Hombre",
  "bowlingDetails.cat.womens": "Mujer",
  "bowlingDetails.bumpers": "Bumpers",
  "bowlingDetails.yes": "Sí",
  "bowlingDetails.no": "No",
  "bowlingDetails.rentalSummary":
    "{count, plural, one {# alquiler de zapatos} other {# alquileres de zapatos}} · {price}/par",

  // --- Bowling package / offer step (KioskBowlingOfferStep) ---
  "offer.loading": "Verificando disponibilidad de pistas…",
  "offer.nearClosing": "Solo hay 1 hora disponible tan cerca del cierre.",
  "offer.howLong": "¿Cuánto tiempo?",
  "offer.perLane": "/pista",
  "offer.perPerson": "/persona",
  "offer.perLaneHour": "/pista por hora",
  "offer.pastClosing": "Después del cierre",
  "offer.startTime": "Hora de inicio",
  "offer.noLanesAtTime": "No hay pistas abiertas a esta hora — regresa y elige otra hora.",
  "offer.pickDurationFirst": "Elige primero una duración.",
  "offer.summary.lanes": "{count, plural, one {# pista} other {# pistas}}",
  "offer.summary.bowlers": "{count, plural, one {# jugador} other {# jugadores}}",
  "offer.cta.holding": "Apartando tus pistas…",
  "offer.cta.reservedFor": "Reservado para las {time}",
  "offer.cta.reserve": "Reservar {time}",
  "offer.cta.noTimes": "No hay horarios disponibles",
  "offer.heldNote": "Pistas apartadas — presiona Continuar abajo para seguir.",
  "offer.free": "Gratis",
  "offer.perPersonVipLane": "/persona · pista VIP",
  "offer.openAt": "Abre a las {time}",
  "offer.intro.widened": "Nada abierto a las {time} — los próximos horarios están abajo.",
  "offer.intro.around":
    "Alrededor de las {time} · {players, plural, one {# jugador} other {# jugadores}} en {lanes, plural, one {# pista} other {# pistas}}.",
  "offer.intro.setup": "Configura tus pistas.",
  "offer.widenedNote":
    "El horario que elegiste se acaba de llenar. Elegir uno de los horarios de abajo cambia tu hora de inicio.",
  "offer.makeVip": "Hazlo VIP",
  "offer.vip.kbf": "Pistas brillantes HyperBowling · +{price}/persona",
  "offer.vip.delta": "Asientos en suite privada, servicio de salón · +{price} /pista por hora",
  "offer.vip.noDelta": "Asientos en suite privada, servicio de salón en tu pista",
  "offer.seeVip": "Ver VIP",
  "offer.noLanesToday":
    "No hay pistas abiertas alrededor de esta hora hoy — regresa y elige otra hora, o la recepción puede ayudarte con visitas sin cita.",

  // --- "Who's bowling?" people step (KioskBowlingPeopleStep) ---
  "bowlingPeople.signedInIntro":
    "Tu grupo inició sesión — toca quién va a jugar boliche. Cualquier otra persona puede unirse sin cuenta.",
  "bowlingPeople.walkupIntro":
    "Agrega a todos los que van a jugar boliche y toca a una persona como contacto principal de la reservación.",
  "bowlingPeople.minor": "Menor",
  "bowlingPeople.main": "Principal",
  "bowlingPeople.remove": "Quitar",
  "bowlingPeople.addAnother": "Agregar otro jugador",
  "bowlingPeople.firstName": "Nombre",
  "bowlingPeople.lastName": "Apellido",
  "bowlingPeople.lastNameOptional": "Apellido (opcional)",
  "bowlingPeople.mainFirstName": "Nombre del contacto principal",
  "bowlingPeople.mainLastName": "Apellido del contacto principal",
  "bowlingPeople.emailPlaceholder": "Correo (para tu confirmación)",
  "bowlingPeople.phonePlaceholder": "Teléfono móvil",
  "bowlingPeople.confirmationGoesTo": "La confirmación se envía a {name}",
  "bowlingPeople.scanHint":
    "O escanea una licencia de conducir / identificación estatal en el escáner para agregar un jugador.",
  "bowlingPeople.aria.removeFromBowling": "Quitar a {name} del boliche",
  "bowlingPeople.aria.addToBowling": "Agregar a {name} al boliche",
  "bowlingPeople.aria.extraFirst": "Nombre del jugador adicional {num}",
  "bowlingPeople.aria.extraLast": "Apellido del jugador adicional {num}",
  "bowlingPeople.aria.removeExtra": "Quitar jugador adicional {num}",
  "bowlingPeople.aria.bowlerFirst": "Nombre del jugador {num}",
  "bowlingPeople.aria.bowlerLast": "Apellido del jugador {num}",
  "bowlingPeople.aria.removeBowler": "Quitar jugador {num}",
  "bowlingPeople.aria.mainEmail": "Correo del contacto principal",
  "bowlingPeople.aria.mainPhone": "Teléfono móvil del contacto principal",

  // --- Merged cart + checkout screen (KioskCheckoutScreen) ---
  "checkout.eyebrow": "Pago",
  "checkout.title": "Revisa tu orden",
  "checkout.empty": "Tu carrito está vacío — regresa para elegir una actividad.",
  "checkout.finishFirst": "Termina de configurar cada actividad (toca Editar) antes de pagar.",
  "checkout.estTotal": "Total est.",
  "checkout.plusTax": "+ impuestos",
  "checkout.allActivities": "Todas las actividades",
  "checkout.reviewAndPay": "Revisar y pagar",

  // --- Checkout upsell (KioskCheckoutUpsell) — "Game Zone" stays untranslated ---
  "upsell.eyebrow": "Una cosa más…",
  "upsell.title": "¿Agregar fichas de Game Zone?",
  "upsell.cardLabel": "Tarjeta de fichas Game Zone",
  "upsell.tokens": "{count} fichas",
  "upsell.pctOff": "{pct}% de descuento hoy",
  "upsell.ridesPayment":
    "Se incluye en el pago de tu reservación — la {count, plural, one {tarjeta se imprime} other {tarjetas se imprimen}} aquí mismo cuando termines.",
  "upsell.activation":
    "{count, plural, one {Activación de tarjeta (única vez)} other {Activación de tarjeta × # (única vez)}}",
  "upsell.howMany": "¿Cuántas tarjetas?",
  "upsell.onePerPlayer": "Una por jugador (hasta {max})",
  "upsell.aria.fewer": "Menos tarjetas",
  "upsell.aria.more": "Más tarjetas",
  "upsell.cta": "{count, plural, one {Agregar a la orden} other {Agregar # tarjetas}} — {price}",
  "upsell.skip": "No gracias, continuar",

  // --- Rewards on checkout (KioskRewardsSection) ---
  "rewards.pointsUnit": "puntos",
  "rewards.addMobile": "Agrega tu número de celular arriba para consultar tus {unit}.",
  "rewards.checking": "Consultando tus {program}…",
  "rewards.enrollBlurbPlain": "Gana 10 {unit} por cada $1 gastado. Únete gratis.",
  "rewards.enrollBlurbPreview":
    "Gana 10 {unit} por cada $1 gastado — eso es ~{earn} en la orden de hoy. Únete gratis.",
  "rewards.enrollError":
    "No pudimos crear una cuenta de recompensas — puedes registrarte en la recepción.",
  "rewards.signingUp": "Registrando…",
  "rewards.joinFree": "Únete gratis",
  "rewards.collapsed.applied": "{name} aplicado — toca para cambiar",
  "rewards.collapsed.spend": "Toca para usar tus {unit} en esta orden",
  "rewards.collapsed.verifySpend": "Toca para verificar y usar tus {unit}",
  "rewards.earnMore": "Ganarás ~{n} {unit} más en la orden de hoy.",
  "rewards.verified": "Verificado",
  "rewards.member": "Miembro",
  "rewards.verifyPrompt": "Verifica que es tu cuenta para usar tus {unit} en esta orden.",
  "rewards.sending": "Enviando…",
  "rewards.textCode": "Envíame un código",
  "rewards.enterCode": "Ingresa el código de 6 dígitos que enviamos a tu teléfono.",
  "rewards.submit": "Enviar",
  "rewards.sendError": "No pudimos enviar el código — inténtalo de nuevo.",
  "rewards.codeMismatch": "Ese código no coincidió — inténtalo de nuevo.",
  "rewards.verifyFailed": "La verificación falló — inténtalo de nuevo.",
  "rewards.spendHeading": "Usa tus {unit} en esta orden",
  "rewards.tierPoints": "{points} {unit}",
  "rewards.notEnough": "Aún no tienes suficientes {unit} para una recompensa — ¡sigue ganando!",

  // --- Mobile-join new-guest form (join/phone/NewGuestForm) ---
  "join.firstName": "Nombre",
  "join.lastName": "Apellido",
  "join.birthday": "Fecha de nacimiento",
  "join.mobilePhone": "Teléfono móvil",
  "join.email": "Correo",
  "join.optional": "(opcional)",
  "join.settingUp": "Preparando todo…",
  "join.continueToWaiver": "Continuar a la exención",
  "join.back": "Atrás",
  "join.err.name": "Ingresa tu nombre y apellido.",
  "join.err.dob": "Ingresa tu fecha de nacimiento como MM/DD/AAAA.",
  "join.err.phone": "Ingresa tu número de teléfono móvil.",
  "join.err.email": "Ese correo no parece correcto — o déjalo en blanco.",

  // --- Mobile-join phone flow (join/phone/JoinPhoneFlow) ---
  "joinFlow.finding": "Buscando tu grupo…",
  "joinFlow.joinGroup": "Únete a tu grupo",
  "joinFlow.race": "Carreras de Go-Kart",
  "joinFlow.activity": "Registro de actividad",
  "joinFlow.locationLine": "en {venue} — {kind}",
  "joinFlow.onePayment":
    "Un grupo, un pago. El pago dividido no está disponible aquí — todo tu grupo paga junto en el kiosco.",
  "joinFlow.adultsOnly":
    "Solo adultos mayores de 18. Cualquier persona menor de 18 se agrega en el kiosco, donde un adulto puede firmar por ella.",
  "joinFlow.beenBefore": "Ya he venido antes",
  "joinFlow.imNew": "Soy nuevo — regístrame",
  "joinFlow.takesMinute": "Toma como un minuto. Tu grupo puede seguir en el kiosco.",
  "joinFlow.lookupIntro": "Encuentra tu cuenta — te enviaremos un código por mensaje o correo",
  "joinFlow.switchToNew": "En realidad, soy nuevo aquí →",
  "joinFlow.back": "Atrás",
  "joinFlow.setYourself": "Regístrate",
  "joinFlow.signingFor": "Firmando por:",
  "joinFlow.waiver.race": "Exención de carreras",
  "joinFlow.waiver.activity": "Exención de actividad",
  "joinFlow.waiver.subheading": "Firma una vez — cubre toda tu visita de hoy.",
  "joinFlow.addingToGroup": "Agregándote al grupo…",
  "joinFlow.onList": "¡Estás en la lista del kiosco!",
  "joinFlow.addedHeadBack":
    "{name} ha sido agregado. Regresa con tu grupo — el kiosco muestra que ya estás.",
  "joinFlow.reminderPay":
    "Recordatorio: tu grupo paga junto en el kiosco — el pago dividido no está disponible.",
  "joinFlow.addAnother": "Agregar otra persona",
  "joinFlow.batchHeading":
    "{count, plural, one {¡Estás en la lista del kiosco!} other {¡# personas agregadas!}}",
  "joinFlow.batchAddedTail":
    "{count, plural, one { ha sido agregado} other { han sido agregados}}. Regresa con tu grupo — el kiosco muestra que ya estás.",
  "joinFlow.batchSkipped":
    "{names} {count, plural, one {es} other {son}} menor de 18 — un adulto puede {count, plural, one {agregarlo} other {agregar a cada uno}} en el kiosco.",
  "joinFlow.addMore": "Agregar más personas",
  "joinFlow.minorTitle": "¿Menor de 18? Ve al kiosco.",
  "joinFlow.minorBody":
    "Los jugadores menores de 18 se agregan en el kiosco para que un padre o tutor firme su exención. Cualquier persona mayor de 18 puede unirse aquí mismo.",
  "joinFlow.addSomeoneElse": "Agregar a alguien más",
  "joinFlow.tryAgain": "Intentar de nuevo",
  "joinFlow.startOver": "Empezar de nuevo",
  "joinFlow.reconnecting": "Reconectando…",
  "joinFlow.confirmBirthday": "Confirma tu fecha de nacimiento",
  "joinFlow.hiNeedOnce": "Hola {firstName} — la necesitamos una vez para tu exención.",
  "joinFlow.dobAria": "Fecha de nacimiento",
  "joinFlow.continue": "Continuar",
  "joinFlow.err.setup":
    "No pudimos terminar tu registro. Inténtalo de nuevo — o ve a la recepción.",
  "joinFlow.err.full":
    "La lista de este grupo está llena — ve a la recepción para que te agreguen.",
  "joinFlow.err.rateLimit": "Un momento — inténtalo de nuevo en unos segundos.",
  "joinFlow.err.addFail": "Algo falló al agregarte a la lista. Inténtalo de nuevo.",
  "joinFlow.err.connection": "Problema de conexión — revisa tu señal e inténtalo de nuevo.",
  "joinFlow.ended.movedOn.title": "El grupo siguió adelante.",
  "joinFlow.ended.movedOn.body":
    "El kiosco terminó de agregar jugadores antes de que terminaras. Avísale a tu grupo — pueden agregarte directamente en el kiosco, o ve a la recepción.",
  "joinFlow.ended.cancelled.title": "Esta sesión se canceló en el kiosco.",
  "joinFlow.ended.cancelled.body":
    "Pídele a tu grupo que empiece de nuevo, luego escanea el nuevo código QR.",
  "joinFlow.ended.expired.title": "Este código QR expiró.",
  "joinFlow.ended.expired.body":
    "Escanea de nuevo el código en la pantalla del kiosco para unirte.",
  "joinFlow.ended.invalid.title": "Este enlace no es válido.",
  "joinFlow.ended.invalid.body": "Escanea el código QR en el kiosco para unirte a tu grupo.",

  // --- Self-service check-in (checkin/KioskCheckinFlow) ---
  "checkin.loading": "Cargando…",
  "checkin.oneMoment": "Un momento…",
  "checkin.home": "Inicio",
  "checkin.back": "Atrás",
  "checkin.eyebrow": "Registro",
  "checkin.doneTitle": "Registro completo",
  "checkin.welcomeBack": "¡Bienvenido de nuevo, {name}!",
  "checkin.friend": "amigo",
  "checkin.findReservation": "Encuentra tu reservación",
  "checkin.matches.prompt":
    "Encontramos más de una reservación — toca la que corresponde a tu visita.",
  "checkin.browse.prompt":
    "Llegando pronto a esta ubicación. Toca tu reservación — enviaremos un código por mensaje al número de la reservación para confirmar que eres tú.",
  "checkin.browse.emptyTitle": "Nada en las próximas horas",
  "checkin.browse.emptyBody": "Usa tu número de teléfono arriba, o ve a la recepción.",
  "checkin.addGroup.eyebrow": "Agrega a tu grupo",
  "checkin.addGroup.body":
    "Agrega a cualquier persona contigo que aún necesite una cuenta o una exención — o pídele que escanee el código QR para iniciar sesión en su propio teléfono.",
  "checkin.checkingIn": "Registrándote…",
  "checkin.checkEveryone": "Registrar a todos",
  "checkin.finishAddingFirst":
    "Termina de agregar a todos arriba primero — cada persona necesita una cuenta y una exención firmada.",
  "checkin.err.cancelled": "Esa reservación fue cancelada — por favor ve a la recepción.",
  "checkin.err.openFail":
    "No pudimos abrir esa reservación. Inténtalo de nuevo o ve a la recepción.",
  "checkin.err.addFail": "No pudimos agregar a tu grupo — por favor ve a la recepción.",
  "checkin.err.finishing": "Un momento — terminando. Toca de nuevo.",
  "checkin.err.checkinFail": "No pudimos registrarte — por favor ve a la recepción.",
  "checkin.err.noPhone": "No hay teléfono en esa reservación — por favor ve a la recepción.",
  "checkin.err.codeJustSent":
    "Acabamos de enviar un código — revisa tus mensajes, o espera un momento.",
  "checkin.err.sendCodeFail": "No pudimos enviar un código. Por favor ve a la recepción.",
  "checkin.err.codeNotFound":
    "No pudimos encontrar ese código. Prueba con tu número de teléfono, o ve a la recepción.",
  "checkin.err.enterMobile": "Ingresa tu número de celular de 10 dígitos.",
  "checkin.err.textFail":
    "No pudimos enviar un mensaje a ese número. Revísalo e inténtalo de nuevo.",
  "checkin.err.incorrectTries":
    "Código incorrecto — {count, plural, one {queda # intento} other {quedan # intentos}}.",
  "checkin.err.codeFailNew": "Ese código no funcionó. Solicita uno nuevo.",
  "checkin.err.noReservations":
    "No se encontraron reservaciones para hoy con ese número. Ve a la recepción.",
  "checkin.err.incorrectLeft": "Código incorrecto — quedan {count}.",
  "checkin.err.codeFailBack": "Ese código no funcionó. Regresa e inténtalo de nuevo.",
  "checkin.otpMaskFallback": "tu número registrado",
  "checkin.find.usePhone": "Usa tu número de teléfono",
  "checkin.find.phoneBlurb": "Funciona para cualquier reservación. Te enviaremos un código rápido.",
  "checkin.find.phoneAria": "Número de teléfono móvil",
  "checkin.find.textCode": "Envíame un código",
  "checkin.find.scanNow": "Escaneando…",
  "checkin.find.scanMyCode": "Escanear mi código",
  "checkin.find.scanSub": "QR del correo o número W",
  "checkin.find.findBooking": "Encontrar mi reservación",
  "checkin.find.findSub": "Elige de la lista de hoy",
  "checkin.otp.verify": "Verifica que eres tú",
  "checkin.otp.textedTo": "Enviamos un código a {mask}",
  "checkin.otp.enterCode": "Ingresa el código de 6 dígitos de tus mensajes.",
  "checkin.otp.aria": "Código de verificación de 6 dígitos",
  "checkin.otp.openDay": "Abrir mi día",
  "checkin.itin.firstStop": "Empieza aquí · Primera parada",
  "checkin.itin.arriveBy": "Llega antes de las {label}",
  "checkin.itin.dueAtDesk": "{amount} por pagar en la recepción — aquí no se cobra nada.",
  "checkin.itin.alreadyOn": "Ya en esta reservación",
  "checkin.itin.someoneNotOn": "¿Alguien contigo que no está en esta reservación?",
  "checkin.itin.startNew": "Iniciar una nueva reservación ›",
  "checkin.done.allCheckedIn": "Ya completaste tu registro.",
  "checkin.done.racersAdded":
    "{count, plural, one {# corredor agregado} other {# corredores agregados}} a tu carrera — ve para allá cuando llamen tu tanda.",
  "checkin.done.frontDeskKnows": "La recepción sabe que ya estás aquí.",
  "checkin.done.needHand":
    "{names} podría necesitar ayuda en la recepción — se ha notificado a un miembro del equipo.",
  "checkin.done.finish": "Listo",
  "checkin.lane.idle": "Tu pista se abre unos 30 minutos antes de tu hora — la tendremos lista.",
  "checkin.lane.open": "{lane} está abierta — los zapatos van en camino. ¡Diviértete!",
  "checkin.lane.failed":
    "No pudimos abrir {lane} — por favor ve a la recepción y te pondrán a jugar.",
  "checkin.lane.ready": "{lane} está lista",
  "checkin.lane.readyBody": "Ábrela ahora y ve a jugar boliche.",
  "checkin.lane.opening": "Abriendo tu pista…",
  "checkin.lane.openNow": "Abrir {lane} ahora",
  "checkin.chip.laneOpens": "La pista se abre unos 30 minutos antes de tu hora",
  "checkin.chip.racersReady": "{ready} de {total} corredores listos",
  "checkin.chip.waiversSigned": "{ready} de {total} exenciones firmadas",

  // --- Racing/attraction people step (KioskPeopleStep) — VALIDATION + errors ---
  "people.thisRacer": "Este corredor",
  "people.err.name": "Ingresa un nombre y apellido.",
  "people.err.dob": "Ingresa la fecha de nacimiento como MM/DD/AAAA.",
  "people.err.tooYoung":
    "{name} es menor de 7 — demasiado joven para correr. Los niños menores de 7 son bienvenidos junto a la pista, o prueba el boliche Duckpin.",
  "people.err.phone": "Ingresa un número de teléfono móvil.",
  "people.err.email": "El contacto principal necesita un correo para la confirmación.",
  "people.err.setupFailMsg": "No pudimos registrar a esa persona: {msg}",
  "people.err.setupFail":
    "No pudimos registrar a esa persona. Inténtalo de nuevo o ve a la recepción.",
  "people.err.finishFailMsg": "No pudimos terminar el registro: {msg}",
  "people.err.finishFail":
    "No pudimos terminar el registro. Inténtalo de nuevo o ve a la recepción.",
  "people.err.licenseMismatch":
    "Esa licencia no parece ser de {name} — mejor ingresa su fecha de nacimiento.",
};
