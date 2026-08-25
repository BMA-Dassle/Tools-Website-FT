/**
 * bmi-office-token-lifetime — LIVE, READ-ONLY.
 *
 * Answers "will the leaked BMI sessions drain on their own, or do we have to
 * get them killed?" by measuring what /auth/token actually grants.
 *
 * Why this is the question. Our code assumes a 24h token
 * (`parseInt(data.expires_in || "86400")`). If a BMI session is pinned to a
 * TOKEN rather than to `x-session-id`, then the real driver of connection
 * exhaustion is how many tokens we mint and how long each stays valid — and
 * before today the scan minted 2 per run, every 60s, because its token cache is
 * a single global slot that both centers evict from each other. That is ~2,880
 * tokens a day; at a 24h lifetime they all overlap.
 *
 * Prints lifetime only — never the token, and never the password.
 *
 * Deliberately does NOT probe for /auth/logout or /auth/revoke. A working call
 * there could disconnect staff on the Office UI mid-transaction, and poking
 * undocumented auth endpoints on a vendor's production system during an
 * incident they already reported is theirs to authorise, not ours to discover.
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-office-token-lifetime.ts
 */

import https from "https";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

const envUser = process.env.BMI_OFFICE_USERNAME;
const envPass = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD;
if (!envUser || !envPass) {
  console.error("Need BMI_OFFICE_USERNAME and BMI_OFFICE_PASSWORD(_B64) — use --env-file.");
  process.exit(2);
}
const OFFICE_USER: string = envUser;
const OFFICE_PASS: string = envPass;

function req(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
      },
    );
    r.on("error", reject);
    r.setTimeout(45_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

const hhmm = (secs: number) => {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return `${h}h ${m}m`;
};

async function main() {
  console.log("BMI Office /auth/token — what does one auth actually grant?\n");

  for (const ck of ["headpinzftmyers", "headpinznaples"]) {
    const res = await req(
      "POST",
      "/auth/token",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        clientkey: ck,
        "x-fast-version": SMS_VERSION,
      },
      `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
    );
    if (res.status !== 200) {
      console.log(`${ck}: auth → ${res.status}`);
      continue;
    }
    const data = JSON.parse(res.body) as Record<string, unknown>;
    // Field names only — the token itself never gets printed.
    const fields = Object.keys(data);
    const expiresIn = Number(data.expires_in ?? 0);
    console.log(`${ck}:`);
    console.log(`   response fields: ${fields.join(", ")}`);
    console.log(
      `   expires_in: ${expiresIn || "(absent)"}${expiresIn ? ` = ${hhmm(expiresIn)}` : ""}` +
        (expiresIn ? "" : "  → our code would default to 86400 (24h)"),
    );
    if (typeof data[".issued"] === "string") console.log(`   .issued:  ${data[".issued"]}`);
    if (typeof data[".expires"] === "string") console.log(`   .expires: ${data[".expires"]}`);

    // If it is a JWT, its own exp claim is the authority over expires_in.
    const tok = String(data.access_token ?? "");
    const parts = tok.split(".");
    if (parts.length === 3) {
      try {
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
          exp?: number;
          iat?: number;
        };
        if (claims.exp && claims.iat) {
          console.log(
            `   JWT exp-iat: ${claims.exp - claims.iat}s = ${hhmm(claims.exp - claims.iat)}`,
          );
        }
        console.log(`   JWT claim keys: ${Object.keys(claims).join(", ")}`);
      } catch {
        console.log("   (opaque token, not a readable JWT)");
      }
    } else {
      console.log(`   token shape: opaque, ${tok.length} chars (not a JWT)`);
    }

    // Does a second auth reuse the same grant or mint another one? If every
    // call mints a distinct token, each is its own server-side session.
    const again = await req(
      "POST",
      "/auth/token",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        clientkey: ck,
        "x-fast-version": SMS_VERSION,
      },
      `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
    );
    if (again.status === 200) {
      const t2 = String((JSON.parse(again.body) as Record<string, unknown>).access_token ?? "");
      console.log(
        `   re-auth mints a DIFFERENT token: ${t2 !== tok}` +
          (t2 !== tok
            ? "  → every re-auth is a new grant to track"
            : "  → server reuses the grant"),
      );
    }
    console.log();
  }

  console.log(
    "Read alongside: lib/bmi-scan.ts and lib/bmi-office-actions.ts cache the token in a\n" +
      "SINGLE global slot keyed by clientKey, so looping both centers evicts on every\n" +
      "iteration and re-auths every run. That is the multiplier to fix next.",
  );
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
