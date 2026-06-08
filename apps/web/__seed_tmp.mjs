import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
const TTL = 60 * 60 * 24; // 24h — test data, auto-expires

// Karting overview lines (named WITHOUT "race"/"gel"/"laser" so the page's
// needsWaiver heuristic stays false and skips slow BMI waiver lookups).
const raceOverview = (billId, lines) => ({
  _billId: billId,
  lines,
  total: [{ depositKind: 0, amount: 0 }],
  subTotal: [{ depositKind: 0, amount: 0 }],
  totalTax: [{ depositKind: 0, amount: 0 }],
});

const recs = [
  {
    id: "TEST-MULTI",
    resNum: "W90010",
    rec: {
      billId: "TEST-MULTI",
      billIds: ["TEST-MULTI"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      racers: [
        {
          racerName: "TEST Alex",
          personId: null,
          product: "Starter Race Red",
          productId: "0",
          track: "Red",
          heatStart: "2026-06-10T14:00:00",
          heatName: "Red Starter 12",
        },
      ],
      attractions: [
        {
          slug: "gel-blaster",
          date: "2026-06-10",
          slot: "2026-06-10T15:30:00-04:00",
          qty: 4,
          price: 24.99,
        },
      ],
      bowling: [
        {
          kind: "bowling",
          date: "2026-06-10",
          bookedAt: "2026-06-10T17:00:00-04:00",
          experienceSlug: "fun-4-all",
          laneCount: 1,
          playerCount: 5,
          qamfReservationId: "QAMF-TEST-1",
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
    store: {
      name: "TEST BOOKING — Alex (do not honor)",
      email: "alex@headpinz.com",
      phone: "7249676207",
      smsOptIn: "true",
      amount: "0",
      location: "fasttrax",
      overviews: JSON.stringify([
        raceOverview("TEST-MULTI", [
          {
            name: "Red Track Starter",
            productId: "0",
            quantity: 1,
            productGroup: "Karting",
            scheduledTime: { start: "2026-06-10T14:00:00", stop: "2026-06-10T14:20:00" },
          },
        ]),
      ]),
    },
  },
  {
    id: "TEST-MULTI2",
    resNum: "W90013",
    rec: {
      billId: "TEST-MULTI2",
      billIds: ["TEST-MULTI2"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      attractions: [
        {
          slug: "laser-tag",
          date: "2026-06-10",
          slot: "2026-06-10T13:00:00-04:00",
          qty: 6,
          price: 19.99,
        },
      ],
      bowling: [
        {
          kind: "bowling",
          date: "2026-06-10",
          bookedAt: "2026-06-10T18:30:00-04:00",
          experienceSlug: "vip-mon-thur",
          laneCount: 2,
          playerCount: 8,
          qamfReservationId: "QAMF-TEST-2",
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
  },
  {
    id: "TEST-RACE",
    resNum: "W90011",
    rec: {
      billId: "TEST-RACE",
      billIds: ["TEST-RACE"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      racers: [
        {
          racerName: "TEST Alex",
          personId: null,
          product: "Starter Race Red",
          productId: "0",
          track: "Red",
          heatStart: "2026-06-10T14:00:00",
          heatName: "Red Starter 12",
        },
        {
          racerName: "TEST Sam",
          personId: null,
          product: "Pro Mega",
          productId: "0",
          track: "Mega",
          heatStart: "2026-06-10T14:30:00",
          heatName: "Mega Pro 8",
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
    store: {
      name: "TEST RACE — Alex (do not honor)",
      email: "",
      phone: "",
      smsOptIn: "false",
      amount: "0",
      location: "fasttrax",
      overviews: JSON.stringify([
        raceOverview("TEST-RACE", [
          {
            name: "Red Track Starter",
            productId: "0",
            quantity: 1,
            productGroup: "Karting",
            scheduledTime: { start: "2026-06-10T14:00:00", stop: "2026-06-10T14:20:00" },
          },
          {
            name: "Mega Track Pro",
            productId: "0",
            quantity: 1,
            productGroup: "Karting",
            scheduledTime: { start: "2026-06-10T14:30:00", stop: "2026-06-10T14:50:00" },
          },
        ]),
      ]),
    },
  },
  {
    id: "TEST-ATTR",
    resNum: "W90012",
    rec: {
      billId: "TEST-ATTR",
      billIds: ["TEST-ATTR"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      attractions: [
        {
          slug: "laser-tag",
          date: "2026-06-10",
          slot: "2026-06-10T16:00:00-04:00",
          qty: 6,
          price: 19.99,
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
  },
  {
    id: "TEST-BOWL",
    resNum: "W90015",
    rec: {
      billId: "TEST-BOWL",
      billIds: ["TEST-BOWL"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      bowling: [
        {
          kind: "bowling",
          date: "2026-06-10",
          bookedAt: "2026-06-10T19:00:00-04:00",
          experienceSlug: "fun-4-all",
          laneCount: 2,
          playerCount: 6,
          qamfReservationId: "QAMF-TEST-3",
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
  },
  {
    // Express-lane racing: returning racers (numeric personIds) + fastLane=true
    // so the page renders the green Express Lane experience.
    id: "TEST-EXPRESS",
    resNum: "W90016",
    rec: {
      billId: "TEST-EXPRESS",
      billIds: ["TEST-EXPRESS"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      racers: [
        {
          racerName: "TEST Alex",
          personId: "100001",
          sessionId: "555001",
          product: "Starter Race Red",
          productId: "0",
          track: "Red",
          heatStart: "2026-06-10T14:00:00",
          heatName: "Red Starter 12",
        },
        {
          racerName: "TEST Sam",
          personId: "100002",
          sessionId: "555002",
          product: "Pro Mega",
          productId: "0",
          track: "Mega",
          heatStart: "2026-06-10T14:30:00",
          heatName: "Mega Pro 8",
        },
      ],
      fastLane: true,
      status: "confirmed",
      totalAmount: 0,
    },
  },
  {
    // Multi-activity WITH express-lane racing: returning racers (personId +
    // sessionId) + fastLane, plus a gel-blaster and a bowling leg. Hub shows
    // 3 cards; the Racing card drills into the green express experience + QRs.
    id: "TEST-MULTI-EXP",
    resNum: "W90017",
    rec: {
      billId: "TEST-MULTI-EXP",
      billIds: ["TEST-MULTI-EXP"],
      date: "2026-06-10",
      contact: { firstName: "TEST", lastName: "Booking", email: "", phone: "" },
      racers: [
        {
          racerName: "TEST Alex",
          personId: "100001",
          sessionId: "555001",
          product: "Starter Race Red",
          productId: "0",
          track: "Red",
          heatStart: "2026-06-10T14:00:00",
          heatName: "Red Starter 12",
        },
        {
          racerName: "TEST Sam",
          personId: "100002",
          sessionId: "555002",
          product: "Pro Mega",
          productId: "0",
          track: "Mega",
          heatStart: "2026-06-10T14:30:00",
          heatName: "Mega Pro 8",
        },
      ],
      fastLane: true,
      attractions: [
        {
          slug: "gel-blaster",
          date: "2026-06-10",
          slot: "2026-06-10T15:30:00-04:00",
          qty: 4,
          price: 24.99,
        },
      ],
      bowling: [
        {
          kind: "bowling",
          date: "2026-06-10",
          bookedAt: "2026-06-10T17:00:00-04:00",
          experienceSlug: "fun-4-all",
          laneCount: 1,
          playerCount: 5,
          qamfReservationId: "QAMF-TEST-1",
        },
      ],
      status: "confirmed",
      totalAmount: 0,
    },
  },
];

for (const { id, resNum, rec, store } of recs) {
  await redis.set(`bookingrecord:${id}`, JSON.stringify(rec), "EX", TTL);
  await redis.set(
    `bmi:confirmed:${id}`,
    JSON.stringify({ reservationNumber: resNum, reservationCode: `r${id}`, orderId: id }),
    "EX",
    TTL,
  );
  if (store) await redis.set(`booking:${id}`, JSON.stringify(store), "EX", TTL);
  console.log("seeded", id, "->", resNum, store ? "(+store)" : "");
}

// Redis keys are case-sensitive — alias the bowling test id under common
// typos so a mistyped URL (TEST-BOWl / test-bowl) still resolves.
const bowl = recs.find((x) => x.id === "TEST-BOWL");
if (bowl) {
  for (const alias of ["TEST-BOWl", "test-bowl", "Test-Bowl"]) {
    await redis.set(
      `bookingrecord:${alias}`,
      JSON.stringify({ ...bowl.rec, billId: alias, billIds: [alias] }),
      "EX",
      TTL,
    );
    await redis.set(
      `bmi:confirmed:${alias}`,
      JSON.stringify({
        reservationNumber: bowl.resNum,
        reservationCode: `r${alias}`,
        orderId: alias,
      }),
      "EX",
      TTL,
    );
    console.log("aliased", alias);
  }
}

await redis.quit();
console.log("SEED_DONE");
