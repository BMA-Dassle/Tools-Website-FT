/**
 * PIN-AT-CREATE TEST — does QAMF put a reservation on the lane WE choose?
 *
 * This is the question `qamf-lane-pin-probe.ts` was written for and never answered, and
 * it is the whole basis of same-day/kiosk lane arrangement. No caller has ever populated
 * `NewReservationInput.Lanes`, so every booking we have made took whatever lane QAMF chose.
 *
 * The engine picks the lane from real research — the full grid (schedule + live floor),
 * lane groups learned from history, the walk-in forecast, and the pair-inventory policy —
 * then we create the reservation pinned to it and check where it actually landed.
 *
 * SAFETY (matches the repo's probe convention):
 *   - Created as a **Temporary** hold, never Confirmed. QAMF expires these on its own in
 *     ~10 minutes, which is the crash backstop.
 *   - Titled so staff can see what it is at a glance.
 *   - DELETED in a finally block. NOTE: deleting a hold THIS SCRIPT just created is not
 *     the thing the move-only rule forbids — that rule protects real guest bookings from
 *     being deleted and recreated during rearrangement. Nothing here touches a guest.
 *   - Refuses to run against a lane that is not free for the whole window.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/lane-pin-create-test.mts --center 9172 --date 2026-08-26 --time 11:00
 *   npx tsx scripts/lane-pin-create-test.mts --center 9172 --date 2026-08-26 --time 11:00 --apply
 *   …--keep    leave the hold in place instead of deleting it (it still expires ~10 min)
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const {
  createReservation,
  deleteReservation,
  getReservation,
  listWebOffers,
  searchAvailability,
  searchReservations,
  toCenterLocalIso,
} = await import("@/lib/qamf-bowling");
const { buildGrid } = await import("~/features/lane-plan/grid.server");
const { deriveLaneGroups, allowedLanesFor } = await import("~/features/lane-plan/lane-groups");
const { buildOccupancyForecast, forecastAt } = await import("~/features/lane-plan/forecast");
const { chooseLanes } = await import("~/features/lane-plan/policy");
const { createWithLanePlan, describePinOutcome } = await import("~/features/lane-plan/pin");
const { spreadBias } = await import("~/features/lane-plan/score");
const { isLaneFree, wholeFreePairs, mateOf } = await import("~/features/lane-plan/grid");
const { DEFAULT_POLICY } = await import("~/features/lane-plan/types");

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const CENTER = Number(flag("center") ?? 9172);
const DATE = flag("date") ?? "2026-08-26";
const TIME = flag("time") ?? "11:00";
const PLAYERS = Number(flag("players") ?? 4);
const MINUTES = Number(flag("minutes") ?? 90);
const APPLY = args.includes("--apply");
const KEEP = args.includes("--keep");
/** Send NO `Lanes` at all — the baseline every booking we have ever made used. Answers
 *  "what would QAMF have done on its own?", which is what a pin has to be measured against. */
const NO_PIN = args.includes("--no-pin");
/** Deliberately pin onto an OCCUPIED lane to find out whether the vendor refuses it.
 *  Answers whether QAMF is a backstop or whether our grid is the only thing between a
 *  guest and a double-booked lane. Creates a Temporary hold only, deleted immediately. */
const COLLIDE = args.includes("--collide");
const VERIFY_DELAY_MS = Number(flag("delay") ?? 20_000);
const TITLE = flag("title") ?? `ZZZ LANE PIN TEST ${PLAYERS}p - auto-deletes`;

const startMs = Date.parse(`${DATE}T${TIME}:00.000-04:00`);
const endMs = startMs + MINUTES * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const et = (s: string | number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(s));

console.log(
  `\n=== PIN-AT-CREATE TEST — center ${CENTER} — ${et(startMs)} for ${MINUTES}min, ${PLAYERS}p ===`,
);
console.log(
  APPLY ? "MODE: APPLY (creates a Temporary hold, then deletes it)\n" : "MODE: preview only\n",
);

/* ---------- 1. what can we even book here? ---------- */

const iso = toCenterLocalIso(startMs);
const avail = await searchAvailability(CENTER, {
  BookedAtRange: { StartAt: iso, EndAt: iso },
  TotalPlayers: PLAYERS,
  WebOffer: { Services: ["BookForLater"] },
});
const offers = avail.Availabilities ?? [];
if (!offers.length) {
  console.log(`No availability at ${et(startMs)} — the center is not bookable then. Stopping.`);
  process.exit(1);
}
// The availability response gives option IDs but no durations — `Minutes` only appears on
// the web-offer detail. Build the id -> minutes map from there rather than assuming.
const catalogue = await listWebOffers(CENTER);
const minutesOf = new Map<number, number>();
const titleOf = new Map<number, string>();
for (const o of catalogue) {
  titleOf.set(Number(o.Id), o.Title ?? "");
  for (const t of o.Options?.Time ?? []) {
    if (typeof t.Minutes === "number") minutesOf.set(Number(t.Id), t.Minutes);
  }
}

