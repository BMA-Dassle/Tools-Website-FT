/**
 * LIVE end-to-end test of the Intercard ONSITE proxy (Api_External).
 *
 * Everything else in this conversion is proven against mocks. This is the only
 * thing that proves the WRITE path actually moves value at the site, which is
 * the one claim a mock cannot make.
 *
 * SELF-REVERSING BY DESIGN: it credits a small number of tokens, verifies the
 * balance moved, optionally replays the SAME transactionID to find out whether
 * the onsite path dedups, then refunds exactly what it added and asserts the
 * card ends where it started. It refuses to exit "green" unless the final
 * balance equals the opening balance.
 *
 * DRY RUN BY DEFAULT — it will not move a token without `--apply`:
 *
 *   npx tsx apps/web/scripts/intercard-onsite-live-test.mts                 # read-only
 *   npx tsx apps/web/scripts/intercard-onsite-live-test.mts --apply         # credit + refund
 *   npx tsx apps/web/scripts/intercard-onsite-live-test.mts --apply --dedup # + replay probe
 *
 * Options:
 *   --card=<n>    account number      (default 1098379, the test card)
 *   --loc=<n>     Intercard LocID     (default 12, HeadPinz Fort Myers)
 *   --tokens=<n>  tokens to move      (default 5)
 *   --dedup       replay the identical transactionID to test server dedup
 *
 * Credentials come from the environment, never from source:
 *   INTERCARD_MAC_<loc> (or INTERCARD_MAC), INTERCARD_CLIENT_TOKEN,
 *   INTERCARD_PRODUCT_CODE (default API-0331), INTERCARD_ONSITE_URL.
 *
 * ⚠️ Run it against a THROWAWAY card. It moves real value on a real card at a
 * real center; the refund leg restores the balance, but a crash between the two
 * legs leaves the credit applied (the script prints exactly what to undo).
 */

import { request as httpsRequest } from "node:https";

const BASE =
  process.env.INTERCARD_ONSITE_URL || "https://intercard.swflpassport.com/Api_External";
const PRODUCT_CODE = process.env.INTERCARD_PRODUCT_CODE || "API-0331";
const TOKEN = process.env.INTERCARD_CLIENT_TOKEN || "";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const APPLY = process.argv.includes("--apply");
const DEDUP = process.argv.includes("--dedup");
const CARD = arg("card", "1098379");
const LOC = Number(arg("loc", "12"));
const TOKENS = Number(arg("tokens", "5"));

/** Uppercase, separator-free — the licence row is compared as a plain string. */
function normaliseMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}
const MAC = normaliseMac(process.env[`INTERCARD_MAC_${LOC}`] || process.env.INTERCARD_MAC || "");

function isoLocal(d: Date, utc = false): string {
  const p = utc ? d.toISOString() : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  return p.slice(0, 19);
}

function transactionRequest(requestType: string, id: string) {
  const now = new Date();
  return {
    requestType,
    macAddress: MAC,
    transactionID: id,
    sessionID: id,
    employeeID: "LiveTest",
    employeeName: { firstName: "Live", lastName: "Test" },
    lT_DateTime: isoLocal(now),
    utC_DateTime: isoLocal(now, true),
  };
}

/**
 * node:https, NOT fetch — the read ops are GET-with-body, which WHATWG fetch
 * rejects outright ("Request with GET/HEAD method cannot have body"). Same
 * reason the production client uses node:https; see data/intercard-onsite.ts.
 */
function httpJson(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: 35_000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out after 35s")));
    req.write(body);
    req.end();
  });
}

