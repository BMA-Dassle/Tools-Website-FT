/**
 * In-house waiver templates — the legal body we OWN and serve ourselves (behind
 * `kioskWaiverInhouseEnabled()`), instead of fetching it from BMI/Pandora. Two
 * variants (adult / minor) × two languages (en / es). Source of truth for the
 * English text: tasks/waiver-inhouse/waiver-source-en.md (owner-provided
 * 2026-07-26). The minor variant is the adult text plus the Florida Statute
 * 744.301 guardian-notice box, inserted after the MINORS section.
 *
 * ⚠ LEGAL: the Spanish body is a FIRST-PASS AI TRANSLATION. It ships with a
 * "governing language" notice (the English version controls on any conflict) as
 * a standard bilingual-waiver protection, but it MUST still be reviewed by an
 * attorney. Bump `WAIVER_VERSION` on ANY text change (it stamps every signed
 * Neon record + the synthetic contentID) and set `esReviewed: true` in
 * WAIVER_META once an attorney signs off on the Spanish.
 */
import type { PandoraWaiverTemplate } from "@/lib/pandora";

export type WaiverVariant = "adult" | "minor";
export type WaiverLang = "en" | "es";

/** Bump on ANY change to the legal text below. Stamped on every signed record. */
export const WAIVER_VERSION = "2026-07-26";

/** "valid indefinitely" (owner text) → a long horizon in days for the expiry the
 *  gating layer expects. The text lets the Company force a re-sign at any time. */
export const WAIVER_DURATION_DAYS = 3650;

export const WAIVER_META = {
  /** Flip true once an attorney has reviewed the Spanish body. Informational —
   *  the ES body is served regardless per owner 2026-07-26, but the English
   *  "governing language" notice protects an unreviewed translation. */
  esReviewed: false,
} as const;

/* ── English ─────────────────────────────────────────────────────────────── */

const EN_TITLE =
  "<b>RELEASE AND WAIVER OF LIABILITY, INDEMNITY, CONFIDENTIALITY, AND CREDIT CARD DISPUTE AGREEMENT</b><br><br>";

// intro → MINORS (everything before the guardian-notice insertion point)
const EN_HEAD = `${EN_TITLE}
<b>NOTICE:</b> Execution of this document waives certain legal rights, including the right to bring a claim for bodily injuries or damages. Read carefully before signing.<br><br>

<b>CONSIDERATION AND PARTIES</b><br>
In consideration of being permitted to enter, remain on, or otherwise be present at any <b>HeadPinz</b> or <b>FastTrax Entertainment</b> facility (the “Property”), whether or not participating in any of its attractions or activities (“Attractions”), and for other good and valuable consideration, I, for myself, my heirs, executors, administrators, assigns, and on behalf of any minors listed below (collectively “Releasors”), agree to the following terms.<br><br>

<b>RELEASE OF LIABILITY</b><br>
I <b>release, waive, discharge, and covenant not to sue</b> HeadPinz Entertainment, FastTrax Entertainment, Bowling Management Associates, their subsidiaries, owners, officers, directors, employees, contractors, volunteers, and agents (collectively the “Releasees”) from <b>any and all claims, demands, actions, causes of action, damages, losses, or expenses of any kind</b>, including personal injury, death, property damage, or economic loss, <b>arising from or connected in any way to my or my child’s presence on the Property or participation in Attractions</b>, <b>including injuries caused in whole or in part by the ordinary negligence</b> of the Releasees.<br><br>

<b>ASSUMPTION OF RISK</b><br>
I understand and acknowledge that participating in or observing Attractions such as <b>go-karting, axe throwing, laser tag, Nexus Gel Blasters, bowling, arcade games, virtual reality, simulators, and other physical activities</b> involves <b>inherent risks</b> that cannot be completely eliminated, including collisions, falls, equipment malfunction, or other participants’ actions. I knowingly assume <b>all known and unknown risks</b>, including those caused by the negligence of the Releasees, and agree not to participate while under the influence of alcohol, drugs, or any impairing condition.<br><br>

<b>INJURY REPORTING AND MEDICAL EXPENSES</b><br>
I agree to immediately report any injury to management <b>before leaving the Property</b> and understand that failure to do so may void any potential claim or assistance. I accept full financial responsibility for any medical treatment or emergency care resulting from participation or presence on the Property.<br><br>

<b>VIDEO AND PHOTOGRAPHY CONSENT</b><br>
I grant the Company permission to record or photograph me and/or my minor(s) and to use such materials for marketing, safety, or business purposes without compensation. I understand all footage taken by the Company is its property and may be retained for security or legal use. I agree that any video, photo, or recording I capture on the Property will not be publicly shared, posted, or used against the Company except through licensed legal counsel in accordance with Florida law.<br><br>

<b>DISEASE AND ILLNESS RELEASE</b><br>
I recognize that despite reasonable sanitation and cleaning practices, the Property is a public space where exposure to illness (including COVID-19 or other viruses) is possible. I release and hold harmless the Releasees from any claim relating to illness or infection resulting from my or my minor’s presence or participation.<br><br>

<b>INDEMNITY</b><br>
To the fullest extent allowed by Florida law, I agree to <b>indemnify and hold harmless</b> the Releasees from any and all claims, damages, or expenses (including attorneys’ fees) arising out of (a) my or my minor’s actions or negligence, or (b) any third-party claim caused by our participation or conduct while on the Property.<br><br>

<b>MINORS</b><br>
If signing for a minor, I affirm that I am the <b>parent or legal guardian</b> of the child(ren) named below and understand that, under <b>Florida Statute 744.301</b>, I may waive a minor’s right to sue only for <b>injuries resulting from inherent risks</b>, not for the Company’s gross negligence or intentional misconduct. I knowingly assume those inherent risks on behalf of the minor(s).<br><br>`;

