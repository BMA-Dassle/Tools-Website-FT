/**
 * Follow-up: does createReservation accept the ClosingTime Unlimited offer
 * (FM 166, Midnight Madness VIP) under a different api-version?
 * Pinned "2025-12-01.1.0" 409s "UnlimitedType not valid: ClosingTime".
 * Try 1.1 (requested), plus 1.0/1.2/1.3 for completeness.
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

const { qamfAuthedFetch } = await import("@/lib/qamf-bowling-auth");

const BASE = "https://api.qubicaamf.com/bowling-reservations";
const CENTER = 9172;
const BOOKED_AT = "2026-08-02T01:00:00-04:00";
const PROBE_TITLE = "ZZZ API PROBE - auto-deletes";

const body = {
  BookedAt: BOOKED_AT,
  Title: PROBE_TITLE,
  Notes: "offer166-apiver-probe",
  WebOffer: { Id: 166, Options: { Unlimited: [{ Id: 166 }] }, Services: ["BookForLater"] },
  TotalPlayers: 2,
};

for (const ver of ["1.1", "1.0", "1.2", "1.3"]) {
  let status = 0;
  let text = "";
  try {
    // qamfAuthedFetch throws on !ok — catch and report the status/body either way
    const res = await qamfAuthedFetch(
      (token, subKey) => {
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          "api-version": ver,
          "content-type": "application/json",
        };
        if (subKey) headers["Ocp-Apim-Subscription-Key"] = subKey;
        return fetch(`${BASE}/centers/${CENTER}/reservations`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          cache: "no-store",
        });
      },
      `create@${ver}`,
      CENTER,
    );
    status = res.status;
    text = await res.text();
  } catch (err) {
    console.log(`api-version ${ver}: FAILED — ${(err instanceof Error ? err.message : String(err)).slice(0, 260)}`);
    continue;
  }
  const json = JSON.parse(text) as { Id?: unknown; Status?: string; ExpiresAt?: string; Lanes?: Array<{ LaneNumber?: number }> };
  const id = String(json.Id ?? "");
  console.log(
    `api-version ${ver}: CREATED (${status}) Id=${id} status=${json.Status} lanes=${JSON.stringify(json.Lanes?.map((l) => l.LaneNumber))} expires=${json.ExpiresAt}`,
  );
  const del = await qamfAuthedFetch(
    (token, subKey) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, "api-version": ver };
      if (subKey) headers["Ocp-Apim-Subscription-Key"] = subKey;
      return fetch(`${BASE}/centers/${CENTER}/reservations/${id}`, { method: "DELETE", headers, cache: "no-store" });
    },
    `delete@${ver}`,
    CENTER,
  );
  console.log(`  deleted ${id} -> ${del.status}`);
}
process.exit(0);