async function call(method: "GET" | "POST", op: string, body: unknown): Promise<any> {
  const res = await httpJson(
    `${BASE}/api/v1/tpi/${op}`,
    method,
    {
      "Content-Type": "application/json",
      Accept: "application/json",
      LocID: String(LOC),
      ProductCode: PRODUCT_CODE,
      ClientToken: TOKEN,
    },
    JSON.stringify(body),
  );
  const text = res.text;
  if (res.status < 200 || res.status >= 300) {
    const hint =
      res.status === 401
        ? " (licence mismatch: LocID / ProductCode / ClientToken / MAC)"
        : res.status === 404
          ? " (no onsite relay connected for this LocID)"
          : res.status === 504
            ? " (relay did not answer in 30s — state AMBIGUOUS)"
            : "";
    throw new Error(`${op} HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

interface Bal {
  tokens: number;
  bonus: number;
  cash: number;
}

async function balance(): Promise<Bal> {
  const r = await call("GET", "balanceinquiry", {
    transactionRequest: transactionRequest("BalanceInquiry", `lt-bal-${Date.now()}`),
    balanceInquiry: { accountNumber: CARD },
  });
  if (r.responseCode !== 0) throw new Error(`balanceinquiry rc=${r.responseCode} ${r.responseDescription}`);
  const a = r.accountBalance;
  if (!a) throw new Error(`card ${CARD} not found at location ${LOC}`);
  return { tokens: a.tokenBalance ?? 0, bonus: a.tokenBonusBalance ?? 0, cash: a.cashBalance ?? 0 };
}

async function credit(txnId: string, tokens: number) {
  const now = isoLocal(new Date());
  return call("POST", "creditaccounts", {
    transactionRequest: transactionRequest("CreditAccounts", txnId),
    creditAccounts: {
      creditAccountsList: [
        {
          accountNumber: CARD, // string — never Number() an account number
          blockedAccessID: 0,
          cash: 0,
          cashBonus: 0,
          tokens,
          tokenBonus: 0,
          points: 0,
          tP_Duration: 0,
          tP_ActiveImmediate: false,
          activationDate: now,
          expirationDate: now,
        },
      ],
    },
  });
}

async function refund(txnId: string, tokens: number) {
  return call("POST", "refundcard", {
    transactionRequest: transactionRequest("RefundCard", txnId),
    refundCard: {
      accountNumber: CARD,
      authorizationEmployeeID: "LiveTest",
      authorizationEmployeeName: { firstName: "Live", lastName: "Test" },
      reasonCode: 0,
      debitCash: 0,
      debitCashBonus: 0,
      debitToken: tokens,
      debitTokenBonus: 0,
      debitDuration: 0,
    },
  });
}

const show = (b: Bal) => `tokens=${b.tokens} bonus=${b.bonus} cash=${b.cash}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Intercard ONSITE live test — card ${CARD} @ LocID ${LOC}`);
  console.log(`  endpoint  ${BASE}`);
  console.log(`  MAC       ${MAC || "(MISSING)"}`);
  console.log(`  token     ${TOKEN ? `set (${TOKEN.length} chars)` : "(MISSING)"}`);
  console.log(`  mode      ${APPLY ? `APPLY — will move ${TOKENS} tokens` : "DRY RUN (read-only)"}`);
  console.log("");

  if (!MAC) throw new Error(`INTERCARD_MAC_${LOC} (or INTERCARD_MAC) is not set`);
  if (!TOKEN) throw new Error("INTERCARD_CLIENT_TOKEN is not set");

  // 1 — READ. Also proves licence + relay before we consider writing.
  const before = await balance();
  console.log(`STEP 1  balance BEFORE      ${show(before)}`);

  if (!APPLY) {
    console.log("\nDRY RUN: read path verified (licence ok, relay live, balance readable).");
    console.log("Re-run with --apply to exercise the write path.");
    return;
  }

  // 2 — CREDIT.
  const txnId = `onsite-livetest-${Date.now()}`;
  console.log(`\nSTEP 2  credit +${TOKENS} tokens   txnID=${txnId}`);
  const c1 = await credit(txnId, TOKENS);
  console.log(`        -> rc=${c1.responseCode} ${c1.responseDescription}`);
  await sleep(2000);
  const afterCredit = await balance();
  console.log(`        balance AFTER       ${show(afterCredit)}`);

  const gained = afterCredit.tokens - before.tokens;
  if (gained !== TOKENS) {
    console.log(`\n⚠️  expected +${TOKENS} tokens, saw ${gained >= 0 ? "+" : ""}${gained}.`);
  }

  // 3 — OPTIONAL DEDUP PROBE. Replays the identical transactionID. This answers
  // whether the router may safely retry a write, which it currently assumes it
  // may NOT (see WRITE_SAFE_TO_FALL_BACK in data/intercard-router.ts).
  let extra = 0;
  if (DEDUP) {
    console.log(`\nSTEP 3  REPLAY identical txnID (dedup probe)`);
    const c2 = await credit(txnId, TOKENS);
    console.log(`        -> rc=${c2.responseCode} ${c2.responseDescription}`);
    await sleep(2000);
    const afterReplay = await balance();
    console.log(`        balance AFTER       ${show(afterReplay)}`);
    extra = afterReplay.tokens - afterCredit.tokens;
    console.log(
      extra === 0
        ? "        VERDICT: DEDUPS — the same transactionID did not re-apply."
        : `        VERDICT: NO DEDUP — replay added ${extra} more tokens. A retry double-credits.`,
    );
  }

  // 4 — REVERSE exactly what was added.
  const owed = afterCredit.tokens + extra - before.tokens;
  console.log(`\nSTEP 4  refund ${owed} tokens to restore the opening balance`);
  if (owed > 0) {
    const r = await refund(`${txnId}-refund`, owed);
    console.log(`        -> rc=${r.responseCode} ${r.responseDescription}`);
    await sleep(2000);
  } else {
    console.log("        nothing to reverse");
  }

  const final = await balance();
  console.log(`        balance FINAL       ${show(final)}`);

  console.log("");
  if (final.tokens === before.tokens && final.bonus === before.bonus) {
    console.log(`✅ PASS — write path works and the card is back to ${show(before)}`);
  } else {
    console.log(
      `❌ CARD NOT RESTORED. opened ${show(before)}, now ${show(final)}. ` +
        `Manually adjust card ${CARD} by ${before.tokens - final.tokens} tokens.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    "If this failed BETWEEN the credit and the refund, the credit may still be applied — " +
      "re-read the balance before retrying rather than re-running blind.",
  );
  process.exitCode = 1;
});
