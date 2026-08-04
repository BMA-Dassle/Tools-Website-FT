// FastTrax Racing Licence — PassKit MEMBER pass (Apple / Google Wallet).
//
// Expansion step 2 of the wallet programme (tasks/future/passkit-wallet-passes.md § 3B).
// The voucher pilot used the single-use COUPON family; a licence is multi-use, so
// this is the first code in the repo to touch `/members/...`.
//
// DRY-RUN BY DEFAULT. Nothing is created without APPLY=1.
//
//   npx tsx scripts/passkit-licence-pass.mts                  # discover: auth, programs, templates
//   APPLY=1 npx tsx scripts/passkit-licence-pass.mts          # create program + template + member
//   APPLY=1 PERSON_ID=409523 CODE=mgrm2g8o42wxc …
//
// BILLING — READ BEFORE RAISING THE COUNT. Multi-use records bill RECURRING
// MONTHLY (~$0.045 each) versus single-use billing once at issuance. The
// platform fee includes 250 multi-use free, so a handful of pilot passes cost
// nothing — but the new-in-month vs cumulative-alive question is still
// unanswered in writing (§ 5), which is why this is a pilot and not a rollout.
//
// Gotchas honored (verified live 2026-08-03, src/lib/api/passkit.ts):
//   - Region is pub2. Every PassKit doc example says pub1, which authenticates
//     and then 404s on every object.
//   - `Authorization: <jwt>` with NO `Bearer` prefix.
//   - `iat` MUST be backdated ~30 s (their clock runs behind ours).
//   - A field of the wrong SHAPE surfaces as `proto: syntax error`, not a field
//     error — if you see a syntax error, suspect shape (a repeated bitmask sent
//     as a scalar is the classic).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.env.APPLY === "1";

// ── Who the pass is for. Defaults are Eric's REAL record, read live from BMI
// Office by scripts/racer-tag-semantics-probe.mts on 2026-08-04.
const PERSON_ID = process.env.PERSON_ID || "409523";
const CODE = process.env.CODE || "mgrm2g8o42wxc";
const MEMBER_NAME = process.env.MEMBER_NAME || "Eric Osborn";
const EMAIL = process.env.EMAIL || "";
/** Highest "Qualified …" membership on the Office record. */
const TIER = process.env.TIER || "Pro";
/** MAX(stops) over ACTIVE "License Fee" memberships — 34 of Eric's 35 are expired. */
const VALID_UNTIL = process.env.VALID_UNTIL || "Oct 31st, 2026";
/** `tags.length`, which is what the app already shows as a race count. */
const RACES = process.env.RACES || "31";
/** No heat booked today. The live pass rewrites this field for free. */
const NEXT_RACE = process.env.NEXT_RACE || "None booked";

/** The FastTrax track — the banked curve, with our own signage on the barrier.
 *
 *  DO NOT PICK THESE BY THEIR `alt` TEXT. The attractions page labels
 *  DSC00281 "FastTrax racing action" and it is a photograph of BOWLING LANES;
 *  it shipped on this pass until the owner caught it (2026-08-04). The only
 *  two genuine racing frames in that set are DSC00273 (karts on track) and
 *  this one. Look at the image before you change this line. */
const STRIP_PHOTO =
  process.env.STRIP_PHOTO ||
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/DSC06577.webp";

/** MEMBERSHIP-protocol template to dress as the licence. */
const TEMPLATE_ID = process.env.TEMPLATE_ID || "75paqKfII1FIn9kImwIvi2";
/** Set to reuse an existing program instead of creating one. */
const PROGRAM_ID = process.env.PROGRAM_ID || "4m1Y7wCXyloclQk0hqvjRS";
/** Tier to enrol into. Empty = use the program's first tier. */
const TIER_ID = process.env.TIER_ID || "";

const BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";
const KEY = process.env.PASSKIT_API_KEY || "";
const SECRET = process.env.PASSKIT_API_SECRET || "";
if (!KEY || !SECRET) {
  console.error("Missing PASSKIT_API_KEY / PASSKIT_API_SECRET — run from apps/web.");
  process.exit(1);
}

