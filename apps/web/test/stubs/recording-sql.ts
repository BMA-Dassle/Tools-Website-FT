/**
 * A recording stand-in for `@ft/db`'s `sql()` — the tagged template AND
 * `.query(text, params)` — so a data module's SQL can be asserted without Neon
 * (brief §3.10 "tested at the SQL boundary with a recording tagged-template
 * stub"). Use with `vi.mock("@ft/db", …)`:
 *
 *   const db = vi.hoisted(() => makeRecordingSql());
 *   vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));
 *
 * `respond` decides what each statement returns; default `[]`.
 */

export interface RecordedStatement {
  text: string;
  params: unknown[];
}

export interface RecordingSql {
  /** The stand-in for `sql()`'s return value. */
  q: RecordingQuery;
  statements: RecordedStatement[];
  /** Override per test: given the statement, return its rows. */
  respond: (stmt: RecordedStatement) => unknown[] | Promise<unknown[]>;
  reset(): void;
  /** Statements whose text matches. */
  matching(re: RegExp): RecordedStatement[];
}

export interface RecordingQuery {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  query(text: string, params?: unknown[]): Promise<unknown[]>;
}

export function makeRecordingSql(): RecordingSql {
  const rec: RecordingSql = {
    statements: [],
    respond: () => [],
    reset() {
      rec.statements = [];
      rec.respond = () => [];
    },
    matching(re) {
      return rec.statements.filter((s) => re.test(s.text));
    },
    q: undefined as unknown as RecordingQuery,
  };

  const run = async (text: string, params: unknown[]): Promise<unknown[]> => {
    const stmt = { text: text.replace(/\s+/g, " ").trim(), params };
    rec.statements.push(stmt);
    return rec.respond(stmt);
  };

  const tagged = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => {
      text += s;
      if (i < values.length) text += `$${i + 1}`;
    });
    return run(text, values);
  }) as RecordingQuery;
  tagged.query = (text: string, params: unknown[] = []) => run(text, params);

  rec.q = tagged;
  return rec;
}
