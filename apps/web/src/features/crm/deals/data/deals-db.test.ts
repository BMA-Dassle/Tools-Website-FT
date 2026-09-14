import { describe, expect, it } from "vitest";
import {
  DEAL_CENTER_CODE,
  DEAL_EVENT_DATE,
  binder,
  buildDealQuery,
  buildKeyCte,
  repClause,
  searchClause,
} from "./deals-db";

/**
 * The SQL boundary. No Neon — the query builder is a pure function of the
 * filter, and the parts that matter are: which key set each scope emits, that
 * every bound parameter is REFERENCED, and that nothing narrows the spine in a
 * way that could drop a row.
 */

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

describe("the key set — one row per deal, keyed on the spine", () => {
  it("the quote scope keys on the CONTRACT, so two quotes can never collapse", () => {
    const b = binder();
    const cte = oneLine(buildKeyCte("quote", { scope: "quote" }, b));
    expect(cte).toContain("FROM group_function_quotes q0");
    expect(cte).toContain("q0.id::text AS key_quote_id");
    expect(cte).not.toContain("crm_bmi_projects");
    expect(b.params).toEqual([]);
  });

  it("the project scope is group functions only — online bookings are not deals", () => {
    const b = binder();
    const cte = oneLine(buildKeyCte("project", { scope: "project" }, b));
    expect(cte).toContain("p0.kind_id IS DISTINCT FROM $1");
    expect(b.params).toEqual(["-10"]);
    expect(cte).not.toContain("UNION");
  });

  it("the board scope UNIONs the mirror with every live lead, and dedupes", () => {
    const b = binder();
    const cte = oneLine(buildKeyCte("board", { scope: "board" }, b));
    expect(cte).toContain("FROM crm_bmi_projects p0");
    expect(cte).toContain("FROM crm_leads l0");
    // UNION, never UNION ALL: a lead whose project is mirrored contributes the
    // same key as the project, and the two must collapse into ONE deal.
    expect(cte).toContain("UNION");
    expect(cte).not.toContain("UNION ALL");
    expect(cte).toContain("l0.archived_at IS NULL");
  });

  it("a lead with no project keys on its own row id, so it cannot vanish", () => {
    const cte = oneLine(buildKeyCte("board", { scope: "board" }, binder()));
    expect(cte).toContain(
      "CASE WHEN NULLIF(l0.bmi_project_id, '') IS NULL THEN l0.id::text END AS key_lead_id",
    );
  });
});

describe("every bound parameter is referenced", () => {
  /**
   * Postgres refuses a statement that carries a parameter nothing names —
   * "could not determine data type of parameter $1". A key set built eagerly
   * and then discarded is exactly how that happens, and it took out every
   * Contracts window except the default once already.
   */
  const referencesEveryParam = (text: string, params: unknown[]) => {
    const named = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    for (let i = 1; i <= params.length; i += 1) {
      expect(named.has(i), `$${i} is bound but never referenced`).toBe(true);
    }
  };

  it("holds for the quote scope with no filters at all", () => {
    const built = buildDealQuery({ filter: { scope: "quote" } });
    referencesEveryParam(built.text, built.params);
  });

  it("holds for the quote scope with a window, a centre and a search", () => {
    const built = buildDealQuery({
      filter: {
        scope: "quote",
        from: "2026-09-13",
        until: "2026-09-20",
        centre: "FT",
        q: "juniper",
      },
    });
    referencesEveryParam(built.text, built.params);
  });

  it("holds for the board scope with a window and a centre", () => {
    const built = buildDealQuery({
      filter: { scope: "board", from: "2026-09-13", centre: "HPN" },
    });
    referencesEveryParam(built.text, built.params);
  });

  it("holds for the project scope narrowed to a list of project ids", () => {
    const built = buildDealQuery({
      filter: { scope: "project", projectIds: ["47357477", "63000000009561437"] },
    });
    referencesEveryParam(built.text, built.params);
    expect(built.params).toContainEqual(["47357477", "63000000009561437"]);
  });
});