// LIMITATIONS → end (everything after the guardian-notice insertion point)
const EN_TAIL = `<b>LIMITATIONS OF CLAIMS</b><br>
This release does <b>not</b> apply to gross negligence, reckless conduct, or intentional acts by the Releasees. Any claim or dispute must be brought within <b>one (1) year</b> of the date of the alleged incident.<br><br>

<b>CREDIT CARD DISPUTE AND REFUND WAIVER</b><br>
<b>All sales are final</b> once services or Attractions are rendered or accessed.<br>
Refunds or adjustments are granted <b>solely at management’s discretion</b>.<br>
I agree to a <b>Good-Faith Resolution Requirement</b>, meaning that I must first contact the Company directly to resolve any billing or service concern before taking any outside action.<br>
Failure to contact the Company before filing a credit-card dispute or chargeback shall constitute a <b>material breach of this Agreement</b>.<br>
I will <b>not initiate or pursue any credit-card chargeback</b> based on dissatisfaction with service, staff, experience quality, food or beverage quality, race timing, equipment condition, or facility operations.<br>
I authorize the Company to present this signed waiver and transaction records as conclusive evidence of authorization if a chargeback is filed in violation of this Agreement.<br>
I agree to reimburse the Company for any costs, fees, or penalties incurred responding to or reversing such disputes.<br><br>

<b>CONFIDENTIALITY, NON-DISPARAGEMENT, AND SOCIAL MEDIA AGREEMENT</b><br>
I agree that any incidents, claims, investigations, or disputes arising from or related to my experience at the Property are <b>confidential</b> and will be addressed directly and privately with the Company. I further agree <b>not to post, publish, share, or otherwise communicate</b> on social media, review sites, or public forums any statements, photos, videos, or opinions that may reasonably be viewed as negative, harmful, misleading, or damaging to the reputation of HeadPinz, FastTrax, their staff, affiliates, or partners. Publicly posting, sharing, or publishing such material without the Company’s written consent shall constitute a <b>breach of this Agreement</b>. This clause does not prohibit truthful communication with law enforcement, regulatory agencies, or my licensed attorney as permitted by law.<br><br>

<b>DURATION AND VALIDITY</b><br>
This waiver shall remain <b>valid indefinitely</b> for the signer and any minors listed below, unless and until the Company issues an updated waiver or modifies its terms, attractions, or policies. The Company reserves the right to require a new signature at any time to reflect such updates or changes in law, operations, or risk acknowledgment.<br><br>

<b>DISPUTE RESOLUTION AND VENUE</b><br>
Before bringing any legal action, I agree to attempt <b>good-faith mediation</b> in <b>Lee County, Florida</b>, through United States Arbitration & Mediation or another mutually agreed neutral forum. If litigation follows, <b>venue shall lie exclusively in Lee County, Florida</b>, and the prevailing party shall recover reasonable attorneys’ fees and costs. I <b>waive the right to a jury trial</b>.<br><br>

<b>SEVERABILITY</b><br>
If any part of this Agreement is held invalid, the remainder shall continue in full force and effect.<br><br>

<b>FINAL ACKNOWLEDGMENT</b><br>
I have read this Agreement in its entirety, understand its terms, and sign it voluntarily. I understand that by signing, I am <b>waiving substantial legal rights</b>, including the right to sue for ordinary negligence, for myself and any minors listed below. No oral representations or statements modify this written document.<br><br>

© HeadPinz Entertainment & FastTrax Entertainment – Florida<br>`;

