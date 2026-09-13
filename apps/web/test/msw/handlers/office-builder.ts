import { HttpResponse, http, rawJson } from "../server";
import { OFFICE_BASE } from "./office";

/**
 * MSW for BMI Office's **write** surface — the endpoints C5's builder drives.
 *
 * Its own module rather than an addition to `office.ts`: these handlers carry
 * MUTABLE STATE (a project whose `products` really grows and shrinks), and a
 * suite that only wants the read fixtures should not inherit it.
 *
 * ── WHY THE PROJECT IS MUTABLE ────────────────────────────────────────────
 *
 * The builder's central promise is "never trust a 200": after every write it
 * re-reads the project and only marks a line written when Office reads the row
 * back. A handler that answered a canned project would let that rule pass
 * vacuously — the test would prove the code CALLS the re-read, not that the
 * re-read means anything. So `POST /projectProduct` really appends, `DELETE`
 * really removes, and `GET /project/{id}` really answers with whatever the
 * writes have left behind.
 *
 * ── WHY EVERY BODY IS BUILT AS TEXT ───────────────────────────────────────
 *
 * `HttpResponse.json({ id: 63000000009561437 })` is ALREADY ROUNDED by the time
 * the JS object is evaluated — the fixture would be corrupt before it ever
 * reached `parseWithRawIds`, and the precision test would pass against a lie.
 * Every id below is therefore interpolated into a STRING, never written as a
 * numeric literal, and served through `rawJson`.
 *
 * ── THE 403 ───────────────────────────────────────────────────────────────
 *
 * `linkSchedule` against `FULL_RESOURCE_ID` answers Office's real soft-refusal
 * envelope, captured from a live tenant, UNLESS the body carries
 * `"confirm":true` — which is the entire override protocol and the thing a
 * director's "Force" button relies on.
 */

// ── The ids. 17 digits: these are the values that round under a naive parse. ──

export const BUILDER_PROJECT_ID = "63000000009561501";
export const BUILDER_PERSON_ID = "63000000009561437";
export const BUILDER_BILL_ID = "63000000009561502";
/**
 * What `POST /projectProduct` assigns to the FIRST line created in a test.
 *
 * CHOSEN SO IT ACTUALLY CORRUPTS. Doubles near 6.3e16 are spaced 8 apart, so a
 * value that happens to land on a multiple of 8 survives `JSON.parse` intact
 * and would make the negative control in `office-write.test.ts` pass while
 * proving nothing. …513 is not a multiple of 8: standard parsing turns it into
 * …512, which is exactly the silent failure this whole rail exists to prevent.
 *
 * A STRING, and incremented as one. A `BigInt` literal would be the obvious
 * way to count from here, and `tsc` refuses it below an ES2020 target (this
 * project's) — but the deeper point is that a 17-digit id has no business
 * being a JS number of any kind in a file whose whole job is proving they
 * survive. `rowIdAt` adds to the last four digits and leaves the prefix alone.
 */
export const BUILDER_PRODUCT_ROW_BASE = "63000000009561513";

function rowIdAt(offset: number): string {
  const head = BUILDER_PRODUCT_ROW_BASE.slice(0, -4);
  const tail = Number(BUILDER_PRODUCT_ROW_BASE.slice(-4)) + offset;
  return head + String(tail).padStart(4, "0");
}
export const BUILDER_PRODUCT_ID = "14838862";
export const BUILDER_SCHEDULE_ID = "63000000009561540";

/** A resource whose heats are full — `linkSchedule` against it is refused. */
export const FULL_RESOURCE_ID = "11208660";
export const OPEN_RESOURCE_ID = "11208654";

/**
 * Office's soft refusal, verbatim from a live tenant (project 58454076,
 * 2026-08-12). `IsQuestion:false` because our API2 service account is never
 * offered the dialog — which reads final and is not: the identical body with
 * `confirm:true` returns 200 on that same account.
 */
export const LINK_SCHEDULE_REFUSAL = {
  IsQuestion: false,
  Kind: 4,
  Message:
    "Total persons (12) is higher than the capacity (0) in HP Arena: " +
    "8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM, overbooking is not allowed.",
  OperationId: "8389cf8a268af9b19134286e9ae39f06",
};

// ── Call recording ─────────────────────────────────────────────────────────

export interface RecordedWrite {
  method: string;
  path: string;
  sessionId: string | null;
  search: URLSearchParams;
  /** The request body exactly as it went on the wire — never re-serialised. */
  body: string;
}

export const officeWriteCalls: RecordedWrite[] = [];

async function record(request: Request): Promise<string> {
  const url = new URL(request.url);
  const body = request.method === "GET" ? "" : await request.clone().text();
  officeWriteCalls.push({
    method: request.method,
    path: url.pathname,
    sessionId: request.headers.get("x-session-id"),
    search: url.searchParams,
    body,
  });
  return body;
}

// ── The mutable project ────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  productId: string;
  quantity: number;
  pricePerUnit: number;
  name: string | null;
}

