/**
 * Does Vercel Queues actually work on THIS account? Send + receive, round trip.
 *
 * Uses a THROWAWAY topic (`waiver-push-probe`) on purpose — never `waiver-push`
 * (production) and never `waiver-push-preview` (a real deployment consumes that).
 * Nothing subscribes to this topic, so the message is inert and expires on its own.
 *
 * Answers three things I had been telling the owner to go check in the dashboard:
 *   1. Is Queues enabled for this team at all?
 *   2. Does the local OIDC token authenticate?
 *   3. Does delaySeconds + receive actually round-trip a payload?
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// A refreshed token can be handed in via VERCEL_OIDC_TOKEN_FILE — the one baked
// into .env.local is typically months stale (12h life), which reads as "Queues is
// off" when it is really just an expired credential.
const tokenFile = process.env.VERCEL_OIDC_TOKEN_FILE;
if (tokenFile) {
  process.env.VERCEL_OIDC_TOKEN = readFileSync(tokenFile, "utf8").trim();
}
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const TOPIC = "waiver-push-probe";
const tok = process.env.VERCEL_OIDC_TOKEN || "";
console.log(`\nOIDC token present: ${tok ? `yes (${tok.length} chars)` : "NO"}`);
if (tok) {
  // Tokens are ~12h. An expired one is the most likely local failure, and it looks
  // like an auth error rather than "Queues is off" — worth telling apart up front.
  try {
    const payload = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString());
    if (payload.exp) {
      const mins = Math.round((payload.exp * 1000 - Date.now()) / 60000);
      console.log(
        `  expires: ${new Date(payload.exp * 1000).toISOString()} (${mins} min from now)${
          mins < 0 ? "  <-- EXPIRED, run `npx vercel env pull` to refresh" : ""
        }`,
      );
    }
    if (payload.sub) console.log(`  subject: ${payload.sub}`);
  } catch {
    console.log("  (could not decode token payload — continuing anyway)");
  }
}

const { QueueClient, PollingQueueClient } = await import("@vercel/queue");

/**
 * `deploymentId: null` OPTS OUT of deployment pinning.
 *
 * By default the SDK pins each message to the deployment that sent it, so only
 * that deployment's consumer can receive it. Outside a Vercel function there is no
 * VERCEL_DEPLOYMENT_ID at all, which is why the bare `send()` refused to run here.
 */
const { send } = new QueueClient({
  region: process.env.VERCEL_REGION || "iad1",
  deploymentId: null,
});

console.log(`\n--- SEND to "${TOPIC}" ---`);
let messageId: string | null = null;
try {
  const res = await send(
    TOPIC,
    { probe: true, note: "connectivity check, no consumer" },
    { delaySeconds: 0, retentionSeconds: 120 },
  );
  messageId = res.messageId ?? null;
  console.log(`  OK  messageId=${messageId}`);
} catch (err) {
  const name = err instanceof Error ? err.name : "unknown";
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  FAILED  ${name}: ${msg}`);
  console.log(
    name === "UnauthorizedError"
      ? "\n  => auth problem. Either the OIDC token is stale (npx vercel env pull) or\n     Queues is not enabled for this team."
      : "\n  => not an auth error; see the message above.",
  );
  process.exit(1);
}

console.log(`\n--- RECEIVE from "${TOPIC}" ---`);
try {
  const { receive } = new PollingQueueClient({
    region: process.env.VERCEL_REGION || "iad1",
    // Same opt-out as the sender — a pinned message is only visible to the
    // deployment that sent it, and there is no deployment here.
    deploymentId: null,
  });
  const result = await receive(TOPIC, "probe-consumer", async (message, metadata) => {
    console.log(`  got messageId=${metadata.messageId} delivery=${metadata.deliveryCount}`);
    console.log(`  payload=${JSON.stringify(message)}`);
  });
  console.log(`  result ok=${result.ok}${result.ok ? "" : ` reason=${result.reason}`}`);
  if (!result.ok && result.reason === "empty") {
    console.log("  (empty is fine — delivery is not instant; the SEND is what proves access)");
  }
} catch (err) {
  console.log(`  receive failed: ${err instanceof Error ? `${err.name}: ${err.message}` : err}`);
}
console.log("");