describe("where the window is applied", () => {
  it("the project-spined scopes narrow the KEY SET, before the laterals run", () => {
    const built = buildDealQuery({ filter: { scope: "board", from: "2026-09-13" } });
    expect(oneLine(built.text)).toContain("p0.event_date >= $2::date");
  });

  it("the quote-spined scope narrows on the MERGED date instead", () => {
    // A contract's deal date can come from the project rather than the
    // contract, so narrowing the key set on `q0.event_date` would drop rows
    // the screen would then display on a different day.
    const built = buildDealQuery({ filter: { scope: "quote", from: "2026-09-13" } });
    const text = oneLine(built.text);
    expect(text).not.toContain("q0.event_date");
    expect(text).toContain(oneLine(DEAL_EVENT_DATE));
  });

  it("the merged date and centre are BMI first", () => {
    expect(oneLine(DEAL_EVENT_DATE)).toBe("COALESCE(p.event_date, q.event_date, l.event_date)");
    expect(oneLine(DEAL_CENTER_CODE)).toContain("CASE p.location_id");
    expect(oneLine(DEAL_CENTER_CODE)).toContain("q.center_code");
  });
});

describe("the joins cannot double a deal", () => {
  const text = oneLine(buildDealQuery({ filter: { scope: "board" } }).text);

  it("both overlays are LATERALs limited to one row", () => {
    expect(text).toContain("LEFT JOIN LATERAL");
    expect(text.match(/LEFT JOIN LATERAL/g)?.length).toBe(2);
    expect(text.match(/LIMIT 1/g)?.length).toBe(2);
  });

  it("the lead joins on the BMI project id, never on gf_short_id", () => {
    expect(text).toContain("ll.bmi_project_id = k.key_project_id");
    expect(text).not.toContain("gf_short_id");
  });

  it("the quote joins on bmi_reservation_id when the key is a project", () => {
    // CAST THE QUOTE'S SIDE, never ours. `bmi_reservation_id` is numeric in
    // that table and `key_project_id` is TEXT; casting our side to a number
    // would round a 17-digit BMI id past Number.MAX_SAFE_INTEGER, which is the
    // production off-by-one this codebase has a hard rule about.
    expect(text).toContain("qq.bmi_reservation_id::text = k.key_project_id");
  });

  it("the quote lateral re-labels event_date to the DEAL's date", () => {
    // This is what lets ATTENTION_SQL judge a contract on the day the event is
    // actually on, without a second copy of the predicate.
    expect(text).toContain("COALESCE(p.event_date, qq.event_date::date) AS event_date");
  });

  it("`spine` names the table the identity came from", () => {
    expect(text).toContain("WHEN p.project_id IS NOT NULL THEN 'project'");
    expect(text).toContain("WHEN k.key_quote_id IS NOT NULL THEN 'quote'");
  });
});

describe("the search box reaches all three tables", () => {
  it("matches the event, the guest, the company and the BMI number", () => {
    const b = binder();
    const clause = searchClause("juniper", b);
    for (const fragment of [
      "q.event_name ILIKE",
      "p.name ILIKE",
      "p.number ILIKE",
      "a.name ILIKE",
      "l.public_id ILIKE",
      "q.contract_short_id ILIKE",
    ]) {
      expect(clause).toContain(fragment);
    }
    expect(b.params).toEqual(["%juniper%"]);
  });

  it("adds the phone branch ONLY when the term holds digits", () => {
    expect(searchClause("juniper", binder())).not.toContain("regexp_replace");
    const b = binder();
    expect(searchClause("239 555 1234", b)).toContain("regexp_replace");
    expect(b.params).toEqual(["%239 555 1234%", "%2395551234%"]);
  });
});

describe("the rep filter means the same thing on every lens", () => {
  it("matches the lead's assignee, then Office's responsible, then the planner", () => {
    const b = binder();
    const clause = repClause(
      {
        repId: "1",
        officeIds: ["28267036", "6338800"],
        officeNames: ["kelsea kosco"],
        email: "kelsea@headpinz.com",
      },
      b,
    );
    expect(clause).toContain("l.assigned_rep_id = $1::bigint");
    // The BMI / planner fallback applies only when NOBODY owns it in the CRM,
    // so a deal a director reassigned by hand stops answering to its old owner.
    expect(clause).toContain("l.id IS NULL");
    expect(clause).toContain("p.responsible_user_id = ANY($2::text[])");
    expect(clause).toContain("lower(q.planner_email) = $4");
  });

  it("matches NOTHING when there is no key at all, never everything", () => {
    expect(repClause({ repId: null, officeIds: [], officeNames: [], email: null }, binder())).toBe(
      "FALSE",
    );
  });
});
