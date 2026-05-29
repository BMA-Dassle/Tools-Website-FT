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

import { fetchProject, fetchPersonsByIds, type PersonInfo } from "@/lib/bmi-office-actions";
import {
  fetchReservationProducts,
  HERMES_CENTER_MAP,
  type CenterInfo,
  type HermesQueueItem,
  type HermesProduct,
} from "@/lib/hermes-client";

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
  newDepositStateIds: Record<string, string>;
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

const CENTERS: CenterConfig[] = [
  {
    clientKey: "headpinzftmyers",
    centerCode: "fort-myers",
    hermesCenter: "10.48.0.14",
    newDepositStateIds: {
      "48952154": "HPFM",
      "48952156": "FT",
    },
  },
  {
    clientKey: "headpinznaples",
    centerCode: "naples",
    hermesCenter: "10.40.0.43",
    newDepositStateIds: {
      "8007473": "NAPLES",
    },
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
    req.setTimeout(30_000, () => {
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
  personId: string;
  persons: number;
  date: string;
}

/**
 * Scan BMI for events in "New Deposit Requested" states.
 * Returns HermesQueueItem-compatible objects ready for processQueueItem.
 */
export async function scanForNewEvents(): Promise<HermesQueueItem[]> {
  const items: HermesQueueItem[] = [];
  const fromDate = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

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

      // Fetch all projects
      const dpRes = await httpsRequest(
        "GET",
        `/api/${center.clientKey}/dayPlanner?${resourceParam}&from=${fromDate}&till=${toDate}&showAll=true`,
        headers,
      );
      if (dpRes.status >= 400) continue;
      const dp = JSON.parse(dpRes.body);
      const projects = (dp.reservations?.projects || []) as BmiProject[];

      // Filter to new deposit requested states
      const newDeposit = projects.filter((p) => center.newDepositStateIds[String(p.stateId)]);

      console.log(
        `[bmi-scan] ${center.clientKey}: ${projects.length} total, ${newDeposit.length} in new-deposit state`,
      );

      for (const proj of newDeposit) {
        try {
          const brand = center.newDepositStateIds[String(proj.stateId)];
          const isFT = brand === "FT";
          const hermesCenter = isFT ? "10.48.0.14_FT" : center.hermesCenter;
          const hermesCenterProducts = isFT ? "10.48.0.14" : center.hermesCenter;

          // Fetch full project for customer/planner details + notes
          const fullProject = await fetchProject(
            isFT ? "fasttrax" : center.centerCode,
            String(proj.id),
          );
          if (!fullProject) continue;

          // Fetch products from Hermes
          let products: HermesProduct[] = [];
          try {
            products = await fetchReservationProducts(hermesCenterProducts, String(proj.id));
          } catch {
            console.warn(`[bmi-scan] products fetch failed for ${proj.id}`);
            continue;
          }

          // Get customer info
          const customerPersonId = fullProject.personId as string;
          let customer: PersonInfo | null = null;
          try {
            const persons = await fetchPersonsByIds(isFT ? "fasttrax" : center.centerCode, [
              customerPersonId,
            ]);
            customer = persons[0] || null;
          } catch {
            /* non-fatal */
          }

          // Extract notes from public log
          const logs = (fullProject.logs || []) as Array<{
            public: boolean;
            memo: string;
          }>;
          const publicLog = logs.find((l) => l.public);
          const notes = publicLog?.memo || "";

          // Calculate totals from products
          const totalBill = products.reduce((s, p) => s + p.total, 0);
          const taxTotal = products.reduce(
            (s, p) => s + ((p.tax || 0) * p.total) / (p.price || 1),
            0,
          );

          // Resolve center info
          const centerInfo = HERMES_CENTER_MAP[hermesCenter];
          const centerName = isFT
            ? "FastTrax Fort Myers"
            : center.centerCode === "naples"
              ? "HeadPinz Naples"
              : "HeadPinz Fort Myers";

          const item: HermesQueueItem = {
            queueId: 0,
            logId: 0,
            center: hermesCenter,
            centerName,
            subject: isFT ? `FT ${proj.name}` : proj.name,
            reservationId: String(proj.id),
            event: {
              name: proj.name || proj.displayName || "",
              date:
                proj.date.includes("-04:00") || proj.date.includes("Z")
                  ? proj.date
                  : `${proj.date}-04:00`,
              dateRaw:
                proj.date.includes("-04:00") || proj.date.includes("Z")
                  ? proj.date
                  : `${proj.date}-04:00`,
              notes,
              number: proj.number || "",
            },
            customer: {
              email: customer?.email || "",
              first: customer?.firstName || "",
              last: customer?.lastName || "",
              phone: customer?.phone || "",
            },
            planner: {
              email: "",
              first: "",
              last: "",
              phone: "",
            },
            products,
            payments: [],
            tax: taxTotal,
            totalBill,
            depositDue: 0,
          };

          // Resolve planner from BMI project userId
          // For now, planner info comes through later via the Hermes center mapping
          // The dispatch cron handles planner resolution separately

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