const EN_GUARDIAN_BOX = `<div style="border:2pt solid #000000; background:#ededed; padding:14px 16px; margin:0 0 16px;">
<div style="text-align:center; font-size:18pt; font-weight:bold; line-height:1.3; margin-bottom:12px;">NOTICE TO THE MINOR CHILD’S NATURAL GUARDIAN</div>
<div style="font-size:18pt; font-weight:bold; line-height:1.5;">READ THIS FORM COMPLETELY AND CAREFULLY. YOU ARE AGREEING TO LET YOUR MINOR CHILD ENGAGE IN A POTENTIALLY DANGEROUS ACTIVITY. YOU ARE AGREEING THAT, EVEN IF HeadPinz Entertainment, FastTrax Entertainment, and Bowling Management Associates USES REASONABLE CARE IN PROVIDING THIS ACTIVITY, THERE IS A CHANCE YOUR CHILD MAY BE SERIOUSLY INJURED OR KILLED BY PARTICIPATING IN THIS ACTIVITY BECAUSE THERE ARE CERTAIN DANGERS INHERENT IN THE ACTIVITY WHICH CANNOT BE AVOIDED OR ELIMINATED. BY SIGNING THIS FORM YOU ARE GIVING UP YOUR CHILD’S RIGHT AND YOUR RIGHT TO RECOVER FROM HeadPinz Entertainment, FastTrax Entertainment, and Bowling Management Associates IN A LAWSUIT FOR ANY PERSONAL INJURY, INCLUDING DEATH, TO YOUR CHILD OR ANY PROPERTY DAMAGE THAT RESULTS FROM THE RISKS THAT ARE A NATURAL PART OF THE ACTIVITY. YOU HAVE THE RIGHT TO REFUSE TO SIGN THIS FORM, AND HeadPinz Entertainment, FastTrax Entertainment, and Bowling Management Associates HAS THE RIGHT TO REFUSE TO LET YOUR CHILD PARTICIPATE IF YOU DO NOT SIGN THIS FORM.</div>
</div>`;

/* ── Spanish (first-pass AI translation — attorney review pending) ─────────── */

/** Standard bilingual-waiver protection: the English version governs on conflict. */
const ES_GOVERNING_NOTICE = `<div style="border:1pt solid #999; background:#f4f4f4; padding:10px 14px; margin:0 0 16px; font-size:11pt;">
<b>AVISO / GOVERNING LANGUAGE:</b> Esta es una traducción de cortesía al español del acuerdo en inglés. En caso de cualquier discrepancia, ambigüedad o conflicto entre esta versión en español y la versión en inglés, <b>la versión en inglés prevalece y es la que rige legalmente</b>. Al firmar, usted acepta quedar obligado por los términos del acuerdo.
</div>`;

const ES_TITLE =
  "<b>LIBERACIÓN Y RENUNCIA DE RESPONSABILIDAD, INDEMNIZACIÓN, CONFIDENCIALIDAD Y ACUERDO SOBRE DISPUTAS DE TARJETA DE CRÉDITO</b><br><br>";

