/**
 * The racing licence's canonical strings — ONE definition each.
 *
 * WHY THIS FILE EXISTS. The scan payload was hand-assembled in two places
 * (`racing/wallet/licence-meta.ts` and `racing/service/racer-hub.ts`), so the
 * pass in a racer's wallet and the QR on their hub page were two independent
 * spellings of the same credential. Nothing made them agree. A third surface
 * would have made three.
 *
 * That matters more than ordinary duplication because the payload has ALREADY
 * been wrong once in production: the SMS-Timing app's own QR is a JSON array
 * (`https://smstim.in?["clientKey","uuid"]`) and the BMI register REJECTS it —
 * only the `authenticate` form scans at the register, the kiosk and the desk.
 * See `features/kiosk/qr-scanner/member-qr.ts` for both shapes.
 *
 * SERVER-ONLY: reads `SMSTIM_SITE`. Client components must be handed a
 * pre-built payload (or a server-rendered QR image), never import this.
 */

/** SMS-Timing site number for our club. Default matches the live value the
 *  register scans; overridable for a second club without a code change. */
function site(): string {
  return process.env.SMSTIM_SITE || "908";
}

/**
 * The string a racing licence barcode must contain.
 *
 * NOT the app's JSON-array payload — the register rejects that. Pinned by
 * `payload.test.ts`; change it only with a live register scan to prove it.
 */
export function memberQrPayload(code: string): string {
  return `https://smstim.in/${site()}/authenticate/?login_code=${code}`;
}

/** The racer's permanent page — what the pass's back field links to. */
export function licenceHubUrl(code: string, base?: string): string {
  const origin = base || process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com";
  return `${origin}/r/${code}`;
}
