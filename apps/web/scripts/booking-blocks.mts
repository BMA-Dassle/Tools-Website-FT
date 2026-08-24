/**
 * THE COMPANYWIDE DO-NOT-SELL LIST — add an identity, release one, or read it.
 *
 * Created 2026-08-24 because there was no mechanism anywhere in the app to
 * refuse a repeat chargeback abuser (verified: none of the 72 Neon tables was a
 * block list). Owner rule: block at EVERY deposit-taking path, not just
 * return-racer sign-in, so a banned party cannot re-book as a new guest.
 *
 *   npx tsx scripts/booking-blocks.mts                        # show the active list
 *   npx tsx scripts/booking-blocks.mts --all                  # incl. released
 *   npx tsx scripts/booking-blocks.mts --seed-0824 --apply    # the two 08/24 dispute parties
 *   npx tsx scripts/booking-blocks.mts --add=email:a@b.com --reason="..." --by=EO --apply
 *   npx tsx scripts/booking-blocks.mts --release=7 --by=EO --apply
 *   npx tsx scripts/booking-blocks.mts --test=email:a@b.com   # would this be blocked?
 *
 * Blocks match on identity, never on a typed name. Kinds: email, phone,
 * square_customer, bmi_person, card_fingerprint.
 *
 * The table is hand-editable if you prefer SQL:
 *   SELECT * FROM booking_blocks WHERE active;
 *   UPDATE booking_blocks SET active=false, released_at=now(), released_by='EO' WHERE id=7;
 *
 * DRY RUN BY DEFAULT — pass --apply to write. Run from apps/web.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
// THE GATE COMES FROM THE SHIPPED CODE — this script calls the same
// checkBookingBlock() the booking routes call, so "would this be blocked?" here
// and in production can never diverge.
//
// Runtime values come in through `await import()`, types through `import type`:
// a .mts entrypoint importing a CJS-transpiled .ts module cannot use static
// named imports for values. Same pattern as camera-return-peek.mts.
import type { BlockKind } from "../src/features/booking-blocks/types";

const { addBlock, ensureSchema, listBlocks, releaseBlock } =
  await import("../src/features/booking-blocks/data");
const { checkBookingBlock } = await import("../src/features/booking-blocks/service");
const { normalizeValue } = await import("../src/features/booking-blocks/normalize");

const APPLY = process.argv.includes("--apply");
const SHOW_ALL = process.argv.includes("--all");
const SEED = process.argv.includes("--seed-0824");

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const KIND_HELP = "email, phone, square_customer, bmi_person, card_fingerprint";
function parseKindValue(raw: string): { kind: BlockKind; value: string } {
  const i = raw.indexOf(":");
  if (i < 0) throw new Error(`expected kind:value, got "${raw}"`);
  const kind = raw.slice(0, i) as BlockKind;
  const value = raw.slice(i + 1);
  // normalizeValue throws on an unhandled kind (its switch is exhaustive) and
  // returns null on a malformed value — so this one call validates both.
  let normalized: string | null;
  try {
    normalized = normalizeValue(kind, value);
  } catch {
    throw new Error(`unknown kind "${kind}" — one of ${KIND_HELP}`);
  }
  if (!normalized) throw new Error(`"${value}" is not a valid ${kind}`);
  return { kind, value };
}

/* ── The two parties from the 2026-08-24 dispute batch ─────────────────
   Block 1 — "Mista Fee": 4 chargebacks / 3 cards / 8 days, $319.31, every one
   filed after the service was delivered. BMI person notes were written to all
   four racers the same day; these rows are what actually refuses the sale.
   Card fingerprints are included because this party CYCLED CARDS — email and
   phone alone did not stop visit 4.

   Block 2 — Jorvelus/Valmyr: bowling deposit + the food delivered to that same
   lane, both charged back. This party has NO BMI person record at all (QAMF +
   Square Online only), so the block list is the ONLY enforcement point.
   ────────────────────────────────────────────────────────────────────── */
const R1 = "4 chargebacks after service delivered, $319.31 (08/02-08/08 visits)";
const C1 =
  "grDf6FscgY5iQUKZlA1g3B, 38UZXGW30SRHngqwwwp80C, d5iVBJCG5UkWJhbSKvrilB, fJkdcVfqpxrJKHGyGkoPkB";
const R2 = "2 chargebacks in one evening, $109.69 (bowling deposit + food to the lane)";
const C2 = "BOPLZQueOiQkjmIXaacsBD, C08ZeB1JvRMSoRPb3bJqZ";