type Pick = { offerId: number; optionId: number };
let chosen: Pick | null = null;
console.log(`Bookable at ${et(startMs)}:`);
for (const a of offers) {
  const offerId = Number(a.WebOffer?.Id);
  const opts = (a.WebOffer?.Options?.Time ?? []).map((t) => Number(t.Id));
  const described = opts.map((id) => `${id}=${minutesOf.get(id) ?? "?"}m`).join(" ");
  console.log(
    `  offer ${String(offerId).padStart(4)} "${titleOf.get(offerId) ?? ""}" ${described || "(no time options)"}`,
  );
  if (chosen) continue;
  const match = opts.find((id) => minutesOf.get(id) === MINUTES);
  if (match) chosen = { offerId, optionId: match };
}
if (!chosen) {
  console.log(
    `\nNo offer at ${et(startMs)} carries a ${MINUTES}-minute option. Try --minutes 60 or 120.`,
  );
  process.exit(1);
}
const offer = { Id: chosen.offerId, Title: titleOf.get(chosen.offerId) ?? "" };
const option = { Id: chosen.optionId };
console.log(
  `\nUsing offer ${offer.Id} "${offer.Title}" · time option ${option.Id} = ${MINUTES}min`,
);

/* ---------- 2. the research: grid, lane groups, forecast ---------- */

console.log(`\nReading the board and 60 days of history…`);
const history: Awaited<ReturnType<typeof searchReservations>> = [];
for (let i = 60; i >= 5; i -= 5) {
  try {
    history.push(
      ...(await searchReservations(
        CENTER,
        toCenterLocalIso(Date.now() - i * 86400000),
        toCenterLocalIso(Date.now() - (i - 5) * 86400000),
      )),
    );
  } catch {
    /* a missing chunk only weakens the lane groups */
  }
}
const raw = await buildGrid(CENTER, startMs - 60 * 60_000, endMs + 60 * 60_000);
const forecast = buildOccupancyForecast(history, raw.lanes.length);
const grid = { ...raw, forecast };
const groups = deriveLaneGroups(history);
const allowed = allowedLanesFor(groups, Number(offer.Id));

const busyDuring = new Set(
  grid.busy.filter((b) => b.startMs < endMs && startMs < b.endMs).map((b) => b.laneNumber),
);
console.log(
  `  ${grid.lanes.length} lanes · ${busyDuring.size} busy during the window · ` +
    `${grid.errorLanes.size} in Error · ${grid.openLanes.size} Open now`,
);
const evidence = groups.get(Number(offer.Id));
console.log(
  `  offer ${offer.Id} lane group: ${allowed ? `${allowed.length} lanes [${allowed.join(",")}]` : "unknown (too little history) — whole house allowed"}`,
);
if (evidence?.outliers.length) {
  console.log(
    `    discarded as noise: ${evidence.outliers.map((l) => `${l}(${evidence.counts.get(l)}x)`).join(" ")} ` +
      `— strays from staff moving a booking onto a lane inside Conqueror, which does not enforce the group`,
  );
}
const fc = forecastAt(forecast, startMs);
console.log(
  `  historical occupancy for this weekday/time: ${fc == null ? "n/a" : `${(fc * 100).toFixed(0)}%`}`,
);

/* ---------- 3. the engine picks ---------- */

const req = {
  laneCount: 1,
  startMs,
  endMs,
  players: PLAYERS,
  webOfferId: Number(offer.Id),
  allowedLanes: allowed,
};
const bias = spreadBias(grid, req, DEFAULT_POLICY);
const { best, ranked, reason } = chooseLanes(grid, req, DEFAULT_POLICY);
if (!best) {
  console.log(`\nEngine could not place: ${reason}. In production this fails open to QAMF.`);
  process.exit(1);
}
console.log(
  `\nSpread bias ${bias.toFixed(2)} (${bias > 0.15 ? "SPREAD" : bias < -0.15 ? "BACKFILL" : "balanced"}) · ` +
    `${wholeFreePairs(grid, startMs, endMs, undefined, allowed)} whole free pairs in the group`,
);
console.log(`\nTop candidates:`);
for (const p of ranked.slice(0, 5)) {
  const mate = mateOf(p.lanes[0]);
  const mateFree = isLaneFree(grid, mate, startMs, endMs);
  console.log(
    `  lane ${String(p.lanes[0]).padStart(2)} score ${p.score.toFixed(1).padStart(7)} · mate ${String(mate).padStart(2)} ${mateFree ? "free" : "BUSY"} · ` +
      Object.entries(p.terms)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join(" · "),
  );
}
/**
 * `--lane N` overrides the engine's choice.
 *
 * This is the CONTROL for the pin test. The engine naturally favours the lowest-numbered
 * lane in a tie, so on an empty board it picks the first lane of the group — which may
 * well be what QAMF would have auto-assigned anyway. Asking for a lane the engine would
 * NOT have chosen is the only way to prove the pin is what decided the outcome.
 */
