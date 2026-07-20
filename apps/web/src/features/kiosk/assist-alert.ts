import { z } from "zod";

/**
 * Guest-assistance radio alerts (owner 2026-07-20): when a guest taps
 * "Guest assistance" on a kiosk, speak an alert on the venue's staff Zello
 * radios via the soteria-alerts service, and keep repeating (client re-POSTs
 * every 30s) until staff taps Clear on the kiosk.
 *
 * The soteria service (bma-soteria-alerts.azurewebsites.net, source at
 * c:\GIT\soteria-alerts) plays each POST twice: the message verbatim, then
 * "<message>. Please advise who is responding." ~5s apart. Its dedup is
 * jobId-based: a repeat POST with the same `name` is a silent no-op while the
 * completed job is still retained (`cooldown` seconds, swept every 10s) — so
 * the cooldown here MUST stay comfortably under the client's 30s repeat
 * interval or every other repeat gets swallowed.
 *
 * A 200 from the service does NOT guarantee audio: jobs get 3 attempts and
 * are dropped if the bot's Zello socket is down through all of them. The 30s
 * repeat is also the recovery mechanism for that.
 */

export const assistAlertSchema = z.object({
  center: z.enum(["fort-myers", "naples"]),
  brand: z.enum(["fasttrax", "headpinz"]),
  kioskNumber: z.number().int().positive(),
  /** "help" = guest tapped the assistance button; "card-error" = the card
   *  dispenser hold-faulted and the kiosk raised the beacon itself. */
  reason: z.enum(["help", "card-error"]).default("help"),
});

export type AssistAlertInput = z.infer<typeof assistAlertSchema>;

const RADIO_ALERT_URL = "https://bma-soteria-alerts.azurewebsites.net/radio";

/** Seconds the soteria service dedups a repeated alert `name`. Must be well
 *  under the kiosk's 30s repeat so each repeat actually plays (the sweep that
 *  frees the jobId runs every 10s, so worst-case release is cooldown+10s). */
const DEDUP_COOLDOWN_SECONDS = 15;

/** Which radio server (Zello network) covers this kiosk's venue. FastTrax and
 *  HeadPinz Fort Myers share a building but run separate radio channels. */
export function radioServerFor(input: Pick<AssistAlertInput, "center" | "brand">): string {
  if (input.center === "naples") return "HPN";
  return input.brand === "fasttrax" ? "FT" : "HPFM";
}

/** Spoken kiosk name. At HPFM the number encodes the zone (owner 2026-07-20):
 *  numbers under 10 are Game Zone kiosks, 10 and up are bowling kiosks. */
export function kioskLabel(input: Omit<AssistAlertInput, "reason">): string {
  if (radioServerFor(input) === "HPFM") {
    return input.kioskNumber < 10
      ? `Game Zone kiosk ${input.kioskNumber}`
      : `bowling kiosk ${input.kioskNumber}`;
  }
  return `kiosk ${input.kioskNumber}`;
}

export function buildAssistAlert(input: AssistAlertInput): {
  server: string;
  target: string;
  priority: number;
  message: string;
  name: string;
  cooldown: number;
} {
  return {
    server: radioServerFor(input),
    target: "FOH",
    priority: 1,
    message:
      input.reason === "card-error"
        ? `Card error at ${kioskLabel(input)}`
        : `Guest needs assistance at ${kioskLabel(input)}`,
    // Dedup key — the service prefixes it with the server, so per-venue
    // uniqueness only needs the kiosk number. Deliberately reason-agnostic:
    // one kiosk never streams two overlapping alert series.
    name: `KioskAssist${input.kioskNumber}`,
    cooldown: DEDUP_COOLDOWN_SECONDS,
  };
}

/** Fire one radio alert. Never throws — the assist beacon on the kiosk must
 *  hold regardless, and the 30s repeat retries any miss. */
export async function sendAssistAlert(input: AssistAlertInput): Promise<boolean> {
  try {
    const res = await fetch(RADIO_ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildAssistAlert(input)),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
