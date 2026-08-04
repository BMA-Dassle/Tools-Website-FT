/**
 * Follow-up to offer166-1am-probe: the Unlimited create 409'd with
 * "UnlimitedType not valid: ClosingTime". Try request-shape variants to
 * pin whether it's our payload or the offer's Conqueror-side config.
 * Also probe sibling closing offers 167/177 the same way.
 * Temporary holds only; deleted immediately on success.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const raw = readFileSync(resolve(APP_ROOT, ".env.local"), "utf8");
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { createReservation, deleteReservation } = await import("@/lib/qamf-bowling");

const CENTER = 9172;
const BOOKED_AT = "2026-08-02T01:00:00-04:00";
const PROBE_TITLE = "ZZZ API PROBE - auto-deletes";

interface Variant {
  label: string;
  offerId: number;
  options: { Unlimited?: { Id: number }[] };
}
const variants: Variant[] = [
  { label: "166 no options block", offerId: 166, options: {} },
  { label: "167 (Regular closing) with Unlimited 167", offerId: 167, options: { Unlimited: [{ Id: 167 }] } },
  { label: "177 (Regular closing 2) with Unlimited 177", offerId: 177, options: { Unlimited: [{ Id: 177 }] } },
];

for (const v of variants) {
  try {
    const r = await createReservation(CENTER, {
      BookedAt: BOOKED_AT,
      Title: PROBE_TITLE,
      Notes: `offer166-variant-probe: ${v.label}`,
      WebOffer: { Id: v.offerId, Options: v.options, Services: ["BookForLater"] },
      TotalPlayers: 2,
    });
    console.log(`${v.label}: CREATED ${r.Id} status=${r.Status} lanes=${JSON.stringify(r.Lanes?.map((l) => l.LaneNumber))}`);
    await deleteReservation(CENTER, String(r.Id));
    console.log(`  deleted ${r.Id}`);
  } catch (err) {
    console.log(`${v.label}: FAILED — ${(err instanceof Error ? err.message : String(err)).slice(0, 220)}`);
  }
}
process.exit(0);