const ES_HEAD = `${ES_TITLE}${ES_GOVERNING_NOTICE}
<b>AVISO:</b> La firma de este documento renuncia a ciertos derechos legales, incluido el derecho a presentar una reclamación por lesiones corporales o daños. Léalo con atención antes de firmar.<br><br>

<b>CONTRAPRESTACIÓN Y PARTES</b><br>
En consideración a que se me permita entrar, permanecer o estar presente de cualquier forma en cualquier instalación de <b>HeadPinz</b> o <b>FastTrax Entertainment</b> (la “Propiedad”), ya sea que participe o no en sus atracciones o actividades (“Atracciones”), y por otra contraprestación válida y suficiente, yo, por mí mismo, mis herederos, albaceas, administradores, cesionarios, y en nombre de cualquier menor que se indique a continuación (en conjunto, los “Renunciantes”), acepto los siguientes términos.<br><br>

<b>LIBERACIÓN DE RESPONSABILIDAD</b><br>
<b>Libero, renuncio, descargo y me comprometo a no demandar</b> a HeadPinz Entertainment, FastTrax Entertainment, Bowling Management Associates, sus subsidiarias, propietarios, funcionarios, directores, empleados, contratistas, voluntarios y agentes (en conjunto, los “Liberados”) de <b>todas y cada una de las reclamaciones, demandas, acciones, causas de acción, daños, pérdidas o gastos de cualquier tipo</b>, incluidas lesiones personales, muerte, daños a la propiedad o pérdida económica, <b>que surjan de o estén relacionados de cualquier manera con mi presencia o la de mi hijo/a en la Propiedad o con la participación en las Atracciones</b>, <b>incluidas las lesiones causadas total o parcialmente por la negligencia ordinaria</b> de los Liberados.<br><br>

<b>ASUNCIÓN DEL RIESGO</b><br>
Entiendo y reconozco que participar en u observar Atracciones como <b>karting, lanzamiento de hachas, láser tag, Nexus Gel Blasters, boliche, juegos de arcade, realidad virtual, simuladores y otras actividades físicas</b> implica <b>riesgos inherentes</b> que no se pueden eliminar por completo, incluidos choques, caídas, fallas del equipo o las acciones de otros participantes. Asumo a sabiendas <b>todos los riesgos, conocidos y desconocidos</b>, incluidos los causados por la negligencia de los Liberados, y acepto no participar bajo la influencia del alcohol, drogas o cualquier condición que altere mis capacidades.<br><br>

<b>REPORTE DE LESIONES Y GASTOS MÉDICOS</b><br>
Acepto reportar de inmediato cualquier lesión a la gerencia <b>antes de salir de la Propiedad</b> y entiendo que no hacerlo puede anular cualquier posible reclamación o asistencia. Acepto la total responsabilidad financiera por cualquier tratamiento médico o atención de emergencia que resulte de la participación o presencia en la Propiedad.<br><br>

<b>CONSENTIMIENTO DE VIDEO Y FOTOGRAFÍA</b><br>
Otorgo a la Compañía permiso para grabarme o fotografiarme a mí y/o a mi(s) menor(es) y para usar dichos materiales con fines de mercadeo, seguridad o negocio sin compensación. Entiendo que todo el material grabado por la Compañía es de su propiedad y puede conservarse para uso de seguridad o legal. Acepto que cualquier video, foto o grabación que yo capture en la Propiedad no se compartirá, publicará ni usará públicamente contra la Compañía, salvo a través de un abogado con licencia conforme a la ley de Florida.<br><br>

<b>LIBERACIÓN POR ENFERMEDAD</b><br>
Reconozco que, a pesar de las prácticas razonables de saneamiento y limpieza, la Propiedad es un espacio público donde es posible la exposición a enfermedades (incluido el COVID-19 u otros virus). Libero y eximo de responsabilidad a los Liberados de cualquier reclamación relacionada con enfermedad o infección que resulte de mi presencia o participación o la de mi menor.<br><br>

<b>INDEMNIZACIÓN</b><br>
En la máxima medida permitida por la ley de Florida, acepto <b>indemnizar y eximir de responsabilidad</b> a los Liberados de todas y cada una de las reclamaciones, daños o gastos (incluidos los honorarios de abogados) que surjan de (a) mis acciones o negligencia o las de mi menor, o (b) cualquier reclamación de terceros causada por nuestra participación o conducta mientras estemos en la Propiedad.<br><br>

<b>MENORES</b><br>
Si firmo en nombre de un menor, afirmo que soy el <b>padre, madre o tutor legal</b> del/de los menor(es) indicado(s) a continuación y entiendo que, conforme a la <b>Ley de Florida (Florida Statute) 744.301</b>, solo puedo renunciar al derecho de un menor a demandar por <b>lesiones que resulten de riesgos inherentes</b>, no por la negligencia grave o la mala conducta intencional de la Compañía. Asumo a sabiendas esos riesgos inherentes en nombre del/de los menor(es).<br><br>`;