const SEED_ROWS: Array<{
  kind: BlockKind;
  value: string;
  center?: string | null;
  reason: string;
  caseRef: string;
}> = [
  // ── Block 1 — Mista Fee cluster ──
  { kind: "email", value: "tactics-spaces1s@icloud.com", reason: R1, caseRef: C1 },
  { kind: "email", value: "aircrew.foam04@icloud.com", reason: R1, caseRef: C1 },
  { kind: "email", value: "mistagetfee@icloud.com", reason: R1, caseRef: C1 },
  { kind: "phone", value: "2399899306", reason: R1, caseRef: C1 },
  { kind: "phone", value: "2398512480", reason: R1, caseRef: C1 },
  {
    kind: "card_fingerprint",
    value: "sq-1-WHfJEPhfa19VWmFZjDx416GUls1CaWZ1OhpdnJwZ6opjTjMg0X4iMpCQsdCJBDKUNQ",
    reason: `${R1} — VISA *2046`,
    caseRef: C1,
  },
  {
    kind: "card_fingerprint",
    value: "sq-1-5dtfKjTWXaXTSmqdJYQfgtSbDlO_xW3sHsP7fMjyCn4KRC4TQAwtKuEk4C_nghl-Dw",
    reason: `${R1} — VISA *2571`,
    caseRef: C1,
  },
  // The four racers, at the center their person ids belong to (per-server ids:
  // all four 404 at headpinznaples — verified 2026-08-24).
  { kind: "bmi_person", value: "57362761", center: "headpinzftmyers", reason: `${R1} — Suprihano Nelson`, caseRef: C1 },
  { kind: "bmi_person", value: "57362871", center: "headpinzftmyers", reason: `${R1} — Jasmine Marable`, caseRef: C1 },
  { kind: "bmi_person", value: "57362980", center: "headpinzftmyers", reason: `${R1} — Angelina Lugo`, caseRef: C1 },
  { kind: "bmi_person", value: "57363230", center: "headpinzftmyers", reason: `${R1} — Mario Leslie`, caseRef: C1 },

  // ── Block 2 — Jorvelus / Valmyr ──
  { kind: "email", value: "sjorvelus@gmail.com", reason: R2, caseRef: C2 },
  { kind: "email", value: "AllenValmyr30@gmail.com", reason: R2, caseRef: C2 },
  { kind: "phone", value: "2392404970", reason: R2, caseRef: C2 },
  { kind: "phone", value: "7867711626", reason: R2, caseRef: C2 },
  { kind: "square_customer", value: "XRDGWN5W9H21DCYHKCS9VC9W08", reason: R2, caseRef: C2 },
  {
    kind: "card_fingerprint",
    value: "sq-1-6ysCJ3tiDBOtsL-bBIiTG_FzDd3uBCeMhpzZukEbcuzyNygYBVcVi4nMHHsroCuT-w",
    reason: `${R2} — VISA *4524`,
    caseRef: C2,
  },
];

console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`);
await ensureSchema();

/* ── --test ── */
const test = arg("test");
if (test) {
  const { kind, value } = parseKindValue(test);
  const candidate =
    kind === "email"
      ? { email: value }
      : kind === "phone"
        ? { phone: value }
        : kind === "square_customer"
          ? { squareCustomerId: value }
          : kind === "bmi_person"
            ? { bmiPersonId: value, center: arg("center") }
            : { cardFingerprint: value };
  const d = await checkBookingBlock(candidate);
  console.log(`TEST ${kind}:${value} -> ${d.blocked ? "BLOCKED" : "allowed"}`);
  if (d.blocked) for (const m of d.matches) console.log(`   #${m.id} ${m.kind} — ${m.reason}`);
  process.exit(0);
}

/* ── --release ── */
const rel = arg("release");
if (rel) {
  const id = Number(rel);
  const by = arg("by") ?? "unknown";
  if (!Number.isInteger(id)) throw new Error(`--release must be a row id, got "${rel}"`);
  if (!APPLY) {
    console.log(`DRY RUN: would release row ${id} (by ${by})`);
  } else {
    const ok = await releaseBlock(id, by);
    console.log(ok ? `released row ${id}` : `row ${id} was not active — nothing changed`);
  }
}

/* ── --add ── */
const add = arg("add");
if (add) {
  const { kind, value } = parseKindValue(add);
  const reason = arg("reason");
  const by = arg("by");
  if (!reason) throw new Error("--add requires --reason=");
  if (!by) throw new Error("--add requires --by= (who imposed it)");
  if (!APPLY) {
    console.log(`DRY RUN: would add ${kind}:${value} (center ${arg("center") ?? "any"})`);
  } else {
    const r = await addBlock({
      kind,
      value,
      center: arg("center"),
      reason,
      caseRef: arg("case"),
      submittedBy: by,
    });
    console.log(r.inserted ? `added ${kind}:${r.value}` : `${kind}:${r.value} already active`);
  }
}

/* ── --seed-0824 ── */
if (SEED) {
  console.log(`Seeding ${SEED_ROWS.length} rows for the 2026-08-24 dispute batch\n`);
  let added = 0;
  let already = 0;
  for (const row of SEED_ROWS) {
    if (!APPLY) {
      console.log(`  DRY RUN  ${row.kind.padEnd(17)} ${row.value}${row.center ? `  @${row.center}` : ""}`);
      continue;
    }
    const r = await addBlock({
      kind: row.kind,
      value: row.value,
      center: row.center,
      reason: row.reason,
      caseRef: row.caseRef,
      submittedBy: "EO",
    });
    console.log(`  ${r.inserted ? "ADDED   " : "existing"} ${row.kind.padEnd(17)} ${r.value}${row.center ? `  @${row.center}` : ""}`);
    r.inserted ? added++ : already++;
  }
  if (APPLY) console.log(`\n  ${added} added, ${already} already present`);
}

/* ── the list ── */
const rows = await listBlocks(SHOW_ALL);
console.log(`\n═══ booking_blocks — ${rows.length} row(s)${SHOW_ALL ? " (incl. released)" : " active"} ═══`);
for (const r of rows) {
  const flag = r.active ? "ACTIVE  " : "released";
  console.log(
    `  #${String(r.id).padStart(3)} ${flag} ${r.kind.padEnd(17)} ${r.value}${r.center ? `  @${r.center}` : ""}`,
  );
  console.log(`        ${r.reason}`);
  if (r.caseRef) console.log(`        case: ${r.caseRef}`);
  console.log(`        by ${r.submittedBy} on ${r.createdAt.slice(0, 10)}${r.releasedAt ? `, released by ${r.releasedBy} on ${r.releasedAt.slice(0, 10)}` : ""}`);
}
if (!rows.length) console.log("  (empty)");
