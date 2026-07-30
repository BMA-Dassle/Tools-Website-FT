// Intercard <BonusCash> probe — the ONE unverified rail in the Game Zone
// comp-voucher build (see tasks/gamezone-voucher-plan.md §2, "Bucket").
//
// WHY THIS EXISTS. Shipped comp grants credit the BONUS TOKEN bucket
// (`<BonusTokens>`), which every production load already uses. The owner
// described these vouchers as "$10 BONUS cash", and Intercard does have a
// separate `<BonusCash>` bucket — but `creditAccountValues` has never been
// called with a non-zero cashBonus in production, so nothing proves:
//
//   Q1  Does TPICreditAccounts accept BonusCash > 0 at all (result code 0)?
//   Q2  What UNIT is it — dollars (10) or cents (1000)?
//   Q3  Does the credited value show up on a balance read, and under which
//       field? (verifyAccount currently surfaces TokenBalance /
//       TokenBonusBalance only — there may be a Cash/BonusCash balance tag we
//       don't parse yet.)
//   Q4  Is it spendable on games the same way bonus tokens are? (floor check)
//
// Until those are answered, do NOT set `bonusCashDollars` on a grant in
// vouchers/grants.ts — a guest would walk away with a card we believe is
// loaded and the floor does not.
//
// WRITE SAFETY: this CREDITS A REAL CARD. It is fully env-gated and defaults to
// a read-only balance dump. Use a scrap/test card, never a guest's.
//
//   npx tsx scripts/gz-voucher-bonuscash-probe.mts
//       # read-only: dump the card's balances + recent activity
//   GZ_PROBE_CREDIT_CASH=1 npx tsx scripts/gz-voucher-bonuscash-probe.mts
//       # + credit BONUS CASH (amount from GZ_PROBE_AMOUNT, default 1)
//
// Env: ACCOUNT (required), LOCATION_CODE (default 12 = FastTrax),
//      GZ_PROBE_AMOUNT (default 1 — probe small, the unit is the question).

import { creditAccountValues, verifyAccount } from "../src/features/game-cards/data/intercard";

const ACCOUNT = (process.env.ACCOUNT ?? "").trim();
const LOCATION_CODE = Number(process.env.LOCATION_CODE ?? 12);
const AMOUNT = Number(process.env.GZ_PROBE_AMOUNT ?? 1);
const DO_CREDIT = process.env.GZ_PROBE_CREDIT_CASH === "1";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function dump(label: string) {
  const v = await verifyAccount(ACCOUNT, LOCATION_CODE);
  console.log(`\n── ${label} ──`);
  console.log("exists:", v.exists, "account:", v.accountNumber);
  console.log("balance:", JSON.stringify(v.balance, null, 2));
  if (v.transactions?.length) {
    console.log("recent activity (newest first):");
    for (const t of v.transactions.slice(0, 5)) {
      console.log(
        `  ${t.timeStamp} ${t.transType ?? "?"} tokens=${t.tokens} bonus=${t.bonusTokens} ` +
          `points=${t.points} @${t.location ?? "?"}`,
      );
    }
  }
  return v;
}

async function main() {
  if (!ACCOUNT) die("set ACCOUNT=<card account number> (use a scrap card)");
  if (!Number.isFinite(LOCATION_CODE)) die("LOCATION_CODE must be a number");

  console.log(`Intercard BonusCash probe · account ${ACCOUNT} · location ${LOCATION_CODE}`);
  const before = await dump("BEFORE");

  if (!DO_CREDIT) {
    console.log(
      "\nRead-only. Re-run with GZ_PROBE_CREDIT_CASH=1 to credit " +
        `${AMOUNT} of BonusCash and diff the balance.`,
    );
    return;
  }

  // Stable id so a re-run is a dedup, not a second credit (Intercard dedups on
  // tpiTransactionID). Deliberately derived from the inputs, not random.
  const tpiTransactionID = `gzprobe-cash-${ACCOUNT}-${AMOUNT}`;
  console.log(`\n→ crediting cashBonus=${AMOUNT} (tpiTransactionID=${tpiTransactionID})`);
  const { code } = await creditAccountValues({
    locationCode: LOCATION_CODE,
    accountNumber: ACCOUNT,
    cashBonus: AMOUNT,
    tpiTransactionID,
  });
  console.log(`   result code: ${code} ${code === 0 ? "(success)" : "(FAILED — Q1 answered: no)"}`);
  if (code !== 0) return;

  const after = await dump("AFTER");
  console.log("\n── Answers ──");
  console.log(`Q1 accepted:      yes (code 0)`);
  console.log(
    `Q2/Q3 visible:    compare the two balance dumps above. If nothing moved, the value\n` +
      `                  exists but verifyAccount doesn't parse its tag — read the raw\n` +
      `                  TPIVerifyAccount XML for a Cash/BonusCash balance field before\n` +
      `                  trusting it.`,
  );
  console.log(`Q4 spendable:     needs a floor check — swipe the card on a game.`);
  console.log(
    `\nbefore=${JSON.stringify(before.balance)}\n after=${JSON.stringify(after.balance)}`,
  );
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
