import { NextRequest, NextResponse } from "next/server";
import { BMI_CLIENT_KEY, officeGet } from "@/lib/bmi-office-client";

// ── GET handler ─────────────────────────────────────────────────────────────
//
// Transport + OAuth (with stale-token retry) live in lib/bmi-office-client.ts,
// shared with the customer-account dashboard. NOTE: this route JSON-parses each
// body for its admin-tool callers — fine for the search/person/project/deposit
// shapes used here, but a caller needing a 17-digit personId must use
// `officeGet` directly + `parseWithRawIds` (see features/account/data/bmi-race.ts).

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    // Person search by email/name/phone
    if (action === "search") {
      const query = searchParams.get("q") || "";
      const max = searchParams.get("max") || "20";
      if (!query) {
        return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
      }
      const path = `/api/${BMI_CLIENT_KEY}/search/person?token=${encodeURIComponent(query)}&maxResults=${max}`;
      const res = await officeGet(path);
      console.log(`[BMI Office search] ${res.status} (${query})`);
      return NextResponse.json(JSON.parse(res.body), { status: res.status >= 400 ? 500 : 200 });
    }

    // Person details by ID
    if (action === "person") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }
      const res = await officeGet(`/api/${BMI_CLIENT_KEY}/person/${id}`);
      return NextResponse.json(JSON.parse(res.body), { status: res.status >= 400 ? 500 : 200 });
    }

    // Project details by ID (returns projectReference for waiver link)
    if (action === "project") {
      const id = searchParams.get("id") || "";
      if (!id) {
        return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
      }
      const res = await officeGet(`/api/${BMI_CLIENT_KEY}/project/${id}`);
      return NextResponse.json(JSON.parse(res.body), { status: res.status >= 400 ? 500 : 200 });
    }

    // Deposit history — check credit balance for a person
    if (action === "deposits") {
      const personId = searchParams.get("personId") || "";
      if (!personId) {
        return NextResponse.json({ error: "Missing personId parameter" }, { status: 400 });
      }
      // Default: look back 2 years
      const now = new Date();
      const from =
        searchParams.get("from") ||
        new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).toISOString().split(".")[0];
      const until = searchParams.get("until") || now.toISOString().split(".")[0];

      const path = `/api/${BMI_CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`;
      const res = await officeGet(path);
      return NextResponse.json(JSON.parse(res.body), { status: res.status >= 400 ? 500 : 200 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Office API error" },
      { status: 500 },
    );
  }
}
