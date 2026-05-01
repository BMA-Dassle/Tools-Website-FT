import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { ensureKbfSchema } from "@/lib/kbf-sync";
import { loadPassesWithMembers } from "@/lib/kbf-prefs";

/**
 * POST /api/kbf/register
 *
 * In-app KBF registration — creates the parent + kids in our Neon
 * shadow tables (`kbf_passes` + `kbf_pass_members`) so the family can
 * book immediately without waiting for the daily CSV sync from
 * kidsbowlfree.com.
 *
 * v1 scope: Neon-only insert. No call out to kidsbowlfree.com — the
 * parent still needs to register with KBF separately to receive
 * weekly coupons in their inbox. Surfaced in the wizard's New-tab
 * helper text.
 *
 * Body:
 *   {
 *     centerId: "9172" | "3148",
 *     parent: { firstName, lastName, email, phone },
 *     kids: [{ firstName, lastName, birthday }, ...]   // 1-6 kids
 *   }
 *
 * Returns: { ok: true, passes: KbfPassWithMembers[] }
 *
 * Errors:
 *   400 — bad input (missing fields, no kids, etc.)
 *   409 — email already exists at that center (use Email tab to log in)
 *   500 — DB error
 */

interface RegisterBody {
  centerId: string;
  parent: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    /** Optional — when provided we also create the account on
     *  kidsbowlfree.com so the family receives weekly coupon emails. */
    password?: string;
  };
  kids: { firstName: string; lastName: string; birthday: string }[];
}

const CENTER_NAME: Record<string, string> = {
  "9172": "HeadPinz Fort Myers",
  "3148": "HeadPinz Naples",
};

/**
 * KBF "alley_id" — the center identifier kidsbowlfree.com uses on
 * its center.php signup form. NOT the same as our QAMF centerId.
 * Pulled from the registration HAR at /center.php?alley_id=6363
 * (FM). Naples TBD — leaving it out means the kbf.com side-effect
 * silently skips for Naples until the alley_id lands.
 */
const KBF_ALLEY_ID: Record<string, string> = {
  "9172": "6363", // HeadPinz Fort Myers
  // "3148": "<naples alley_id>",  // TODO: capture from KBF
};

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