const ES_TAIL = `<b>LIMITACIONES DE LAS RECLAMACIONES</b><br>
Esta liberación <b>no</b> aplica a la negligencia grave, la conducta imprudente ni los actos intencionales de los Liberados. Cualquier reclamación o disputa debe presentarse dentro de <b>un (1) año</b> a partir de la fecha del supuesto incidente.<br><br>

<b>RENUNCIA A DISPUTAS DE TARJETA DE CRÉDITO Y REEMBOLSOS</b><br>
<b>Todas las ventas son finales</b> una vez que los servicios o Atracciones se prestan o se acceden.<br>
Los reembolsos o ajustes se otorgan <b>únicamente a discreción de la gerencia</b>.<br>
Acepto un <b>Requisito de Resolución de Buena Fe</b>, lo que significa que primero debo contactar directamente a la Compañía para resolver cualquier inquietud de facturación o servicio antes de tomar cualquier acción externa.<br>
No contactar a la Compañía antes de presentar una disputa o contracargo de tarjeta de crédito constituirá un <b>incumplimiento material de este Acuerdo</b>.<br>
<b>No iniciaré ni presentaré ningún contracargo de tarjeta de crédito</b> basado en la insatisfacción con el servicio, el personal, la calidad de la experiencia, la calidad de la comida o bebida, los tiempos de carrera, el estado del equipo o la operación de las instalaciones.<br>
Autorizo a la Compañía a presentar esta renuncia firmada y los registros de la transacción como evidencia concluyente de autorización si se presenta un contracargo en violación de este Acuerdo.<br>
Acepto reembolsar a la Compañía por cualquier costo, cargo o penalización en que incurra al responder o revertir dichas disputas.<br><br>

<b>CONFIDENCIALIDAD, NO DIFAMACIÓN Y ACUERDO SOBRE REDES SOCIALES</b><br>
Acepto que cualquier incidente, reclamación, investigación o disputa que surja de o esté relacionada con mi experiencia en la Propiedad es <b>confidencial</b> y se tratará directa y privadamente con la Compañía. Además, acepto <b>no publicar, difundir, compartir ni comunicar de otro modo</b> en redes sociales, sitios de reseñas o foros públicos ninguna declaración, foto, video u opinión que razonablemente pueda considerarse negativa, dañina, engañosa o perjudicial para la reputación de HeadPinz, FastTrax, su personal, afiliados o socios. Publicar, compartir o difundir públicamente dicho material sin el consentimiento por escrito de la Compañía constituirá un <b>incumplimiento de este Acuerdo</b>. Esta cláusula no prohíbe la comunicación veraz con las fuerzas del orden, las agencias reguladoras o mi abogado con licencia según lo permita la ley.<br><br>

<b>VIGENCIA Y VALIDEZ</b><br>
Esta renuncia permanecerá <b>válida de forma indefinida</b> para el firmante y cualquier menor indicado a continuación, a menos que y hasta que la Compañía emita una renuncia actualizada o modifique sus términos, atracciones o políticas. La Compañía se reserva el derecho de requerir una nueva firma en cualquier momento para reflejar dichas actualizaciones o cambios en la ley, las operaciones o el reconocimiento de riesgos.<br><br>

<b>RESOLUCIÓN DE DISPUTAS Y JURISDICCIÓN</b><br>
Antes de iniciar cualquier acción legal, acepto intentar una <b>mediación de buena fe</b> en el <b>Condado de Lee, Florida</b>, a través de United States Arbitration & Mediation u otro foro neutral mutuamente acordado. Si se procede con un litigio, <b>la jurisdicción corresponderá exclusivamente al Condado de Lee, Florida</b>, y la parte vencedora recuperará los honorarios y costos razonables de abogados. <b>Renuncio al derecho a un juicio por jurado</b>.<br><br>

<b>DIVISIBILIDAD</b><br>
Si alguna parte de este Acuerdo se considera inválida, el resto continuará en pleno vigor y efecto.<br><br>

<b>RECONOCIMIENTO FINAL</b><br>
He leído este Acuerdo en su totalidad, entiendo sus términos y lo firmo voluntariamente. Entiendo que, al firmar, estoy <b>renunciando a derechos legales sustanciales</b>, incluido el derecho a demandar por negligencia ordinaria, por mí mismo y por cualquier menor indicado a continuación. Ninguna declaración o manifestación verbal modifica este documento escrito.<br><br>

© HeadPinz Entertainment & FastTrax Entertainment – Florida<br>`;

