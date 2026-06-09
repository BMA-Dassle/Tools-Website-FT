/**
 * Direct BMI scan — replaces Hermes queue for event discovery.
 *
 * Scans BMI Office dayPlanner for projects in "New Deposit Requested"
 * states, fetches their details + products, and returns HermesQueueItem-
 * compatible objects so the dispatch cron can process them unchanged.
 *
 * Eliminates the Hermes "read = consumed" queue bug and the dependency
 * on Hermes polling the Firebird database.
 */

import { fetchProject, fetchPersonsByIds } from "@/lib/bmi-office-actions";
import {
  fetchReservationProducts,
  fetchReservationDetail,
  type HermesQueueItem,
  type HermesProduct,
} from "@/lib/hermes-client";
import { taxCents } from "@/lib/group-function-pricing";
import { normalizeEtDate } from "@/lib/et-time";

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";
const OFFICE_PASS = Buffer.from(OFFICE_PASS_B64, "base64").toString();
const SMS_VERSION = "6251006 202511051229";

const CLIENT_KEYS: Record<string, string> = {
  "fort-myers": "headpinzftmyers",
  fasttrax: "headpinzftmyers",
  naples: "headpinznaples",
};

interface CenterConfig {
  clientKey: string;
  centerCode: string;
  hermesCenter: string;
  sendContractStateId: string;
  pendingSignedContractStateId: string;
}

/** Build full resource ID list from metadata (top-level + all group members). */
function extractAllResourceIds(meta: {
  resources: Array<{ id: string }>;
  resourceGroups?: Array<{ resources?: Array<{ id: string }> }>;
}): string[] {
  const ids = new Set<string>();
  for (const r of meta.resources || []) ids.add(String(r.id));
  for (const g of meta.resourceGroups || []) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  return [...ids];
}

export const CENTERS: CenterConfig[] = [
  {
    clientKey: "headpinzftmyers",
    centerCode: "fort-myers",
    hermesCenter: "10.48.0.14",
    sendContractStateId: "49130082",
    pendingSignedContractStateId: "48952154",
  },
  {
    clientKey: "headpinznaples",
    centerCode: "naples",
    hermesCenter: "10.40.0.43",
    sendContractStateId: "8020645",
    pendingSignedContractStateId: "8007473",
  },
];

function httpsRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: OFFICE_HOST,
      path,
      method,
      headers: { ...headers, "Content-Type": "application/json" },
    };
    const req = https.request(opts, (res: any) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

let cachedToken: string | null = null;
let tokenExpiry = 0;
let tokenClientKey = "";

async function getToken(clientKey: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000 && tokenClientKey === clientKey) {
    return cachedToken;
  }
  const res = await httpsRequest(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`,
  );
  if (res.status !== 200) throw new Error(`Auth failed: ${res.status}`);
  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenClientKey = clientKey;
  tokenExpiry = Date.now() + parseInt(data.expires_in || "86400", 10) * 1000;
  return cachedToken!;
}

interface BmiProject {
  id: string;
  name: string;
  displayName: string;
  number: string;
  stateId: string;
  kindId: string;
  personId: string;
  persons: number;
  date: string;
}

/**
 * Scan BMI for events in "New Deposit Requested" states.
 * Returns HermesQueueItem-compatible objects ready for processQueueItem.
 */
/** Split a date range into 30-day windows. */
function monthlyWindows(from: Date, months: number): Array<{ from: string; till: string }> {
  const windows: Array<{ from: string; till: string }> = [];
  const cursor = new Date(from);
  for (let i = 0; i < months; i++) {
    const start = cursor.toISOString().slice(0, 10);
    cursor.setDate(cursor.getDate() + 30);
    const end = cursor.toISOString().slice(0, 10);
    windows.push({ from: start, till: end });
  }
  return windows;
}

export async function scanForNewEvents(targetStateIds?: Set<string>): Promise<HermesQueueItem[]> {
  const items: HermesQueueItem[] = [];

  for (const center of CENTERS) {
    try {
      const token = await getToken(center.clientKey);
      const headers = {
        Authorization: `Bearer ${token}`,
        "x-fast-version": SMS_VERSION,
        "x-session-id": `scan-${Date.now()}`,
        clientkey: center.clientKey,
      };

      // Get ALL resource IDs from metadata (top-level + resource groups)
      const metaRes = await httpsRequest("GET", `/api/${center.clientKey}/metadata`, headers);
      if (metaRes.status >= 400) continue;
      const meta = JSON.parse(metaRes.body);
      const ids = extractAllResourceIds(meta);
      if (ids.length === 0) continue;
      const resourceParam = ids.map((id) => `resourceIds=${id}`).join("&");

      // Fetch projects in monthly batches to avoid API timeout
      const windows = monthlyWindows(new Date(), 12);
      const allProjects: BmiProject[] = [];
      for (const w of windows) {
        try {
          const dpRes = await httpsRequest(
            "GET",
            `/api/${center.clientKey}/dayPlanner?${resourceParam}&from=${w.from}&till=${w.till}&showAll=true`,
            headers,
          );
          if (dpRes.status >= 400) continue;
          const dp = JSON.parse(dpRes.body);
          const batch = (dp.reservations?.projects || []) as BmiProject[];
          allProjects.push(...batch);
        } catch (err) {
          console.warn(`[bmi-scan] ${center.clientKey} batch ${w.from}→${w.till} failed:`, err);
        }
      }

      // Dedupe and filter out online reservations (kindId=-10)
      const seen = new Set<string>();
      const projects = allProjects.filter((p) => {
        if (String(p.kindId) === "-10") return false;
        const id = String(p.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      // Filter to "Send Contract" state by default, or the caller's target
      // states (used by the legacy win-back cohort scan).
      const sendContract = projects.filter((p) =>
        targetStateIds
          ? targetStateIds.has(String(p.stateId))
          : String(p.stateId) === center.sendContractStateId,
      );

      console.log(
        `[bmi-scan] ${center.clientKey}: ${projects.length} total, ${sendContract.length} in ${
          targetStateIds ? "target" : "send-contract"
        } state(s)`,
      );

      for (const proj of sendContract) {
        try {
          const projId = String(proj.id);

          // Pandora is the primary data source — enriched reservation with location, planner, customer, products
          const pandora = await fetchReservationDetail(center.centerCode, projId);

          // Resolve brand from Pandora location field
          let isFT = false;
          let centerName =
            center.centerCode === "naples" ? "HeadPinz Naples" : "HeadPinz Fort Myers";
          let hermesCenter = center.hermesCenter;

          if (center.centerCode === "fort-myers" || center.centerCode === "fasttrax") {
            const loc = (pandora?.location || "").toLowerCase();
            if (!loc) {
              console.warn(
                `[bmi-scan] FM project ${projId} missing location — defaulting to HeadPinz`,
              );
            }
            if (loc.includes("fasttrax")) {
              isFT = true;
              centerName = "FastTrax Fort Myers";
              hermesCenter = "10.48.0.14_FT";
            } else {
              // "HeadPinz..." or "Dual Location" → HeadPinz
              centerName = loc.includes("dual") ? "HeadPinz Fort Myers" : "HeadPinz Fort Myers";
              hermesCenter = "10.48.0.14";
            }
          }

          // Use Pandora data when available, fall back to BMI Office
          let products: HermesProduct[] = pandora?.products || [];
          if (products.length === 0) {
            try {
              const hermesCenterProducts = isFT ? "10.48.0.14" : center.hermesCenter;
              products = await fetchReservationProducts(hermesCenterProducts, projId);
            } catch {
              console.warn(`[bmi-scan] products fetch failed for ${projId}`);
              continue;
            }
          }

          // Customer: prefer Pandora, fall back to BMI Office person lookup
          let customer = pandora?.customer || null;
          if (!customer?.email) {
            const fullProject = await fetchProject(isFT ? "fasttrax" : center.centerCode, projId);
            if (fullProject) {
              try {
                const persons = await fetchPersonsByIds(isFT ? "fasttrax" : center.centerCode, [
                  String(fullProject.personId),
                ]);
                const p = persons[0];
                if (p) {
                  customer = {
                    email: p.email || "",
                    first: p.firstName || "",
                    last: p.lastName || "",
                    phone: p.phone || "",
                  };
                }
              } catch {
                /* non-fatal */
              }
            }
          }

          // Notes: prefer Pandora, fall back to BMI Office logs
          let notes = pandora?.event?.notes || "";
          if (!notes) {
            const fullProject = await fetchProject(isFT ? "fasttrax" : center.centerCode, projId);
            const logs = (fullProject?.logs || []) as Array<{ public: boolean; memo: string }>;
            notes = logs.find((l) => l.public)?.memo || "";
          }

          const totalBill = products.reduce((s, p) => s + p.total, 0);
          // p.tax is a per-line RATE (e.g. 0.065), so line tax = rate × line-total.
          // taxCents() returns cents; HermesQueueItem.tax is a dollar amount. Tax
          // exemption is applied downstream in the dispatch cron, so compute raw here.
          const taxTotal = taxCents(products, false) / 100;

          // BMI returns ET wall-clock without a tz; append the correct EDT/EST
          // offset for that date (not a hardcoded -04:00, which shifted winter
          // events an hour early). See lib/et-time.ts.
          const normalizedDate = normalizeEtDate(proj.date);

          const item: HermesQueueItem = {
            queueId: 0,
            logId: 0,
            center: hermesCenter,
            centerName,
            location: pandora?.location || undefined,
            subject: isFT ? `FT ${proj.name}` : proj.name,
            reservationId: projId,
            event: {
              name: pandora?.event?.name || proj.name || proj.displayName || "",
              date: normalizedDate,
              dateRaw: normalizedDate,
              notes,
              number: pandora?.event?.number || proj.number || "",
            },
            customer: {
              email: customer?.email || "",
              first: customer?.first || "",
              last: customer?.last || "",
              phone: customer?.phone || "",
            },
            planner: {
              email: pandora?.planner?.email || "",
              first: pandora?.planner?.first || "",
              last: pandora?.planner?.last || "",
              phone: pandora?.planner?.phone || "",
            },
            products,
            payments: pandora?.payments || [],
            tax: taxTotal,
            totalBill,
            depositDue: 0,
          };

          items.push(item);
        } catch (err) {
          console.warn(`[bmi-scan] failed to build item for project ${proj.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`[bmi-scan] failed to scan ${center.clientKey}:`, err);
    }
  }

  return items;
}

/**
 * BMI dayPlanner state ids that represent a confirmed, deposit-paid legacy
 * event (discovered empirically — see scripts/inventory-legacy-winback.mjs
 * --states). `-3` = Confirmation (built-in), plus the per-center
 * "Confirmation + Waiver" workspace states.
 */
export const LEGACY_DEPOSIT_STATE_IDS = ["-3", "3274635", "1191926"];

/**
 * Scan BMI for legacy confirmed events (any of `stateIds`) and return enriched
 * HermesQueueItem objects WITH their prior `payments[]` (deposits). The caller
 * filters out post-pay / no-deposit / already-ingested and ingests the rest.
 */
export async function scanLegacyDepositCohort(
  stateIds: string[] = LEGACY_DEPOSIT_STATE_IDS,
): Promise<HermesQueueItem[]> {
  return scanForNewEvents(new Set(stateIds.map(String)));
}