function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  // −30 s: measured good window is −5 s … −60 s.
  const payload = b64({ uid: KEY, iat: now - 30, exp: now + 50 });
  const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function pk(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: jwt(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* NDJSON list endpoints — keep raw */
  }
  return { status: res.status, ok: res.ok, body: parsed, raw: text };
}

/** One template data field. Shape copied verbatim from the working voucher
 *  template — PassKit rejects partial field objects with a proto syntax error
 *  that points at the value, not the missing key. */
const field = (o: {
  uniqueName: string;
  label: string;
  value: string;
  section: string;
  priority: number;
  align?: string;
  changeMessage?: string;
}) => ({
  uniqueName: o.uniqueName,
  templateId: "",
  fieldType: "CUSTOM_FIELDS",
  isRequired: false,
  label: o.label,
  dataType: "TEXT",
  defaultValue: o.value,
  validation: "",
  userCanSetValue: false,
  currencyCode: "",
  appleWalletFieldRenderOptions: {
    textAlignment: o.align ?? "LEFT",
    positionSettings: { section: o.section, priority: o.priority },
    ...(o.changeMessage ? { changeMessage: o.changeMessage } : {}),
    dateStyle: "DATE_TIME_STYLE_DO_NOT_USE",
    timeStyle: "DATE_TIME_STYLE_DO_NOT_USE",
    numberStyle: "NUMBER_STYLE_DO_NOT_USE",
    suppressLinkDetection: [],
    ignoreTimezone: false,
    isRelativeDate: false,
  },
  usage: ["USAGE_APPLE_WALLET", "USAGE_GOOGLE_PAY"],
  googlePayFieldRenderOptions: {
    googlePayPosition: "GOOGLE_PAY_TEXT_MODULE",
    textModulePriority: o.priority,
  },
});

/** FastTrax's Square location id — the Pandora person route is keyed on it. */
const PANDORA_LOCATION = process.env.PANDORA_LOCATION || "LAB52GY480CJF";
let PIC_B64 = "";

/**
 * The racer's own record: photo, waiver expiry, last visit.
 * `GET /v2/bmi/person/{locationId}/{personId}?picture=true` — note the payload
 * is wrapped in `{success, data}`, and `pic` is null on plenty of records.
 */
async function fetchPandoraPerson(): Promise<Record<string, any> | null> {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  if (!key) return null;
  try {
    const r = await fetch(
      `https://bma-pandora-api.azurewebsites.net/v2/bmi/person/${PANDORA_LOCATION}/${PERSON_ID}?picture=true`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    return j?.data ?? null;
  } catch {
    return null;
  }
}

/** "Oct 31st, 2026" (owner 2026-08-04). US order with an ordinal day — the
 *  guests reading this pass are in Florida, not London. */
const ordinal = (d: number) =>
  d % 10 === 1 && d % 100 !== 11
    ? `${d}st`
    : d % 10 === 2 && d % 100 !== 12
      ? `${d}nd`
      : d % 10 === 3 && d % 100 !== 13
        ? `${d}rd`
        : `${d}th`;

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  const mon = dt.toLocaleDateString("en-US", { month: "short" });
  return `${mon} ${ordinal(dt.getDate())}, ${dt.getFullYear()}`;
};

