import { NextRequest, NextResponse } from "next/server";
import { apiBase } from "@/lib/api-base";
import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import {
  addMembership,
  getMemberships,
  oneYearFromNow,
  LICENSE_MEMBERSHIP_KIND_ID,
} from "@/lib/pandora-memberships";

/**
 * Diagnostic for the standalone FastTrax-license grant — the PANDORA membership
 * rail (no BMI bill). Mints a fake person (or takes personId), writes the license
 * membership via Pandora `addMembership`, then re-reads memberships (Pandora
 * Firebird = immediate; BMI Office = may lag) to PROVE the membership attaches.
 *
 * Usage (Vercel preview):
 *   GET /api/test/license-diag?create=1&membershipKindId=<F_MSK_ID>
 *     → fake throwaway person + grant. No real customer. No card charged.
 *   GET /api/test/license-diag?personId=<id>&membershipKindId=<F_MSK_ID>
 *   GET /api/test/license-diag?listMemberships=1   → BMI /membership catalog
 *
 * membershipKindId defaults to RACE_LICENSE_MEMBERSHIP_KIND_ID. `probe=1` echoes
 * the input without any call. Read/WRITE against PROD Pandora — test ids only.
 */

export const maxDuration = 60;

const DEFAULT_CLIENT_KEY = "headpinzftmyers";

// Direct BMI GET (bypasses our /api/bmi proxy, which on prod lacks the membership
// allowlist and apiBase points there). Same creds the proxy uses.
const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";
async function bmiDirectGet(clientKey: string, path: string) {
  const authRes = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": BMI_SUB_KEY },
    body: JSON.stringify({
      Username: process.env.BMI_USERNAME || "",
      Password: process.env.BMI_PASSWORD || "",
    }),
    cache: "no-store",
  });
  const authData = await authRes.json().catch(() => ({}));
  const token = authData.AccessToken || authData.accessToken;
  const res = await fetch(`${BMI_API_URL}/public-booking/${clientKey}/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "BMI-Subscription-Key": BMI_SUB_KEY,
      "Accept-Language": "en",
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

/** Read memberships via BOTH sources: Pandora (Firebird, immediate) + BMI Office
 *  (cloud, may lag). Never throws — errors captured per source. */
async function membershipSnapshot(clientKey: string, personId: string) {
  const pandora = await getMemberships(personId).then(
    (rows) => ({
      rows,
      activeLicense: rows.some(
        (m) =>
          m.active &&
          (m.name.toLowerCase().includes("license") ||
            (!!LICENSE_MEMBERSHIP_KIND_ID && m.kindId === LICENSE_MEMBERSHIP_KIND_ID)),
      ),
    }),
    (err) => ({ error: err instanceof Error ? err.message : "pandora read failed" }),
  );
  const office = await fetchPersonRaw<{
    memberships?: Array<{ name?: string; stops?: string | null }>;
  }>(clientKey, personId).then(
    (person) => {
      const now = Date.now();
      const all = (person.memberships ?? []).map((m) => ({
        name: m.name ?? "",
        active: !m.stops || new Date(m.stops).getTime() > now,
      }));
      return {
        all,
        activeLicense: all.some((m) => m.name.toLowerCase().includes("license") && m.active),
      };
    },
    (err) => ({ error: err instanceof Error ? err.message : "office read failed" }),
  );
  return { pandora, office };
}

const hasLicense = (snap: { pandora: { activeLicense?: boolean } }) =>
  snap.pandora.activeLicense === true;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientKey = searchParams.get("clientKey") || DEFAULT_CLIENT_KEY;
    const create = searchParams.get("create") === "1";
    let personId = searchParams.get("personId");
    const membershipKindId = searchParams.get("membershipKindId") || undefined;

    if (searchParams.get("probe") === "1") {
      return NextResponse.json({
        ok: true,
        probe: true,
        inputShape: { create, personId, membershipKindId, clientKey },
        configuredKindId: LICENSE_MEMBERSHIP_KIND_ID || null,
      });
    }

    // BMI membership product catalog (for reference — empty for FastTrax).
    if (searchParams.get("listMemberships") === "1") {
      const r = await bmiDirectGet(clientKey, "membership");
      return NextResponse.json({ ok: r.status < 400, status: r.status, memberships: r.body });
    }

    if (!create && (!personId || !/^\d{1,20}$/.test(personId))) {
      return NextResponse.json(
        { error: "Provide create=1 (mint a fake person) or personId=<digits>" },
        { status: 400 },
      );
    }

    const trace: Record<string, unknown> = {
      input: { create, personId, membershipKindId, clientKey },
      timestamp: new Date().toISOString(),
    };

    // Mint a fake throwaway person (Pandora → Firebird). addMembership writes to
    // the SAME Firebird, so there is no cloud-sync lag between create and grant.
    if (create) {
      const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
      const fake = {
        firstName: "Ztest",
        lastName: `Licdiag${suffix}`,
        email: `licdiag+${suffix}@bma.test`,
        phone: `239555${suffix.slice(-4)}`,
        birthdate: "1990-01-01",
      };
      trace.fakePerson = fake;
      const createRes = await fetch(`${apiBase()}/api/pandora`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fake),
      });
      const createData = await createRes.json().catch(() => ({}));
      trace.create = {
        status: createRes.status,
        personId: createData.personId,
        error: createData.error,
      };
      if (!createData.personId) {
        return NextResponse.json({ ok: false, stoppedAt: "create-person", trace }, { status: 502 });
      }
      personId = String(createData.personId);
    }

    trace.personId = personId;
    trace.before = await membershipSnapshot(clientKey, personId!);

    // Grant the license membership via Pandora (no BMI bill), 1-year term.
    trace.expires = oneYearFromNow();
    try {
      trace.membershipId = await addMembership({
        personId: personId!,
        membershipKindId,
        expires: trace.expires as string,
      });
    } catch (err) {
      trace.grantError = err instanceof Error ? err.message : "addMembership failed";
      return NextResponse.json(
        { ok: false, stoppedAt: "addMembership", personId, trace },
        { status: 500 },
      );
    }

    trace.after = await membershipSnapshot(clientKey, personId!);
    const licenseAttached =
      hasLicense(trace.after as { pandora: { activeLicense?: boolean } }) &&
      !hasLicense(trace.before as { pandora: { activeLicense?: boolean } });
    trace.licenseAttached = licenseAttached;

    return NextResponse.json({
      ok: true,
      licenseAttached,
      personId,
      membershipId: trace.membershipId,
      after: trace.after,
      trace,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Diag error" },
      { status: 500 },
    );
  }
}
