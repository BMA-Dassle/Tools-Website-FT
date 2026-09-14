/**
 * The Conversations list is one entry per PERSON across texts AND email.
 * It read `crm_sms_threads` alone, so an emailed-but-never-texted guest was
 * invisible (owner: "why nothing showing under conversasions").
 */
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { loadConversations } = await import("../src/features/crm/sms/service/threads.js");
const { listReps } = await import("../src/features/crm/reps/index.js");

const reps = await listReps({ includeInactive: true });
for (const scope of [{ kind: "team" as const }, { kind: "rep" as const, repId: "7" }]) {
  const page = await loadConversations({ scope, reps });
  const label = scope.kind === "team" ? "team" : `rep ${scope.repId}`;
  console.log(`${label}: ${page.conversations.length} conversations`);
  for (const c of page.conversations)
    console.log(
      `   ${(c.name ?? (c.phoneE164 || "(unknown)")).padEnd(20)} ` +
        `channels=${c.channels.join("+").padEnd(10)} emails=${c.emailCount}  last=${c.lastMessageAt}`,
    );
}