const FORCED_LANES = (flag("lanes") ?? flag("lane") ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const FORCED = FORCED_LANES.length ? FORCED_LANES[0] : null;
const PICK = FORCED ?? best.lanes[0];
if (FORCED != null) {
  const rank = ranked.findIndex((p) => p.lanes[0] === FORCED);
  console.log(
    `\n  ==> LANE${FORCED_LANES.length > 1 ? `S ${FORCED_LANES.join(" -> ")}` : ` ${FORCED}`} FORCED ` +
      `(engine would have picked ${best.lanes[0]}) — ` +
      (rank < 0
        ? "first is NOT among the engine's candidates"
        : `first ranked #${rank + 1} of ${ranked.length}, score ${ranked[rank].score.toFixed(1)}`),
  );
  if (FORCED_LANES.length > 1) {
    console.log(
      `      walking in that exact order — each refusal must advance to the next, not abort`,
    );
  }
  if (allowed && !allowed.includes(FORCED)) {
    console.log(
      `  WARNING: lane ${FORCED} is outside offer ${offer.Id}'s derived group [${allowed.join(",")}] — expect 409 LanesNotCompatible.`,
    );
  }
} else {
  console.log(`\n  ==> ENGINE PICKS LANE ${PICK} — ${reason}`);
}

// Never pin onto something. Belt and braces on top of the scorer.
if (!isLaneFree(grid, PICK, startMs, endMs)) {
  const clashes = grid.busy.filter(
    (b) => b.laneNumber === PICK && b.startMs < endMs && startMs < b.endMs,
  );
  console.log(`\n  lane ${PICK} is NOT free for ${et(startMs)}-${et(endMs)}:`);
  for (const c of clashes) {
    console.log(
      `    ${c.reservationId} · ${c.kind || "?"} · ${et(c.startMs)}-${et(c.endMs)} · "${c.title}"`,
    );
  }
  if (!COLLIDE) {
    console.log(`  REFUSING. Pass --collide to probe deliberately (see below).`);
    process.exit(1);
  }
  /**
   * DELIBERATE COLLISION PROBE — the vendor-backstop question.
   *
   * If QAMF refuses a pin onto an occupied lane, it is a second line of defence and our
   * grid can be imperfect without anyone being double-booked. If it ACCEPTS, there is no
   * safety net: the grid must be right every single time, and the pre-write re-read plus
   * lock become load-bearing rather than belt-and-braces.
   *
   * This only ever creates a Temporary hold, which is deleted immediately. It cannot alter
   * or remove the booking already there.
   */
  console.log(`  --collide set: probing whether QAMF ITSELF refuses the double-book.`);
}

if (!APPLY) {
  console.log(
    `\nPreview only. Re-run with --apply to create a Temporary hold pinned to lane ${PICK}.\n`,
  );
  process.exit(0);
}

/* ---------- 4. create it, pinned ---------- */

const input = {
  BookedAt: iso,
  Title: TITLE,
  Notes: "Automated lane-pin verification. Temporary hold, deleted automatically.",
  Customer: {
    Guest: {
      Name: "ZZZ Lane Pin Test",
      PhoneNumber: "2395550100",
      Email: "lane-pin-test@headpinz.com",
    },
  },
  WebOffer: {
    Id: Number(offer.Id),
    Options: { Time: [{ Id: Number(option.Id) }] },
    Services: ["BookForLater" as const],
  },
  TotalPlayers: PLAYERS,
  Lanes: [
    {
      LaneNumber: PICK,
      Players: Array.from({ length: PLAYERS }, (_, i) => ({
        Name: `Test ${i + 1}`,
        ShoeSize: null,
        ActivateBumpers: false,
      })),
    },
  ],
};

let created: string | null = null;
let landedOn: number[] = [];
let askedFor = 0;
const rejected: Array<{ lane: number; why: string }> = [];

try {
  /**
   * Walk the ranked candidates. A `409 LanesNotCompatible` means the lane is outside the
   * offer's Conqueror lane group — which no endpoint exposes, so the only way to learn it
   * is to be told. That is a recoverable answer, not a failure: try the next candidate.
   * Production does the same and, once candidates run out, drops `Lanes` entirely and lets
   * QAMF auto-assign, so a lane preference can never cost a booking.
   */
  /**
   * The walk itself is `createWithLanePlan` from the feature — the SAME code the booking
   * routes will call. Re-implementing it here is precisely how the abort bug got in, so
   * this script deliberately owns no retry logic of its own.
   *
   * `--lane` / `--lanes` is a control: those exact lanes in that exact order, nothing else
   * appended, so a forced probe answers the question it was asked.
   */
  const candidates: number[][] = NO_PIN
    ? []
    : FORCED_LANES.length
      ? FORCED_LANES.map((l) => [l])
      : ranked.slice(0, Number(flag("tries") ?? 6)).map((c) => c.lanes);

  const outcome = await createWithLanePlan({
    candidates,
    maxAttempts: candidates.length || 1,
    onAttempt: (lanes) =>
      console.log(
        lanes
          ? `\nCreating pinned to lane ${lanes.join("+")} @ api-version 1.4…`
          : `\nCreating with NO Lanes${NO_PIN ? " (baseline — what QAMF chooses on its own)" : " — FAILING OPEN, letting QAMF choose"}…`,
      ),
    create: async (lanes) => {
      const attempt = lanes
        ? { ...input, Lanes: [{ ...input.Lanes[0], LaneNumber: lanes[0] }] }
        : { ...input, Lanes: undefined };
      const res = await createReservation(CENTER, attempt, "1.4");
      console.log(`  created ${res.Id} · status ${res.Status}`);
      return res;
    },
  });

  for (const a of outcome.attempts) {
    if (!a.ok && a.lanes) {
      rejected.push({ lane: a.lanes[0], why: a.failure?.why ?? "?" });
      console.log(`  rejected: ${a.failure?.why}`);
    }
  }

  created = outcome.reservation.Id;
  askedFor = outcome.pinnedTo?.[0] ?? 0;
  console.log(
    `  waiting ${VERIFY_DELAY_MS / 1000}s before verifying (an immediate read echoes the request)…`,
  );
  await sleep(VERIFY_DELAY_MS);
  const after = await getReservation(CENTER, created, "1.4");
  landedOn = (after.Lanes ?? []).map((l) => l.LaneNumber);
  console.log(
    `  VERIFIED: ${outcome.pinnedTo ? `asked for lane ${outcome.pinnedTo.join("+")}` : "sent no pin"}, ` +
      `landed on ${landedOn.join("+") || "(none)"} · status ${after.Status} · ` +
      `${(after.Lanes ?? []).map((l) => `${et(l.StartTime)}->${et(l.EndTime)}`).join(", ")}`,
  );
  console.log(`  walk: ${describePinOutcome(outcome)}`);

  console.log(`\n--- RESULT ---`);
  if (rejected.length) {
    console.log(`  lanes refused by the vendor: ${rejected.map((r) => r.lane).join(", ")}`);
    for (const r of rejected) {
      const seen = groups.get(Number(offer.Id))?.counts.get(r.lane) ?? 0;
      console.log(
        `    lane ${String(r.lane).padStart(2)} — ${r.why}${seen ? ` (history showed it ${seen}x)` : ""}`,
      );
    }
  }
  if (!created) {
    console.log(
      `  NO lane was accepted. In production this fails open: drop Lanes, let QAMF assign.`,
    );
    console.log(`  Nothing was left behind.`);
  } else if (NO_PIN) {
    console.log(`  reservation ${created} · sent NO Lanes · QAMF chose ${landedOn.join("+")}`);
    console.log(
      `  BASELINE — this is where a booking lands today, with nobody choosing. Compare it` +
        ` against a pinned run before claiming the pin decided anything.`,
    );
  } else {
    const honored = landedOn.length === 1 && landedOn[0] === askedFor;
    console.log(`  reservation ${created} · asked lane ${askedFor} · landed ${landedOn.join("+")}`);
    console.log(
      `  ${honored ? "PIN WORKS — QAMF put the booking on the lane WE chose." : `PIN IGNORED — QAMF auto-assigned ${landedOn.join("+")} instead.`}`,
    );
  }
} finally {
  if (created && !KEEP) {
    console.log(`\nCleaning up ${created}…`);
    try {
      await deleteReservation(CENTER, created);
      await sleep(3000);
      // A Temporary hold should vanish outright; a tombstone would mean it had been
      // confirmed, which this script never does.
      try {
        const gone = await getReservation(CENTER, created, "1.4");
        console.log(`  after delete: status ${gone.Status} (Canceled/absent is expected)`);
      } catch {
        console.log(`  after delete: gone.`);
      }
    } catch (e) {
      console.error(
        `  DELETE FAILED for ${created} — remove it by hand: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else if (created && KEEP) {
    console.log(
      `\nLeaving ${created} in place as requested (Temporary — QAMF expires it in ~10 min).`,
    );
  }
}
process.exit(0);