const ES_GUARDIAN_BOX = `<div style="border:2pt solid #000000; background:#ededed; padding:14px 16px; margin:0 0 16px;">
<div style="text-align:center; font-size:18pt; font-weight:bold; line-height:1.3; margin-bottom:12px;">AVISO AL TUTOR NATURAL DEL MENOR</div>
<div style="font-size:18pt; font-weight:bold; line-height:1.5;">LEA ESTE FORMULARIO COMPLETA Y CUIDADOSAMENTE. USTED ESTÁ ACEPTANDO PERMITIR QUE SU HIJO MENOR PARTICIPE EN UNA ACTIVIDAD POTENCIALMENTE PELIGROSA. USTED ESTÁ ACEPTANDO QUE, INCLUSO SI HeadPinz Entertainment, FastTrax Entertainment Y Bowling Management Associates ACTÚAN CON CUIDADO RAZONABLE AL PROPORCIONAR ESTA ACTIVIDAD, EXISTE LA POSIBILIDAD DE QUE SU HIJO SUFRA LESIONES GRAVES O LA MUERTE AL PARTICIPAR EN ESTA ACTIVIDAD, PORQUE HAY CIERTOS PELIGROS INHERENTES A LA ACTIVIDAD QUE NO PUEDEN EVITARSE NI ELIMINARSE. AL FIRMAR ESTE FORMULARIO USTED RENUNCIA AL DERECHO DE SU HIJO Y A SU PROPIO DERECHO DE RECUPERAR DE HeadPinz Entertainment, FastTrax Entertainment Y Bowling Management Associates EN UNA DEMANDA POR CUALQUIER LESIÓN PERSONAL, INCLUIDA LA MUERTE, DE SU HIJO, O POR CUALQUIER DAÑO A LA PROPIEDAD QUE RESULTE DE LOS RIESGOS QUE SON PARTE NATURAL DE LA ACTIVIDAD. USTED TIENE EL DERECHO DE NEGARSE A FIRMAR ESTE FORMULARIO, Y HeadPinz Entertainment, FastTrax Entertainment Y Bowling Management Associates TIENEN EL DERECHO DE NEGARSE A PERMITIR QUE SU HIJO PARTICIPE SI USTED NO FIRMA ESTE FORMULARIO.</div>
</div>`;

/* ── Assembly ────────────────────────────────────────────────────────────── */

function body(variant: WaiverVariant, lang: WaiverLang): string {
  const head = lang === "es" ? ES_HEAD : EN_HEAD;
  const tail = lang === "es" ? ES_TAIL : EN_TAIL;
  const box = lang === "es" ? ES_GUARDIAN_BOX : EN_GUARDIAN_BOX;
  // Minor = adult text with the guardian-notice box between MINORS and LIMITATIONS.
  return variant === "minor" ? `${head}${box}${tail}` : `${head}${tail}`;
}

const NAME: Record<WaiverVariant, string> = {
  adult: "Adult Release & Waiver of Liability",
  minor: "Minor Release & Waiver of Liability",
};

/** Which template applies for an age. Mirrors the minor/guardian gate elsewhere. */
export function waiverVariantForAge(age: number | null | undefined): WaiverVariant {
  return age != null && age < 18 ? "minor" : "adult";
}

/**
 * The in-house template for an (age, lang), shaped exactly like the BMI
 * `PandoraWaiverTemplate` so every existing caller (WaiverSigning, onboarding)
 * is untouched. `contentID` is a synthetic id encoding variant+lang+version so
 * the signed record + BMI reconciliation can identify precisely what was shown.
 */
export function inhouseWaiverTemplate(age: number, lang: WaiverLang): PandoraWaiverTemplate {
  const variant = waiverVariantForAge(age);
  return {
    id: `inhouse:${variant}:${lang}:${WAIVER_VERSION}`,
    contentID: `inhouse:${variant}:${lang}:${WAIVER_VERSION}`,
    name: NAME[variant],
    duration: WAIVER_DURATION_DAYS,
    body: body(variant, lang),
  };
}