interface ProjectState {
  exists: boolean;
  name: string;
  /** Centre-local wall clock, no offset — exactly what Office sends. */
  date: string;
  persons: number;
  personId: string | null;
  products: ProductRow[];
  /** How many product rows this project has handed out — the id offset. */
  productRowsIssued: number;
}

export const officeProjectState: ProjectState = freshProject();

function freshProject(): ProjectState {
  return {
    exists: false,
    name: "CRM TEST — ignore",
    date: "2026-10-17T18:00:00",
    persons: 12,
    personId: BUILDER_PERSON_ID,
    products: [],
    productRowsIssued: 0,
  };
}

/** Call in `beforeEach`: forget every recorded call and every written line. */
export function resetOfficeBuilderState(): void {
  officeWriteCalls.length = 0;
  Object.assign(officeProjectState, freshProject());
  setPandoraLocalSynced(false);
}

/** Pre-create the project, for a test that starts from "it already exists". */
export function seedExistingProject(patch: Partial<ProjectState> = {}): void {
  Object.assign(officeProjectState, { ...freshProject(), exists: true }, patch);
}

// ── Response bodies, built as TEXT so no id is ever a JS number ─────────────

function productJson(p: ProductRow): string {
  return (
    `{"id":${p.id},"projectId":${BUILDER_PROJECT_ID},"productId":${p.productId},` +
    `"quantity":${p.quantity},"pricePerUnit":${p.pricePerUnit},` +
    `"totalPrice":${round2(p.pricePerUnit * p.quantity)},` +
    `"name":${p.name === null ? "null" : JSON.stringify(p.name)}}`
  );
}