function birthYearFrom(birthday: string): number | null {
  const m = /(\d{4})$/.exec(birthday.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return Number.isFinite(y) ? y : null;
}

/** Parse "YYYY-MM-DD" or "MM/DD/YYYY" into {month, day, year}. */
function parseBirthday(raw: string): { month: string; day: string; year: string } {
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (ymd) return { year: ymd[1], month: String(parseInt(ymd[2], 10)), day: String(parseInt(ymd[3], 10)) };
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (mdy) return { month: String(parseInt(mdy[1], 10)), day: String(parseInt(mdy[2], 10)), year: mdy[3] };
  return { month: "", day: "", year: "" };
}

/**
 * Fire-and-forget POST to kidsbowlfree.com so the family also lands
 * in KBF's official roster + receives the weekly coupon emails. Two
 * sequential POSTs to /center.php — the first creates the parent
 * (302 → ?ptoken=…), the second posts the kids using that ptoken.
 * Pattern reverse-engineered from the HAR.
 *
 * Failures are logged + swallowed so a kbf.com hiccup doesn't
 * break our local Neon insert (the family can still book today).
 */
async function registerOnKidsBowlFree(input: {
  alleyId: string;
  parent: { firstName: string; lastName: string; email: string; phone: string; address?: string; city?: string; state?: string; zip?: string };
  kids: { firstName: string; lastName: string; birthday: string }[];
  password: string;
}): Promise<void> {
  const KBF_BASE = "https://www.kidsbowlfree.com";
  const ua = "FastTrax-KBF-Sync/1.0 (+https://headpinz.com)";

  // Step 1: parent registration (form=p1)
  const p1Body = new URLSearchParams({
    signup: "1",
    alley_id: input.alleyId,
    secret: "",
    src: "",
    token: "",
    ptoken: "",
    which_form: "p1",
    first_name: input.parent.firstName,
    last_name: input.parent.lastName,
    address: input.parent.address ?? "",
    city: input.parent.city ?? "",
    state: input.parent.state ?? "",
    zip: input.parent.zip ?? "",
    email: input.parent.email,
    email2: input.parent.email,
    password: input.password,
    password2: input.password,
    mobile_number: input.parent.phone,
    receive_texts: "1",
    certify: "1",
  });

  const p1 = await fetch(`${KBF_BASE}/center.php`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: KBF_BASE,
      Referer: `${KBF_BASE}/center.php?alley_id=${input.alleyId}`,
    },
    body: p1Body.toString(),
    redirect: "manual",
    cache: "no-store",
  });

  if (p1.status !== 302) {
    throw new Error(`KBF parent signup got HTTP ${p1.status} (expected 302)`);
  }
  const loc = p1.headers.get("location") || "";
  const ptokMatch = /ptoken=([0-9a-f]+)/i.exec(loc);
  if (!ptokMatch) {
    throw new Error("KBF parent signup missing ptoken in redirect");
  }
  const ptoken = ptokMatch[1];

  // Step 2: kid registration (form=p2). KBF caps at 3 children per
  // signup (slots 0–2 in the HAR); pad empty slots with blank fields.
  const KID_SLOTS = 3;
  const p2Body = new URLSearchParams({
    signup: "1",
    alley_id: input.alleyId,
    secret: "",
    src: "",
    token: "",
    ptoken,
    which_form: "p2",
  });
  for (let i = 0; i < KID_SLOTS; i++) {
    const k = input.kids[i];
    if (k) {
      const bd = parseBirthday(k.birthday);
      p2Body.append(`child_firstname[${i}]`, k.firstName);
      p2Body.append(`child_lastname[${i}]`, k.lastName);
      p2Body.append(`child_birth_month[${i}]`, bd.month);
      p2Body.append(`child_birth_day[${i}]`, bd.day);
      p2Body.append(`child_birth_year[${i}]`, bd.year);
    } else {
      p2Body.append(`child_firstname[${i}]`, "");
      p2Body.append(`child_lastname[${i}]`, "");
      p2Body.append(`child_birth_month[${i}]`, "");
      p2Body.append(`child_birth_day[${i}]`, "");
      p2Body.append(`child_birth_year[${i}]`, "");
    }
  }

  const p2 = await fetch(`${KBF_BASE}/center.php`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: KBF_BASE,
      Referer: `${KBF_BASE}/center.php?alley_id=${input.alleyId}&ptoken=${ptoken}`,
    },
    body: p2Body.toString(),
    redirect: "manual",
    cache: "no-store",
  });
  // 302 redirects to /fpass-choose-... on success (HAR confirmed).
  if (p2.status !== 302 && !p2.ok) {
    throw new Error(`KBF kid signup got HTTP ${p2.status}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ error: "Database not configured" }, { status: 500 });
    }

    const body = (await req.json().catch(() => ({}))) as Partial<RegisterBody>;
    const centerId = (body.centerId || "").toString();
    const centerName = CENTER_NAME[centerId];
    if (!centerName) {
      return NextResponse.json({ error: "Unknown center" }, { status: 400 });
    }

    const parent = body.parent ?? ({} as RegisterBody["parent"]);
    const firstName = (parent.firstName || "").trim();
    const lastName = (parent.lastName || "").trim();
    const email = (parent.email || "").trim().toLowerCase();
    const phoneDigits = normalizePhone(parent.phone || "");

    if (!firstName || !lastName) {
      return NextResponse.json({ error: "Parent name required" }, { status: 400 });
    }
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Valid email required" }, { status: 400 });
    }
    if (phoneDigits.length !== 10) {
      return NextResponse.json({ error: "Valid 10-digit phone required" }, { status: 400 });
    }

    const kids = Array.isArray(body.kids) ? body.kids : [];
    const cleanKids = kids
      .map((k) => ({
        firstName: (k.firstName || "").trim(),
        lastName: (k.lastName || lastName).trim(),
        birthday: (k.birthday || "").trim(),
      }))
      .filter((k) => k.firstName);
    if (cleanKids.length === 0) {
      return NextResponse.json({ error: "Add at least one kid" }, { status: 400 });
    }
    if (cleanKids.length > 6) {
      return NextResponse.json({ error: "Up to 6 kids per account" }, { status: 400 });
    }

    await ensureKbfSchema();
    const q = sql();

    // Reject if a row already exists at that center — direct them
    // back to the Email tab to sign in instead of duplicating.
    const existing = (await q`
      SELECT id FROM kbf_passes
      WHERE lower(email) = ${email} AND center_name = ${centerName}
      LIMIT 1
    `) as { id: number }[];
    if (existing.length > 0) {
      return NextResponse.json(
        {
          error:
            "An account with that email already exists at this center. Use the Email tab to sign in.",
        },
        { status: 409 },
      );
    }

    // Insert the pass row. Mark fpass=false (Families Bowl Free is an
    // upgrade purchased separately on kidsbowlfree.com); the wizard
    // will continue to render the parent as booking-guest only.
    const passRows = (await q`
      INSERT INTO kbf_passes (
        email, center_name, first_name, last_name,
        address, city, state, zip,
        date_added, fpass, birthday, birth_year, special_code, mail_link,
        phone, preferred_2fa, is_test
      )
      VALUES (
        ${email}, ${centerName}, ${firstName}, ${lastName},
        ${parent.address ?? ""}, ${parent.city ?? ""}, ${parent.state ?? ""}, ${parent.zip ?? ""},
        NOW(), FALSE, '', NULL, '', '',
        ${phoneDigits}, 'sms', FALSE
      )
      RETURNING id
    `) as { id: number }[];
    if (passRows.length === 0) {
      return NextResponse.json({ error: "Couldn't create account" }, { status: 500 });
    }
    const passId = passRows[0].id;

    // Bulk-insert kids (UNNEST keeps it to one round trip).
    const slots = cleanKids.map((_, i) => i + 1);
    const firstNames = cleanKids.map((k) => k.firstName);
    const lastNames = cleanKids.map((k) => k.lastName);
    const bdays = cleanKids.map((k) => k.birthday);
    const passIds = cleanKids.map(() => passId);
    const relations = cleanKids.map(() => "kid");

    await q`
      INSERT INTO kbf_pass_members (
        pass_id, relation, slot, first_name, last_name, birthday,
        redemptions, games, avg_score
      )
      SELECT * FROM UNNEST(
        ${passIds}::int[],
        ${relations}::text[],
        ${slots}::int[],
        ${firstNames}::text[],
        ${lastNames}::text[],
        ${bdays}::text[],
        ARRAY[${cleanKids.map(() => 0).join(",")}]::int[],
        ARRAY[${cleanKids.map(() => 0).join(",")}]::int[],
        ARRAY[${cleanKids.map(() => "NULL").join(",")}]::numeric[]
      )
    `;

    // Backfill birth_year on the parent row from the youngest kid's
    // birthday — we don't ask the parent for theirs in v1. Best-effort.
    const youngestYear = cleanKids
      .map((k) => birthYearFrom(k.birthday))
      .filter((y): y is number => y !== null)
      .sort((a, b) => b - a)[0];
    if (youngestYear) {
      await q`
        UPDATE kbf_passes SET birth_year = ${youngestYear} WHERE id = ${passId}
      `;
    }

    // Fire-and-forget side-effect: also create the account on
    // kidsbowlfree.com so the family receives weekly coupons. Only
    // attempted when we have both an alley_id mapping for the
    // center AND the parent supplied a password (we don't store
    // passwords; KBF requires one). Failures are logged + swallowed —
    // the local Neon row already lets the family book today.
    const alleyId = KBF_ALLEY_ID[centerId];
    const password = (parent.password || "").trim();
    if (alleyId && password) {
      try {
        await registerOnKidsBowlFree({
          alleyId,
          parent: {
            firstName,
            lastName,
            email,
            phone: phoneDigits,
            address: parent.address,
            city: parent.city,
            state: parent.state,
            zip: parent.zip,
          },
          kids: cleanKids,
          password,
        });
      } catch (err) {
        console.error("[kbf/register] kidsbowlfree.com side-effect failed (non-fatal):", err);
      }
    }

    // Return the same `passes` payload shape /api/kbf/verify uses so
    // the wizard can drop into the bowlers step without further work.
    const passes = await loadPassesWithMembers([passId]);
    return NextResponse.json(
      { ok: true, passes, kbfMirrored: !!(alleyId && password) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[kbf/register] error:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