async function main() {
  console.log(`base=${BASE}  apply=${APPLY}\n`);

  // ── Discovery (read-only, always runs) ────────────────────────────────────
  const probes: Array<[string, string, unknown?]> = [
    ["GET", "/members/programs"],
    ["POST", "/templates/list", {}],
    // A production program needs an Apple pass type identifier. The voucher
    // campaign already has one, so find where it is rather than minting a new
    // certificate.
    ...(process.env.FIND_CERT === "1"
      ? ([
          ["GET", "/certificates"],
          ["GET", "/certificates/list"],
          ["POST", "/certificates/list", {}],
          ["GET", "/passTypeIds"],
          ["GET", `/coupon/singleUse/campaign/${"5ZmFoKJyWxD4kAFLr1uHoa"}`],
        ] as Array<[string, string, unknown?]>)
      : []),
  ];
  for (const [m, p, b] of probes) {
    const r = await pk(m, p, b);
    const preview =
      typeof r.body === "string" ? r.body.slice(0, 1600) : JSON.stringify(r.body).slice(0, 1600);
    console.log(`${m} ${p}\n  → ${r.status}  ${preview || "(empty)"}\n`);
  }
  // What does an EXISTING template look like? The voucher one is the only
  // design we have ever built, so its shape is the model for the licence.
  const list = await pk("POST", "/templates/list", {});
  const tpls = String(list.raw ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)?.result?.template;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  console.log(`templates found: ${tpls.length}`);
  for (const t of tpls) {
    console.log(
      `  id=${t.id}  protocol=${t.protocol ?? "?"}  name="${t.name ?? ""}"  desc="${t.description ?? ""}"`,
    );
  }
  if (tpls[0]) {
    writeFileSync(
      resolve(process.cwd(), ".passkit-template-sample.json"),
      JSON.stringify(tpls[0], null, 2),
    );
    console.log("\n  (full shape of the first template written to .passkit-template-sample.json)");
  }

  // ── The licence design ────────────────────────────────────────────────────
  //
  // NO STRIP IMAGE, ON PURPOSE — the opposite of the voucher pass. Apple lays
  // PRIMARY_FIELDS over a strip, which is why the voucher has no primary field
  // at all. A licence's whole job on the face is the CODE, big enough to read
  // and type at the Race Check-In desk, so the card runs on flat background and
  // spends its primary field on exactly that.
  //
  // This also deliberately breaks the voucher's "don't repeat the code, the
  // barcode altText prints it" rule. Different requirement: a voucher is
  // scanned, a licence is TYPED.
  const BG_HEX = "#000418"; // FastTrax navy-black (real brand value)
  const LABEL_HEX = "#e53935"; // FastTrax red
  // Live BMI record — photo, waiver, last visit. Falls back to the constants
  // above when Pandora is unreachable so the design work never blocks on it.
  const person = await fetchPandoraPerson();
  if (person) {
    PIC_B64 = typeof person.pic === "string" ? person.pic.replace(/^data:[^,]+,/, "") : "";
    console.log(
      `pandora: ${person.firstName} ${person.lastName}  pic=${PIC_B64 ? `${PIC_B64.length}B` : "NULL (no photo on file)"}  waiver=${person.waiverExpiry ?? "—"}  lastVisit=${person.lastVisit ?? "—"}`,
    );
  } else {
    console.log("pandora: unreachable — using constants");
  }
  const fullName =
    person?.firstName || person?.lastName
      ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim()
      : MEMBER_NAME;
  const waiverIso = person?.waiverExpiry ?? null;
  const waiverOk = waiverIso ? new Date(waiverIso).getTime() > Date.now() : false;

  const meta = {
    code: CODE,
    tier: TIER,
    validUntil: VALID_UNTIL,
    races: String(RACES),
    nextRace: NEXT_RACE,
    licenceUrl: `https://headpinz.com/r/${CODE}`,
    // UPPERCASED (owner 2026-08-04: "make racers name more bold").
    //
    // Apple exposes NO font-weight control — pass.json has no such property and
    // PassKit's appleWalletFieldRenderOptions only carries alignment and
    // date/number styling. Weight is fixed by field type, and a primary field
    // is already the heaviest text on the card, so there is nothing to turn up.
    // Case is the only lever left, and full caps genuinely reads heavier at the
    // same point size. Applied to the DISPLAY value only — every other surface
    // keeps the name as BMI has it.
    memberName: fullName.toUpperCase(),
    waiver: waiverIso ? (waiverOk ? `Signed · ${fmtDate(waiverIso)}` : "Needs signing") : "—",
    lastVisit: fmtDate(person?.lastVisit) || "—",
  };

  const DATA_FIELDS = [
    // The RACER'S NAME is the primary field (owner 2026-08-04). A licence is an
    // identity document — the person's name is what makes it read as one, and
    // it is what staff at the Race Check-In desk are looking for. The code is
    // still on the face below, and the barcode's altText prints it a third
    // time, so nothing is lost by not shouting it.
    field({
      uniqueName: "custom.racer",
      label: "RACER",
      value: "${meta.memberName}",
      section: "PRIMARY_FIELDS",
      priority: 0,
    }),
    // NO CODE FIELD (owner 2026-08-04) — the barcode's altText already prints
    // the licence code directly under the QR, so a face field would be the same
    // string twice. Identical call to the one made on the voucher pass.
    field({
      uniqueName: "custom.nextRace",
      label: "NEXT RACE",
      value: "${meta.nextRace}",
      section: "SECONDARY_FIELDS",
      priority: 0,
      // Apple shows this on the lock screen when the value changes — the whole
      // reason the licence pass can replace per-heat eTickets for free.
      changeMessage: "Your next race: %@",
    }),
    field({
      uniqueName: "custom.tier",
      label: "TIER",
      value: "${meta.tier}",
      section: "AUXILIARY_FIELDS",
      priority: 1,
      align: "RIGHT",
      changeMessage: "You levelled up to %@",
    }),
    field({
      uniqueName: "custom.validUntil",
      label: "LICENCE VALID",
      value: "${meta.validUntil}",
      section: "AUXILIARY_FIELDS",
      priority: 0,
    }),
    // No WAIVER field (owner 2026-08-04). Waiver state is a staff concern at
    // check-in, not something a racer needs on the face of their licence — and
    // it is read live at check-in anyway, so a stale copy on a pass could only
    // ever disagree with the truth.
    field({
      uniqueName: "custom.races",
      label: "Races",
      value: "${meta.races}",
      section: "BACK_FIELDS",
      priority: 3,
    }),
    field({
      uniqueName: "custom.howto",
      label: "How to use this",
      value:
        "Scan it at any FastTrax kiosk to sign in or check into your booking. " +
        "At the Race Check-In desk, scan it or read your licence code out loud — " +
        "it is the same code you type on the BMI screens.",
      section: "BACK_FIELDS",
      priority: 0,
    }),
    field({
      uniqueName: "custom.lastVisit",
      label: "Last visit",
      value: "${meta.lastVisit}",
      section: "BACK_FIELDS",
      priority: 1,
    }),
    field({
      uniqueName: "custom.terms",
      label: "Good to know",
      value:
        "Your licence code never changes and never expires — old codes keep working. " +
        "The racing licence itself renews yearly. This pass updates itself: your next " +
        "race and your tier appear here automatically.",
      section: "BACK_FIELDS",
      priority: 2,
    }),
  ];

  console.log("── licence design ──");
  console.log(`  colors  : ${BG_HEX} / labels ${LABEL_HEX}`);
  console.log(`  fields  : ${DATA_FIELDS.map((f) => f.uniqueName).join(", ")}`);
  console.log(`  barcode : QR → \${meta.licenceUrl}  altText \${meta.code}`);
  console.log(`  meta    : ${JSON.stringify(meta)}\n`);

  if (!APPLY) {
    console.log("DRY RUN — nothing created. Re-run with APPLY=1.");
    return;
  }

  // ── 1. Images. Min 660x660 on EVERY slot or the pass URL 500s with no
  // useful message. Flatten onto BG — PassKit composites transparency onto
  // BLACK, which reads as a dark box on a coloured card.
  const sharp = (await import("sharp")).default;
  const BG = { r: 0x00, g: 0x04, b: 0x18, alpha: 1 };
  const src = readFileSync(resolve(process.cwd(), "public/brand/ft-logo.png"));

  // HOLD THE LOGO'S TRUE ASPECT. ft-logo.png is 2379x758 (3.14:1). Forcing it
  // into a 660x660 `contain` box renders the mark at 660x210 inside a square,
  // i.e. 68% of the slot is empty navy — which Apple then scales down to a
  // stamp. Resize to the aspect AT the 660 floor instead.
  const logo = await sharp(src)
    .trim()
    .resize(2072, 660, { fit: "contain", background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();
  // The icon slot IS square (lock screen / notifications), so here the padding
  // is correct rather than accidental.
  const icon = await sharp(src)
    .trim()
    .resize(620, 200, { fit: "contain", background: BG })
    .extend({ top: 230, bottom: 230, left: 20, right: 20, background: BG })
    .flatten({ background: BG })
    .png()
    .toBuffer();

  // RACING PHOTO — the `strip` slot: a full-width banner under the header.
  // This is the only place a scene photo fits on an Apple pass, and it is
  // mutually exclusive with `thumbnail` (Apple: storeCard/coupon take a strip,
  // generic takes a thumbnail, never both), which is exactly why dropping the
  // racer portrait freed it up.
  //
  // The scrim is load-bearing. Apple lays PRIMARY_FIELDS *over* the strip, and
  // the voucher pass learned that the hard way — the offer printed across four
  // kids' faces. Here the gradient stays light at the top so the track reads,
  // then drives to near-solid navy by the bottom third where the racer's name
  // actually sits.
  const STRIP_W = 1600;
  const STRIP_H = 620;
  const scrim = Buffer.from(
    `<svg width="${STRIP_W}" height="${STRIP_H}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
         <stop offset="0%"   stop-color="${BG_HEX}" stop-opacity="0.42"/>
         <stop offset="30%"  stop-color="${BG_HEX}" stop-opacity="0.22"/>
         <stop offset="68%"  stop-color="${BG_HEX}" stop-opacity="0.72"/>
         <stop offset="100%" stop-color="${BG_HEX}" stop-opacity="0.97"/>
       </linearGradient></defs>
       <rect width="${STRIP_W}" height="${STRIP_H}" fill="url(#g)"/>
     </svg>`,
  );
  // THE FASTTRAX MARK GOES IN THE ARTWORK, not the header slot.
  //
  // PassKit forces the `logo` slot to a square canvas (upload 2072x660, get
  // 660x660 back), so a 3.14:1 wordmark letterboxes into a third of the height
  // and Apple then renders it small — that is why the brand read as missing.
  // The strip is OUR image at OUR aspect, so compositing the wordmark onto it
  // is the one place we control how big the logo actually appears.
  //
  // Composited AFTER the scrim so the mark stays at full strength while the
  // photo under it is knocked back.
  const markW = Math.round(STRIP_W * 0.3);
  const mark = await sharp(src)
    .trim()
    .resize(markW, null, { fit: "contain" })
    .png()
    .toBuffer();
  const markH = (await sharp(mark).metadata()).height ?? 0;
  const photoBuf = Buffer.from(await (await fetch(STRIP_PHOTO)).arrayBuffer());
  const strip = await sharp(photoBuf)
    .resize(STRIP_W, STRIP_H, { fit: "cover", position: "centre" })
    .composite([
      { input: scrim, blend: "over" },
      // BOTTOM-RIGHT, and this is not a taste decision. Apple lays the primary
      // field (the racer's name) over the strip, LEFT-aligned and upper-middle
      // — a centred mark there gets the name printed straight through it, which
      // is exactly what happened on the first attempt (owner, 2026-08-04). The
      // bottom-right corner is the one region a left-aligned primary field
      // cannot reach.
      {
        input: mark,
        top: STRIP_H - markH - Math.round(STRIP_H * 0.1),
        left: STRIP_W - markW - Math.round(STRIP_W * 0.05),
      },
    ])
    .flatten({ background: BG })
    .png()
    .toBuffer();
  console.log(`  strip mark: ${markW}x${markH} on ${STRIP_W}x${STRIP_H}`);

  const imageData: Record<string, string> = {
    icon: icon.toString("base64"),
    logo: logo.toString("base64"),
    strip: strip.toString("base64"),
  };
  // The racer's own photo, when BMI has one. This is what turns the pass from a
  // card into an ID — but `pic` is null on plenty of records (Eric's included),
  // so the design must read correctly WITHOUT it.
  if (PIC_B64) {
    imageData.thumbnail = (
      await sharp(Buffer.from(PIC_B64, "base64"))
        .resize(660, 660, { fit: "cover", position: "top" }) // "attention" decapitates people
        .flatten({ background: BG })
        .png()
        .toBuffer()
    ).toString("base64");
  }
  const imgIds = await pk("POST", "/images", { imageData });
  console.log(
    `images → ${imgIds.status} (logo 2072x660, icon 660x660${PIC_B64 ? ", thumbnail 660x660" : ", NO photo on the BMI record"})`,
  );

  // ── 2. Style the MEMBERSHIP template. PUT REPLACES THE WHOLE TEMPLATE, so
  // read the current one first — anything dropped here is silently deleted.
  const tpl = tpls.find((t: any) => t.id === TEMPLATE_ID);
  if (!tpl) throw new Error(`template ${TEMPLATE_ID} not found in the account`);
  const put = await pk("PUT", "/template", {
    ...tpl,
    name: "FastTrax Racing Licence",
    description: "FastTrax Racing Licence",
    // Defaults to "PassKit, Inc", which is what Apple Wallet shows as the pass
    // issuer on the back of the card. Ours, not theirs.
    organizationName: "FastTrax",
    colors: { backgroundColor: BG_HEX, labelColor: LABEL_HEX, textColor: "#ffffff" },
    imageIds: {
      ...(tpl.imageIds ?? {}),
      ...((imgIds.body as any)?.icon ? { icon: (imgIds.body as any).icon } : {}),
      ...((imgIds.body as any)?.logo ? { logo: (imgIds.body as any).logo } : {}),
      // `POST /images` DERIVES a separate `appleLogo` from whatever you upload,
      // and Apple Wallet renders THAT — not `logo`. Left alone it comes back
      // 1:1, which squashes a 3.14:1 wordmark into an unreadable square stamp.
      // Point it at the wide image explicitly.
      ...((imgIds.body as any)?.logo ? { appleLogo: (imgIds.body as any).logo } : {}),
      // The stock template we dressed ("Your special card") shipped a thumbnail,
      // and a GENERIC Apple pass renders a thumbnail on the RIGHT of the card.
      // With no racer photo that is someone else's stock art on our licence, so
      // clear it unless we actually uploaded one.
      thumbnail: (imgIds.body as any)?.thumbnail ?? "",
      ...((imgIds.body as any)?.strip ? { strip: (imgIds.body as any).strip } : {}),
    },
    barcode: {
      ...tpl.barcode,
      payload: "${meta.licenceUrl}",
      altText: "${meta.code}",
      format: "QR",
    },
    // A GENERIC Apple pass has NO strip slot — it would silently ignore the
    // racing photo. storeCard is the style that renders one.
    appleWalletSettings: { ...(tpl.appleWalletSettings ?? {}), passType: "STORE_CARD" },
    data: { ...tpl.data, dataFields: DATA_FIELDS },
  });
  console.log("template →", put.status, JSON.stringify(put.body).slice(0, 300));

  // ── 3. Program (idempotent-ish: reuse if one already exists).
  let programId = PROGRAM_ID;
  if (!programId) {
    const prog = await pk("POST", "/members/program", {
      name: "FastTrax Racing Licence",
      // Our own Apple certificate (GET /certificates → pass.com.fasttrax.booking,
      // team 74Z5L3L3BT, valid to 2027-05-03). A production program is refused
      // without it; the voucher campaign uses the same one.
      passTypeIdentifier: "pass.com.fasttrax.booking",
      ianaTimezone: "America/New_York",
      // REPEATED bitmask, values are PROJECT_*, and it needs ONE FROM EACH OF
      // TWO AXES: publish state, and whether objects may be created against it.
      // It validates them one axis at a time, so you get two consecutive 500s
      // that each name only the axis you are currently missing.
      status: ["PROJECT_PUBLISHED", "PROJECT_ACTIVE_FOR_OBJECT_CREATION"],
      defaultTierId: "licence",
      tiers: [{ id: "licence", name: "Racing Licence", tierIndex: 0, passTemplateId: TEMPLATE_ID }],
    });
    console.log("program →", prog.status, JSON.stringify(prog.body).slice(0, 400));
    programId = (prog.body as any)?.id ?? "";
  }
  if (!programId) throw new Error("no programId — see the response above");

  // ── 4. The member. externalId = BMI personId: stable, unlike the tag.
  //
  // The tier id is NOT ours to choose: the ids passed to POST /members/program
  // are not honoured, so read the program back and use what it actually made.
  const progGet = await pk("GET", `/members/program/${programId}`);
  console.log("program read →", progGet.status, JSON.stringify(progGet.body).slice(0, 500));
  const tiers = (progGet.body as any)?.tiers ?? [];
  let tierId = TIER_ID || tiers[0]?.id || "";
  console.log(`tiers: ${tiers.map((t: any) => `${t.id}("${t.name}")`).join(", ") || "(none)"}`);
  if (!tierId) {
    // Tiers are their OWN resource — the `tiers` array passed to
    // POST /members/program is silently ignored, and the program comes back
    // with none. It has to be created against the program id afterwards, and
    // this is where the pass template gets bound to the programme.
    const tier = await pk("POST", "/members/tier", {
      programId,
      id: "licence",
      name: "Racing Licence",
      // MUST be >= 1. Their validator is Go `required`, which treats 0 as
      // unset, so `tierIndex: 0` fails as "required" rather than as a range
      // error and sends you looking for a missing field.
      tierIndex: 1,
      passTemplateId: TEMPLATE_ID,
      // The tier carries its OWN timezone, separate from the program's
      // ianaTimezone. Their validator reports one missing field per attempt,
      // so expect to discover this list one 400 at a time.
      timezone: "America/New_York",
      availability: { startAt: null, endAt: null },
    });
    console.log("tier →", tier.status, JSON.stringify(tier.body).slice(0, 300));
    tierId = (tier.body as any)?.id || "licence";
  }
  if (!tierId) throw new Error("program has no tier — cannot create a member");

  const member = await pk("POST", "/members/member", {
    programId,
    tierId,
    externalId: PERSON_ID,
    person: { displayName: MEMBER_NAME, emailAddress: EMAIL || undefined },
    metaData: meta,
  });
  console.log("member →", member.status, JSON.stringify(member.body).slice(0, 400));

  // CREATE-OR-RECOVER. A duplicate externalId is a 409 for members exactly as
  // it is for coupons (verified live 2026-08-04) — which is what makes issuing
  // idempotent and, for a MONTHLY-BILLED record, what stops a re-tap becoming a
  // second charge. Recover the existing member and push current state onto it.
  let memberId = (member.body as any)?.id ?? "";
  if (!memberId) {
    const found = await pk("GET", `/members/member/externalId/${programId}/${PERSON_ID}`);
    memberId = (found.body as any)?.id ?? "";
    console.log("recovered →", found.status, memberId || JSON.stringify(found.body).slice(0, 200));
    if (memberId) {
      const upd = await pk("PUT", "/members/member", { id: memberId, metaData: meta });
      console.log("updated →", upd.status, JSON.stringify(upd.body).slice(0, 200));
    }
  }
  const host = BASE.includes("pub1") ? "https://pub1.pskt.io" : "https://pub2.pskt.io";
  const out = {
    programId,
    templateId: TEMPLATE_ID,
    memberId,
    meta,
    urls: memberId
      ? {
          landing: `${host}/${memberId}`,
          apple: `${host}/${memberId}.pkpass`,
          google: `${host}/${memberId}.gpay`,
        }
      : null,
  };
  writeFileSync(
    resolve(process.cwd(), ".passkit-licence-last-run.json"),
    JSON.stringify(out, null, 2),
  );
  console.log("\n" + JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
