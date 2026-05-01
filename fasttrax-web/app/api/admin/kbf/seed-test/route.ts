import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "@/lib/db";
import { ensureKbfSchema } from "@/lib/kbf-sync";

/**
 * POST /api/admin/kbf/seed-test (gated by ADMIN_CAMERA_TOKEN)
 *
 * Seeds (or refreshes) the Kids Bowl Free demo account so internal
 * staff can demo the booking flow without a real KBF registration.
 *
 *   email:        kbftest@headpinz.com
 *   center_name:  HeadPinz Fort Myers
 *   is_test:      TRUE  (skips OTP at /api/kbf/lookup)
 *   fpass:        TRUE  (so the family-pass adult renders)
 *   members:      3 demo kids (Ava 7, Mason 9, Lila 5) + 1 family adult (Jordan)
 *
 * Idempotent — running twice updates the existing row instead of
 * duplicating. Members are nuked and re-inserted so a stale demo
 * roster from a previous run gets cleaned up.
 *
 * The email + center are constants so the test path is identical
 * for every QA pass. Override via query string if you need a
 * variant: `?email=kbf2@headpinz.com&center=HeadPinz%20Naples`.
 */

interface SeededRow {
  id: number;
  email: string;
  center: string;
  members: { relation: string; slot: number; firstName: string; lastName: string }[];
}

export async function POST(req: Request): Promise<NextResponse<SeededRow | { error: string }>> {
  try {
    if (!isDbConfigured()) {
      return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 500 });
    }
    await ensureKbfSchema();

    const url = new URL(req.url);
    const email = (url.searchParams.get("email") || "kbftest@headpinz.com")
      .trim()
      .toLowerCase();
    const center = url.searchParams.get("center") || "HeadPinz Fort Myers";
    const phone = (url.searchParams.get("phone") || "2390000000").replace(/\D/g, "");

    const q = sql();

    // Upsert the pass row. ON CONFLICT key matches the existing
    // unique constraint (email, center_name).
    const passRows = (await q`
      INSERT INTO kbf_passes (
        email, center_name, first_name, last_name, address, city, state, zip,
        date_added, fpass, birthday, birth_year, special_code, mail_link,
        phone, preferred_2fa, is_test
      )
      VALUES (
        ${email},
        ${center},
        'Kbf',
        'Test',
        '14513 Global Pkwy',
        'Fort Myers',
        'FL',
        '33913',
        NOW(),
        TRUE,
        '01/01/1985',
        1985,
        'TEST',
        'https://kidsbowlfree.com/test',
        ${phone},
        'email',
        TRUE
      )
      ON CONFLICT (email, center_name) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        zip = EXCLUDED.zip,
        fpass = TRUE,
        phone = EXCLUDED.phone,
        is_test = TRUE,
        last_synced_at = NOW()
      RETURNING id, email, center_name
    `) as { id: number; email: string; center_name: string }[];

    if (passRows.length === 0) {
      return NextResponse.json({ error: "Failed to upsert pass" }, { status: 500 });
    }
    const passId = passRows[0].id;

    // Reset member roster — wipe and re-insert so re-runs converge.
    await q`DELETE FROM kbf_pass_members WHERE pass_id = ${passId}`;

    interface MemberSeed {
      relation: "kid" | "family";
      slot: number;
      first: string;
      last: string;
      bday: string;
    }
    const members: MemberSeed[] = [
      { relation: "kid",    slot: 1, first: "Ava",    last: "Test", bday: "06/14/2018" },
      { relation: "kid",    slot: 2, first: "Mason",  last: "Test", bday: "03/22/2016" },
      { relation: "kid",    slot: 3, first: "Lila",   last: "Test", bday: "11/02/2020" },
      // Family-pass adult — only renders when kbf_passes.fpass = TRUE.
      { relation: "family", slot: 1, first: "Jordan", last: "Test", bday: "" },
    ];
    for (const m of members) {
      await q`
        INSERT INTO kbf_pass_members (
          pass_id, relation, slot, first_name, last_name, birthday,
          redemptions, games, avg_score
        )
        VALUES (
          ${passId},
          ${m.relation},
          ${m.slot},
          ${m.first},
          ${m.last},
          ${m.bday},
          0, 0, NULL
        )
      `;
    }

    const result: SeededRow = {
      id: passId,
      email: passRows[0].email,
      center: passRows[0].center_name,
      members: members.map((m) => ({
        relation: m.relation,
        slot: m.slot,
        firstName: m.first,
        lastName: m.last,
      })),
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error("[kbf/seed-test] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Seed failed" },
      { status: 500 },
    );
  }
}

// GET acts the same as POST so you can hit it from a browser bar
// without needing curl. Same auth gate via middleware.
export const GET = POST;