function projectJson(): string {
  const s = officeProjectState;
  const total = s.products.reduce((a, p) => a + p.pricePerUnit * p.quantity, 0);
  return (
    `{"id":${BUILDER_PROJECT_ID},"number":"H3311",` +
    `"name":${JSON.stringify(s.name)},"displayName":${JSON.stringify(s.name)},` +
    `"personId":${s.personId ?? "null"},"persons":${s.persons},` +
    `"date":${JSON.stringify(s.date)},"companyId":null,"stateId":49130082,"kindId":-1,` +
    `"confirm":false,"balance":0,"reservationId":null,` +
    `"bills":[{"id":${BUILDER_BILL_ID},"total":${round2(total)},"balance":${round2(total)}}],` +
    `"projectPersons":[],"schedules":[],` +
    `"products":[${s.products.map(productJson).join(",")}],"logs":[]}`
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pandora's base, as `lib/bmi-sync-barriers.ts` builds it.
 *
 * Declared HERE, above the handler array, not below it: a `const` referenced
 * from a template literal inside that array is in its temporal dead zone if it
 * is declared afterwards, and the whole module throws on import.
 */
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";

/** Has the project reached the centre's own server yet? Flip it in a test. */
let pandoraLocalSynced = false;

export function setPandoraLocalSynced(value: boolean): void {
  pandoraLocalSynced = value;
}

export function isPandoraLocalSynced(): boolean {
  return pandoraLocalSynced;
}

/**
 * The price a product costs on a date — WEEKEND COSTS MORE.
 *
 * The whole reason the builder calls `projectProduct/price` per date rather
 * than caching one number, so the fixture has to actually differ or the test
 * proves nothing. Saturday and Sunday are 1.25×.
 */
export function fixturePriceFor(date: string): number {
  const day = new Date(`${date.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const weekend = day === 0 || day === 6;
  return weekend ? 24.99 : 19.99;
}

// ── Handlers ───────────────────────────────────────────────────────────────

/**
 * ORDER MATTERS. `project/balance` is registered before `project/:id`, or the
 * `:id` pattern swallows the literal "balance". (Office itself disambiguates
 * with a `{id:long}` route constraint, which a path pattern has no equivalent
 * of.)
 */
export const officeBuilderHandlers = [
  http.post(`${OFFICE_BASE}/auth/token`, () =>
    rawJson('{"access_token":"test-token","expires_in":86400}'),
  ),

  http.post(`${OFFICE_BASE}/api/:clientKey/project/autocreate`, async ({ request }) => {
    await record(request);
    officeProjectState.exists = true;
    return rawJson(projectJson());
  }),

  http.post(`${OFFICE_BASE}/api/:clientKey/project/autosave`, async ({ request }) => {
    const body = await record(request);
    // Reflect the save, so a re-read shows what was actually asked for.
    const name = /"name":"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
    if (name) officeProjectState.name = JSON.parse(`"${name}"`) as string;
    const date = /"date":"([^"]+)"/.exec(body)?.[1];
    if (date) officeProjectState.date = date;
    const persons = /"persons":(\d+)/.exec(body)?.[1];
    if (persons) officeProjectState.persons = Number(persons);
    return rawJson(projectJson());
  }),

  http.get(`${OFFICE_BASE}/api/:clientKey/search/person`, async ({ request }) => {
    await record(request);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!token) return rawJson("[]");
    // `localId`, not `id` — and 17 digits, so a naive parse corrupts it.
    return rawJson(
      `[{"localId":${BUILDER_PERSON_ID},"description":"Dana Acme (3/14/1988) · last seen 2026-08-01"}]`,
    );
  }),

  http.get(`${OFFICE_BASE}/api/:clientKey/person/download`, async ({ request }) => {
    await record(request);
    return rawJson(
      `{"id":${BUILDER_PERSON_ID},"firstName":"Dana","name":"Acme","birthDate":"1988-03-14",` +
        `"addresses":[{"id":null,"kind":0,"email":"dana@example.com","mobile":"2395551234"}],` +
        `"memberships":[],"tags":[]}`,
    );
  }),

  http.put(`${OFFICE_BASE}/api/:clientKey/person`, async ({ request }) => {
    const body = await record(request);
    return rawJson(body);
  }),

  http.post(`${OFFICE_BASE}/api/:clientKey/projectProduct/price`, async ({ request }) => {
    await record(request);
    const date = new URL(request.url).searchParams.get("date") ?? "2026-10-17";
    const price = fixturePriceFor(date);
    return rawJson(`{"pricePerUnit":${price},"price":${price},"totalPrice":${price}}`);
  }),

  http.post(`${OFFICE_BASE}/api/:clientKey/projectProduct/linkSchedule`, async ({ request }) => {
    const body = await record(request);
    const confirmed = /"confirm":true/.test(body);
    if (!confirmed && body.includes(`"resourceId":"${FULL_RESOURCE_ID}"`)) {
      return rawJson(JSON.stringify(LINK_SCHEDULE_REFUSAL), { status: 403 });
    }
    return rawJson(
      `{"schedules":[{"id":${BUILDER_SCHEDULE_ID},"resourceId":${OPEN_RESOURCE_ID},` +
        `"start":"2026-10-17T18:00:00","stop":"2026-10-17T18:12:00"}]}`,
    );
  }),

  http.put(`${OFFICE_BASE}/api/:clientKey/projectSchedule/batch`, async ({ request }) => {
    await record(request);
    return rawJson(
      `{"schedules":[{"id":${BUILDER_SCHEDULE_ID},"resourceId":${OPEN_RESOURCE_ID}}]}`,
    );
  }),

  http.post(`${OFFICE_BASE}/api/:clientKey/projectProduct`, async ({ request }) => {
    const body = await record(request);
    const parsed = JSON.parse(body) as {
      productId: string;
      quantity: number;
      pricePerUnit: number;
      name: string | null;
    };
    const row: ProductRow = {
      id: rowIdAt(officeProjectState.productRowsIssued),
      productId: String(parsed.productId),
      quantity: Number(parsed.quantity),
      pricePerUnit: Number(parsed.pricePerUnit),
      name: parsed.name ?? null,
    };
    officeProjectState.productRowsIssued += 1;
    officeProjectState.products.push(row);
    return rawJson(productJson(row));
  }),

  http.delete(`${OFFICE_BASE}/api/:clientKey/projectProduct`, async ({ request }) => {
    await record(request);
    const id = new URL(request.url).searchParams.get("id");
    officeProjectState.products = officeProjectState.products.filter((p) => p.id !== id);
    return rawJson("{}");
  }),

  http.get(`${OFFICE_BASE}/api/:clientKey/project/balance`, async ({ request }) => {
    await record(request);
    const total = officeProjectState.products.reduce((a, p) => a + p.pricePerUnit * p.quantity, 0);
    return rawJson(`{"total":${round2(total)},"paid":0,"balance":${round2(total)}}`);
  }),

  http.get(`${OFFICE_BASE}/api/:clientKey/project/:id`, async ({ request, params }) => {
    await record(request);
    if (params.id !== BUILDER_PROJECT_ID) return undefined;
    if (!officeProjectState.exists) return new HttpResponse("Not found", { status: 404 });
    return rawJson(projectJson());
  }),

  /**
   * `PUT /project` — the rail `putProjectFields` drives when the builder moves
   * the date. It reflects the change so the verified re-read that function
   * insists on has something true to read.
   */
  http.put(`${OFFICE_BASE}/api/:clientKey/project`, async ({ request }) => {
    const body = await record(request);
    const date = /"date":"([^"]+)"/.exec(body)?.[1];
    if (date) officeProjectState.date = date;
    return rawJson(projectJson());
  }),

  /**
   * Pandora's local-copy probe — the "syncing to centre" question.
   *
   * `pandoraLocalSynced` decides the answer, so a test can watch the banner
   * move from "syncing" to "clean" the way it does at a real centre minutes
   * after the write.
   */
  http.get(`${PANDORA_BASE}/bmi/reservation/:locationId/:projectId`, () =>
    pandoraLocalSynced
      ? rawJson('{"success":true}')
      : new HttpResponse('{"error":"not found"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
  ),
];

/** Every call made to one path, in order — the assertion helper tests reach for. */
export function callsTo(pathSuffix: string): RecordedWrite[] {
  return officeWriteCalls.filter((c) => c.path.endsWith(pathSuffix));
}
