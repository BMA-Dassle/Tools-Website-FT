import { serializeWithRawIds } from "@ft/db";
import {
  getAuditLog,
  getContractVersions,
  getGfQuoteByReservationId,
  parseGiftCardIds,
} from "@/lib/group-function-db";
import { formatPaymentDetail, formatPaymentSummary } from "@/lib/portal-format";
import { fetchGiftCardFacts, fetchPaymentFacts, sq } from "~/features/cancellation/square-actions";
import {
  LOCATION_TO_CLIENT_KEY,
  SHARED_FM_LOCATIONS,
  LOCATION_NAMES,
  PORTAL_SEPARATOR,
} from "./constants";
import { isWaiverEvent, hasWaiverResourceKeyword } from "./logic";
import {
  officeGet,
  officePut,
  getMetadataLookups,
  getLiveReservations,
  getResourceIdsForLocation,
  fetchProjectRaw,
  fetchPersonProfiles,
  fetchPersonRaw,
  OFFICE_ID_FIELDS,
} from "./data/bmi-office";
import {
  getEventMetadataRow,
  getManualEventMetadataRow,
  upsertEventMetadataAi,
  upsertEventMetadataManual,
  getFoodOutTimeForProject,
  EMPTY_EVENT_METADATA,
} from "./data/event-metadata-db";
import { extractEventMetadata } from "./ai";
import type {
  Reservation,
  ReservationDetail,
  Person,
  ProjectLog,
  EventContract,
  ContractHistoryEntry,
  EventMetadata,
  SquareTimelineNode,
  WebsitePaymentInfo,
} from "./types";

/**
 * Daily Events service — behavioral port of the employee portal's
 * api/integrations/sms-timing-reservations.ts and
 * sms-timing-reservation-detail.ts. The upstream call patterns are kept
 * exactly as the portal made them (owner directive: "we are not changing
 * any API calls — just moving UI").
 */

// ── Loose BMI payload shapes (the portal treated these as `any`) ─────

interface DpSchedule {
  projectId?: unknown;
  resourceId?: unknown;
  resourceName?: string;
  resource?: string;
  start?: string;
  stop?: string;
  [key: string]: unknown;
}

interface DpProject {
  id?: unknown;
  number?: unknown;
  name?: string;
  displayName?: string;
  personId?: unknown;
  persons?: number;
  date?: string;
  stateId?: unknown;
  kindId?: unknown;
  userId?: unknown;
  validityDate?: string;
  [key: string]: unknown;
}

interface DpPerson {
  id?: unknown;
  personId?: unknown;
  firstName?: string;
  name?: string;
  [key: string]: unknown;
}

interface DayPlannerData {
  planning?: Array<{
    resourceId?: unknown;
    resourceName?: string;
    name?: string;
    capacity?: number;
    [key: string]: unknown;
  }>;
  projects?: unknown;
  reservations?: {
    projects?: DpProject[];
    projectSchedules?: DpSchedule[];
    persons?: DpPerson[];
  };
}

interface BmiProjectDetail {
  id?: unknown;
  number?: unknown;
  name?: string;
  displayName?: string;
  date?: string;
  when?: string;
  stateId?: unknown;
  kindId?: unknown;
  userId?: unknown;
  persons?: number;
  personId?: unknown;
  contactPersonId?: unknown;
  validityDate?: string;
  validUntil?: string;
  created?: string;
  creationDate?: string;
  schedules?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  payments?: Array<Record<string, unknown>>;
  projectPersons?: Array<{ personId?: unknown }>;
  logs?: Array<Record<string, unknown>>;
  projectLogs?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DailyEventsListResult {
  reservations: Reservation[];
  source: string;
  clientKey: string;
  _debug: {
    queriedResourceCount: number;
    queriedResourceIds: string[];
    totalMetadataResources: number;
    unmappedResourceCount: number;
  };
}

export function clientKeyForLocation(locationId: number): string | null {
  return LOCATION_TO_CLIENT_KEY[locationId] || null;
}

// ── List (port of sms-timing-reservations.ts) ────────────────────────

export async function listDailyEvents(
  locationId: number,
  date: string,
  includeAll?: boolean,
): Promise<DailyEventsListResult> {
  const clientKey = LOCATION_TO_CLIENT_KEY[locationId];
  if (!clientKey) throw new Error("SMS-Timing is not configured for this location");

  // Resource IDs for this location (constants-backed mapping — the portal
  // read the same values from its DB). includeAll=true queries ALL metadata
  // resources (debug mode, portal parity).
  let resourceIds: string[];
  if (includeAll) {
    const debugMeta = await getMetadataLookups(clientKey);
    resourceIds = Object.keys(debugMeta.resourceNames);
  } else {
    resourceIds = await getResourceIdsForLocation(clientKey, locationId);
  }
  if (resourceIds.length === 0) {
    return {
      reservations: [],
      source: "dayPlanner",
      clientKey,
      _debug: {
        queriedResourceCount: 0,
        queriedResourceIds: [],
        totalMetadataResources: 0,
        unmappedResourceCount: 0,
      },
    };
  }

  // Fetch dayPlanner and metadata in parallel (portal parity)
  const resourceParams = resourceIds.map((id) => `resourceIds=${id}`).join("&");
  const [dayPlannerData, meta] = await Promise.all([
    officeGet<DayPlannerData>(
      clientKey,
      `dayPlanner?${resourceParams}&from=${date}&till=${date}&showAll=true`,
    ),
    getMetadataLookups(clientKey),
  ]);

  // liveReservations for balance/responsible data
  const liveData = await getLiveReservations(clientKey, date, meta);

  // Multi-location detection: for shared FM servers, also query the OTHER
  // location to find reservations that appear at both (portal parity — same
  // second dayPlanner call).
  const otherLocationReservationIds = new Set<string>();
  if (SHARED_FM_LOCATIONS.includes(locationId)) {
    try {
      const otherLocId = locationId === 332160 ? 467486 : 332160;
      const otherResourceIds = await getResourceIdsForLocation(clientKey, otherLocId);
      if (otherResourceIds.length > 0) {
        const otherResourceParams = otherResourceIds.map((id) => `resourceIds=${id}`).join("&");
        const otherDayPlanner = await officeGet<DayPlannerData>(
          clientKey,
          `dayPlanner?${otherResourceParams}&from=${date}&till=${date}&showAll=true`,
        );
        // The portal read `otherDayPlanner?.projects` (kept below). We also
        // count projects with an actual SCHEDULE at the other location —
        // dayPlanner returns schedule-less projects regardless of the
        // resourceIds filter (that's why the phase-2 backfill exists), so
        // counting reservations.projects wholesale would DUAL-badge
        // single-location events that merely appear in both queries.
        const topLevel = otherDayPlanner?.projects;
        if (Array.isArray(topLevel)) {
          for (const p of topLevel as DpProject[]) {
            if (p && p.id !== undefined) otherLocationReservationIds.add(String(p.id));
          }
        } else if (topLevel && typeof topLevel === "object") {
          for (const projId of Object.keys(topLevel)) otherLocationReservationIds.add(projId);
        }
        const otherResourceIdSet = new Set(otherResourceIds);
        for (const sched of otherDayPlanner?.reservations?.projectSchedules || []) {
          if (
            sched.projectId !== undefined &&
            sched.resourceId !== undefined &&
            otherResourceIdSet.has(String(sched.resourceId))
          ) {
            otherLocationReservationIds.add(String(sched.projectId));
          }
        }
      }
    } catch (err) {
      console.warn(
        "[daily-events] Failed to check other location for multi-location detection:",
        err,
      );
    }
  }

  const liveMap = new Map<
    string,
    {
      balance: number;
      responsible: string;
      totalValue: number;
      payments: number;
      products: string | null;
    }
  >();
  for (const lr of liveData) {
    liveMap.set(String(lr.id), {
      balance: lr.balance ?? 0,
      responsible: lr.responsible || "",
      totalValue: lr.totalValue ?? 0,
      payments: lr.payments ?? 0,
      products: lr.products || null,
    });
  }

  // Extract resource names from dayPlanner planning data (supplements metadata)
  const planning = dayPlannerData.planning || [];
  for (const block of planning) {
    const rid = String(block.resourceId || "");
    const rname = block.resourceName || block.name || "";
    if (rid && rname && !meta.resourceNames[rid]) {
      meta.resourceNames[rid] = rname;
    }
  }

  // Resource capacity map from planning blocks (resourceId → max capacity)
  const resourceCapacityMap = new Map<string, number>();
  for (const block of planning) {
    const rid = String(block.resourceId || "");
    const cap = block.capacity;
    if (rid && typeof cap === "number" && cap > 0) {
      const existing = resourceCapacityMap.get(rid) || 0;
      if (cap > existing) resourceCapacityMap.set(rid, cap);
    }
  }

  const rawReservations = dayPlannerData.reservations || {};
  const projects = rawReservations.projects || [];
  const projectSchedules = rawReservations.projectSchedules || [];
  const persons = rawReservations.persons || [];

  const personMap = new Map<string, DpPerson>();
  for (const p of persons) {
    const key = p.id || p.personId;
    if (key) personMap.set(String(key), p);
  }

  const schedulesByProject = new Map<string, DpSchedule[]>();
  for (const sched of projectSchedules) {
    const pid = String(sched.projectId);
    if (!schedulesByProject.has(pid)) schedulesByProject.set(pid, []);
    schedulesByProject.get(pid)!.push(sched);
  }

  // Normalize projects into Reservation shape (portal lines 188-277, verbatim)
  const reservations: Reservation[] = projects.map((proj) => {
    const projId = String(proj.id);
    const schedules = schedulesByProject.get(projId) || [];
    const firstSchedule = schedules[0];

    const person = proj.personId ? personMap.get(String(proj.personId)) : null;
    const personName = person ? `${person.firstName || ""} ${person.name || ""}`.trim() : "";

    const resourceId = firstSchedule?.resourceId ? String(firstSchedule.resourceId) : undefined;
    const resourceName = resourceId
      ? meta.resourceNames[resourceId] ||
        firstSchedule?.resourceName ||
        firstSchedule?.resource ||
        `Resource ${resourceId}`
      : "";

    const stateName = meta.stateNames[String(proj.stateId)] || "";
    const kindId = String(proj.kindId || "");
    const kindName = meta.kindNames[kindId] || "";
    const responsibleName = meta.userNames[String(proj.userId)] || "";

    const live = liveMap.get(projId);
    const balance = live?.balance ?? 0;
    const responsible = live?.responsible || responsibleName || "";

    const allResourceNames: string[] = [];
    for (const sched of schedules) {
      const rid = String(sched.resourceId || "");
      const rName = rid
        ? meta.resourceNames[rid] || sched.resourceName || sched.resource || ""
        : "";
      if (rName) allResourceNames.push(rName);
    }

    let capacity: number | undefined;
    for (const sched of schedules) {
      const rid = String(sched.resourceId || "");
      const resCap = resourceCapacityMap.get(rid);
      if (resCap) {
        capacity = (capacity || 0) + resCap;
      }
    }

    let isMultiLocation = false;
    let otherLocationName: string | undefined;
    if (otherLocationReservationIds.has(projId)) {
      isMultiLocation = true;
      const otherLocId = locationId === 332160 ? 467486 : 332160;
      otherLocationName = LOCATION_NAMES[otherLocId] || "Other Location";
    }

    return {
      id: projId,
      number: proj.number ? String(proj.number) : projId,
      kindId,
      kind: kindName || "",
      name: proj.name || proj.displayName || "",
      personName,
      personId: proj.personId ? String(proj.personId) : undefined,
      persons: proj.persons || 0,
      capacity,
      when: proj.date || firstSchedule?.start || "",
      stop: firstSchedule?.stop || "",
      state: stateName || "",
      stateId:
        proj.stateId !== undefined && proj.stateId !== null ? String(proj.stateId) : undefined,
      responsible,
      balance,
      validUntil: proj.validityDate || "",
      resourceId,
      resourceName,
      allResourceNames,
      products: live?.products || null,
      _isDayPlannerBlock: false,
      isMultiLocation,
      otherLocationName,
    };
  });

  // Registered person counts for waiver events (portal phases 1+2, verbatim —
  // unbounded parallel project GETs, exactly as the portal fires them).
  const knownWaiverEvents = reservations.filter(isWaiverEvent);
  const unknownEvents = reservations.filter(
    (r) =>
      !isWaiverEvent(r) && (!Array.isArray(r.allResourceNames) || r.allResourceNames.length === 0),
  );

  const allToFetch = [...knownWaiverEvents, ...unknownEvents];
  if (allToFetch.length > 0) {
    const details = await Promise.all(
      allToFetch.map(async (r) => {
        try {
          const detail = await fetchProjectRaw<BmiProjectDetail>(clientKey, r.id);
          const scheduleNames = (detail.schedules || [])
            .map((s) => {
              const rid = String(s.resourceId || "");
              return (
                meta.resourceNames[rid] ||
                (s.resourceName as string) ||
                (s.resource as string) ||
                ""
              );
            })
            .filter(Boolean);
          return {
            id: r.id,
            registeredCount: (detail.projectPersons || []).length,
            scheduleResourceNames: scheduleNames,
          };
        } catch {
          return { id: r.id, registeredCount: 0, scheduleResourceNames: [] as string[] };
        }
      }),
    );

    for (const d of details) {
      const r = reservations.find((res) => res.id === d.id);
      if (!r) continue;

      if (
        (!Array.isArray(r.allResourceNames) || r.allResourceNames.length === 0) &&
        d.scheduleResourceNames.length > 0
      ) {
        r.allResourceNames = d.scheduleResourceNames;
      }

      const isWaiver = isWaiverEvent(r) || hasWaiverResourceKeyword(d.scheduleResourceNames);
      if (isWaiver) {
        r.registeredPersons = d.registeredCount;
      }
    }
  }

  reservations.sort((a, b) => a.when.localeCompare(b.when));

  const allMetaResourceIds = Object.keys(meta.resourceNames);

  return {
    reservations,
    source: "dayPlanner",
    clientKey,
    _debug: {
      queriedResourceCount: resourceIds.length,
      queriedResourceIds: resourceIds,
      totalMetadataResources: allMetaResourceIds.length,
      unmappedResourceCount: allMetaResourceIds.length - resourceIds.length,
    },
  };
}

// ── Detail (port of sms-timing-reservation-detail.ts) ────────────────

export async function getReservationDetail(
  locationId: number,
  projectId: string,
): Promise<ReservationDetail> {
  const clientKey = LOCATION_TO_CLIENT_KEY[locationId];
  if (!clientKey) throw new Error("SMS-Timing is not configured for this location");

  const [project, meta] = await Promise.all([
    fetchProjectRaw<BmiProjectDetail>(clientKey, projectId),
    getMetadataLookups(clientKey),
  ]);

  const schedules = (project.schedules || []).map((s) => ({
    ...s,
    resourceName:
      meta.resourceNames[String(s.resourceId)] ||
      (s.resourceName as string) ||
      (s.resource as string) ||
      `Resource ${s.resourceId}`,
  }));

  // productId→name map from schedule productLines (fallback, portal parity)
  const scheduleProductNames: Record<string, string> = {};
  for (const sched of project.schedules || []) {
    const ids = (sched.productIds as string[] | undefined) || [];
    const lines = (sched.productLines as string | undefined) || "";
    if (ids.length === 1 && lines) {
      scheduleProductNames[String(ids[0])] = lines;
    } else if (ids.length > 0 && lines) {
      for (const pid of ids) {
        if (!scheduleProductNames[String(pid)]) {
          scheduleProductNames[String(pid)] = lines;
        }
      }
    }
  }

  const products = (project.products || []).map((p) => {
    const masterName = meta.productNames[String(p.productId)] || "";
    const scheduleName = scheduleProductNames[String(p.productId)] || "";
    const lineName = ((p.name as string) || (p.productName as string) || "").trim();
    const originalName = masterName || scheduleName || `Product ${p.productId}`;
    const hasOverride = !!lineName && lineName !== masterName && lineName !== scheduleName;
    return {
      ...p,
      productName: originalName,
      nameOverride: hasOverride ? lineName : undefined,
    };
  });

  const payments = (project.payments || []).map((pay) => ({
    ...pay,
    payMethodName:
      meta.payMethodNames[String(pay.payMethodId)] ||
      (pay.payMethodName as string) ||
      `Method ${pay.payMethodId}`,
  }));

  const totalProducts = (project.products || []).reduce(
    (sum: number, p) => sum + (typeof p.totalPrice === "number" ? p.totalPrice : 0),
    0,
  );
  const totalPayments = (project.payments || []).reduce(
    (sum: number, p) => sum + (typeof p.amount === "number" ? p.amount : 0),
    0,
  );
  const balance = totalProducts - totalPayments;

  const stateName = meta.stateNames[String(project.stateId)] || "";
  const kindName = meta.kindNames[String(project.kindId)] || "";
  const responsibleName = meta.userNames[String(project.userId)] || "";

  // Person profiles (portal parity: POST personsByIds, failure → [])
  let personsList: Person[] = [];
  const personIds = (project.projectPersons || [])
    .map((pp) => (pp.personId !== undefined && pp.personId !== null ? String(pp.personId) : ""))
    .filter(Boolean);

  if (personIds.length > 0) {
    try {
      const profiles = await fetchPersonProfiles<Person[]>(clientKey, personIds);
      personsList = Array.isArray(profiles) ? profiles : [];
    } catch {
      // Person lookup failed, continue without
    }
  }

  // Contact person — personId (main contact) first, contactPersonId fallback
  let contactPerson: Record<string, unknown> | null = null;
  const contactPersonId = project.personId || project.contactPersonId;
  if (contactPersonId) {
    try {
      contactPerson = await fetchPersonRaw(clientKey, String(contactPersonId));
    } catch {
      try {
        const profiles = await fetchPersonProfiles<Record<string, unknown>[]>(clientKey, [
          String(contactPersonId),
        ]);
        if (Array.isArray(profiles) && profiles.length > 0) contactPerson = profiles[0];
      } catch {
        // Both lookups failed
      }
    }
  } else if (personIds.length > 0) {
    try {
      contactPerson = await fetchPersonRaw(clientKey, personIds[0]);
    } catch {
      // Fallback failed
    }
  }

  // Normalize log entries to safe strings (portal parity)
  const rawLogs = project.logs || project.projectLogs || [];
  const logs: ProjectLog[] = rawLogs.map((log) => ({
    id: String(log.id || ""),
    memo: typeof log.memo === "string" ? log.memo : typeof log.text === "string" ? log.text : "",
    action:
      typeof log.action === "string"
        ? log.action
        : typeof log.action === "number"
          ? String(log.action)
          : "",
    updated:
      typeof log.updated === "string"
        ? log.updated
        : typeof log.date === "string"
          ? log.date
          : typeof log.dateModified === "string"
            ? log.dateModified
            : "",
    updatedBy:
      typeof log.updatedBy === "string"
        ? log.updatedBy
        : typeof log.userName === "string"
          ? log.userName
          : typeof log.user === "string"
            ? log.user
            : "",
    isPublic: Boolean(log.public ?? log.isPublic ?? false),
  }));

  // Sanitize contactPerson addresses (portal parity)
  let safeContactPerson: Person | null = null;
  if (contactPerson) {
    const rawAddresses = (contactPerson.addresses as Array<Record<string, unknown>>) || [];
    const safeAddresses = rawAddresses.map((addr) => ({
      email: typeof addr.email === "string" ? addr.email : "",
      mobile: typeof addr.mobile === "string" ? addr.mobile : "",
      phone: typeof addr.phone === "string" ? addr.phone : "",
      city:
        typeof addr.city === "string"
          ? addr.city
          : addr.city && typeof addr.city === "object" && (addr.city as { name?: string }).name
            ? String((addr.city as { name?: string }).name)
            : "",
    }));
    safeContactPerson = {
      id: String(contactPerson.id || ""),
      firstName: String(contactPerson.firstName || ""),
      name: String(contactPerson.name || ""),
      addresses: safeAddresses,
    };
  }

  // Website-native contract info (replaces the portal's PandaDoc section)
  const contract = await getContractForProject(String(project.id));

  return {
    id: String(project.id),
    number: project.number ? String(project.number) : undefined,
    name: String(project.name || project.displayName || ""),
    when: project.date || project.when || "",
    state: stateName,
    kind: kindName,
    persons: project.persons,
    responsible: responsibleName || "",
    validUntil: project.validityDate || project.validUntil || "",
    creationDate: project.created || project.creationDate || "",
    balance,
    schedules: schedules as unknown as ReservationDetail["schedules"],
    products: products as unknown as ReservationDetail["products"],
    payments: payments as unknown as ReservationDetail["payments"],
    persons_list: personsList,
    contactPerson: safeContactPerson,
    logs,
    contract,
  };
}

async function getContractForProject(projectId: string): Promise<EventContract | null> {
  try {
    const quote = await getGfQuoteByReservationId(projectId);
    if (!quote) return null;
    const shortId = quote.contract_short_id || null;
    return {
      shortId,
      status: quote.contract_status || null,
      quoteStatus: quote.status,
      signedPdfUrl: quote.signed_pdf_url || null,
      contractUrl: shortId ? `/contract/${shortId}` : null,
      payUrl: shortId ? `/contract/${shortId}/pay` : null,
      balancePaymentLinkUrl: quote.balance_payment_link_url || null,
      sentAt: quote.contract_sent_at || null,
      signedAt: quote.contract_signed_at || null,
      guestName: `${quote.guest_first_name || ""} ${quote.guest_last_name || ""}`.trim() || null,
      guestEmail: quote.guest_email || null,
    };
  } catch (err) {
    console.warn("[daily-events] contract lookup failed:", err);
    return null;
  }
}

// ── Contract history (audit log + versions + pdf archive + milestones) ──

/** Audit events humanized for the timeline. Unknown keys fall back to Title Case. */
const AUDIT_EVENT_LABELS: Record<string, string> = {
  page_view: "Guest viewed contract",
  balance_pay_view: "Guest viewed balance payment page",
  signed: "Contract signed",
  resigned: "Contract re-signed",
  reprice_charged: "Re-price difference charged",
  reprice_charge_failed: "Re-price charge FAILED",
  reprice_refund_owed: "Re-price refund owed to guest",
  postpaid_approved: "Postpaid request approved",
  postpaid_denied: "Postpaid request denied",
  dayof_order_reconciled: "Day-of order reconciled",
  cancelled_from_bmi: "Cancelled (reservation removed in BMI)",
  square_settled_completed: "Closed — paid directly in Square",
  dayof_order_cancelled: "Website day-of order cancelled (superseded by POS check)",
  winback_incentive_issued: "Win-back incentive issued",
  legacy_winback_ingested: "Legacy win-back ingested",
  pdf_generated: "Signed PDF generated",
  pdf_generation_failed: "Signed PDF generation failed",
  "7day_waiver_sent": "7-day waiver reminder sent",
  "96hr_reminder_sent": "96-hour balance reminder sent",
  "re-signed": "Contract re-signed",
};

function humanizeAuditEvent(event: string): string {
  if (AUDIT_EVENT_LABELS[event]) return AUDIT_EVENT_LABELS[event];
  // Reminder-cron idempotency gates: "rem_<rule>[:n]" → "Reminder sent — <rule>"
  if (event.startsWith("rem_")) {
    return `Reminder sent — ${event.slice(4).replace(/:\d+$/, "").replace(/_/g, " ")}`;
  }
  const words = event.replace(/[_:]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pull a short human detail line out of an audit entry's metadata. */
function auditDetail(metadata: Record<string, unknown>): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const parts: string[] = [];
  if (typeof metadata.reason === "string" && metadata.reason) parts.push(metadata.reason);
  if (typeof metadata.error === "string" && metadata.error) parts.push(metadata.error);
  if (typeof metadata.signatureType === "string" && metadata.signatureType) {
    parts.push(`signature: ${metadata.signatureType}`);
  }
  if (typeof metadata.amountCents === "number") {
    parts.push(`$${(metadata.amountCents / 100).toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Neon returns TIMESTAMPTZ columns as Date objects (typed string) — normalize. */
function isoStamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : "";
}

export async function getContractHistory(projectId: string): Promise<ContractHistoryEntry[]> {
  const quote = await getGfQuoteByReservationId(projectId);
  if (!quote) return [];

  const [auditLog, versions] = await Promise.all([
    getAuditLog(quote.id).catch(() => []),
    getContractVersions(quote.id).catch(() => []),
  ]);

  const entries: ContractHistoryEntry[] = [];

  // Audit trail (immutable ledger — signs, views, charges, approvals, reminders)
  for (const a of auditLog) {
    entries.push({
      at: isoStamp(a.created_at),
      kind: a.event,
      label: humanizeAuditEvent(a.event),
      detail: auditDetail(a.metadata),
      actor: a.actor_email || null,
    });
  }

  // Contract versions (v1 = initial terms; later = revisions with field diffs)
  const auditKinds = new Set(auditLog.map((a) => a.event));
  for (const v of versions) {
    entries.push({
      at: isoStamp(v.created_at),
      kind: "version",
      label:
        v.version_number === 1
          ? "Contract created (v1)"
          : `Contract revised (v${v.version_number})`,
      detail: v.changes && v.changes.length > 0 ? v.changes.join("; ") : null,
    });
  }

  // Archived signed PDFs (each re-sign banks the prior signed copy)
  const pdfHistory = (quote.signed_pdf_history ?? []) as Array<{
    url?: string;
    signedAt?: string | null;
    archivedAt?: string;
    reason?: string;
  }>;
  for (const p of pdfHistory) {
    if (!p.archivedAt) continue;
    entries.push({
      at: isoStamp(p.archivedAt),
      kind: "pdf_archived",
      label: "Prior signed contract archived (superseded by a re-sign)",
      detail: p.reason || null,
      pdfUrl: p.url || null,
    });
  }

  // Quote milestones NOT covered by the audit ledger (the row is their record)
  const milestone = (at: string | null, kind: string, label: string, detail?: string | null) => {
    const stamp = isoStamp(at);
    if (stamp)
      entries.push({ at: stamp, kind: `milestone:${kind}`, label, detail: detail ?? null });
  };
  milestone(quote.created_at, "created", "Quote created");
  milestone(quote.contract_sent_at, "sent", `Contract sent to ${quote.guest_email || "guest"}`);
  // "signed" milestone only when the audit ledger missed it (pre-ledger rows)
  if (!auditKinds.has("signed") && !auditKinds.has("resigned")) {
    milestone(quote.contract_signed_at, "signed", "Contract signed");
  }
  milestone(quote.deposit_paid_at, "deposit_paid", "Deposit paid");
  milestone(quote.balance_link_sent_at, "balance_link_sent", "Balance payment link sent");
  milestone(quote.balance_paid_at, "balance_paid", "Balance paid");
  milestone(
    quote.balance_declined_at,
    "balance_declined",
    "Balance charge declined",
    [quote.balance_decline_code, quote.balance_decline_message].filter(Boolean).join(" — ") || null,
  );
  milestone(quote.dayof_paid_at, "dayof_paid", "Day-of charges settled");

  // Attach the exact PDF each signing produced (owner 2026-07-13): archived
  // copies pair with earlier signings in chronological order; the quote's
  // current signed_pdf_url is the latest signing. Zip from the end so the
  // newest signing always gets the current PDF even if an old archive entry
  // is missing.
  const SIGN_KINDS = new Set(["signed", "resigned", "re-signed", "milestone:signed"]);
  const signEvents = entries
    .filter((e) => SIGN_KINDS.has(e.kind))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const pdfTs = (p: { signedAt?: string | null; archivedAt?: string }) => {
    const t = Date.parse(isoStamp(p.signedAt ?? p.archivedAt ?? null));
    return Number.isNaN(t) ? 0 : t;
  };
  const signedPdfs = pdfHistory
    .filter((p) => p.url)
    .sort((a, b) => pdfTs(a) - pdfTs(b))
    .map((p) => p.url as string);
  if (quote.signed_pdf_url) signedPdfs.push(quote.signed_pdf_url);
  for (let i = 0; i < signEvents.length; i++) {
    const ev = signEvents[signEvents.length - 1 - i];
    const url = signedPdfs[signedPdfs.length - 1 - i];
    if (ev && url && !ev.pdfUrl) ev.pdfUrl = url;
  }

  // Chronological, then collapse consecutive guest views on the same day.
  // Date.parse, not string compare — column formats differ across sources.
  const ts = (e: ContractHistoryEntry) => {
    const t = Date.parse(e.at);
    return Number.isNaN(t) ? 0 : t;
  };
  entries.sort((a, b) => ts(a) - ts(b));
  const collapsed: ContractHistoryEntry[] = [];
  for (const e of entries) {
    const prev = collapsed[collapsed.length - 1];
    const isView = e.kind === "page_view" || e.kind === "balance_pay_view";
    if (prev && isView && prev.kind === e.kind && prev.at.slice(0, 10) === e.at.slice(0, 10)) {
      prev.count = (prev.count || 1) + 1;
      prev.at = e.at; // keep the latest view time of the run
    } else {
      collapsed.push({ ...e });
    }
  }
  return collapsed;
}

// ── Live Square timeline (Payments tab — reservations-admin idiom) ───
//
// Same node shape and fetchers as the reservations board's payment timeline
// (features/cancellation/square-actions), keyed on the quote's Square ids:
// deposit order → funding gift card (live balance) → balance order →
// day-of / settled orders. Each node fails independently.

interface SquareOrderPayload {
  id: string;
  state?: string;
  total_money?: { amount?: number };
  net_amount_due_money?: { amount?: number };
  tenders?: Array<{ payment_id?: string; amount_money?: { amount?: number } }>;
  line_items?: Array<{
    name?: string;
    variation_name?: string;
    quantity?: string;
    total_money?: { amount?: number };
  }>;
  service_charges?: Array<{ name?: string; total_money?: { amount?: number } }>;
}

async function squareOrderNode(
  kind: SquareTimelineNode["kind"],
  label: string,
  orderId: string,
  withPayments: boolean,
): Promise<SquareTimelineNode> {
  try {
    // Own order read (not fetchOrderFacts) — the timeline also shows the
    // order CONTENTS, which the cancellation-cascade fact reader drops.
    const r = await sq("GET", `/orders/${orderId}`);
    if (!r.ok || !r.json?.order) {
      throw new Error(`order fetch failed (${r.status})`);
    }
    const o = r.json.order as SquareOrderPayload;

    const lineItems = (o.line_items ?? []).map((li) => ({
      name: [li.name, li.variation_name].filter(Boolean).join(" — ") || "Item",
      qty: li.quantity ?? "1",
      totalCents: li.total_money?.amount ?? 0,
    }));
    for (const sc of o.service_charges ?? []) {
      lineItems.push({
        name: sc.name || "Service charge",
        qty: "",
        totalCents: sc.total_money?.amount ?? 0,
      });
    }

    let tenders: NonNullable<SquareTimelineNode["order"]>["tenders"] = (o.tenders ?? [])
      .map((t) => ({ paymentId: t.payment_id ?? "", amountCents: t.amount_money?.amount ?? 0 }))
      .filter((t) => t.paymentId);
    if (withPayments) {
      tenders = await Promise.all(
        tenders.map(async (t) => {
          try {
            const p = await fetchPaymentFacts(t.paymentId);
            return { ...t, status: p.status, refundedCents: p.refundedCents };
          } catch {
            return t;
          }
        }),
      );
    }

    return {
      kind,
      label,
      order: {
        id: o.id,
        state: o.state ?? "?",
        totalCents: o.total_money?.amount ?? 0,
        netDueCents: o.net_amount_due_money?.amount ?? 0,
        lineItems,
        tenders,
      },
    };
  } catch (err) {
    return { kind, label, error: err instanceof Error ? err.message : "order fetch failed" };
  }
}

export async function getSquareTimeline(projectId: string): Promise<SquareTimelineNode[]> {
  const quote = await getGfQuoteByReservationId(projectId);
  if (!quote) return [];

  const tasks: Promise<SquareTimelineNode>[] = [];
  const seenOrders = new Set<string>();
  const order = (
    kind: SquareTimelineNode["kind"],
    label: string,
    id: string | null,
    withPayments = false,
  ) => {
    if (!id || seenOrders.has(id)) return;
    seenOrders.add(id);
    tasks.push(squareOrderNode(kind, label, id, withPayments));
  };

  order("deposit", "Deposit charge", quote.square_deposit_order_id, true);

  // square_gift_card_id can be a bare id or a JSON array (multi-card quotes)
  const giftCardIds = parseGiftCardIds(quote.square_gift_card_id);
  giftCardIds.forEach((gcId, idx) => {
    const label =
      giftCardIds.length > 1
        ? `Funding gift card ${idx + 1} of ${giftCardIds.length} (deposit loaded here, redeemed day-of)`
        : "Funding gift card (deposit loaded here, redeemed day-of)";
    tasks.push(
      (async (): Promise<SquareTimelineNode> => {
        try {
          const gc = await fetchGiftCardFacts(gcId);
          return {
            kind: "funding_gift_card",
            label,
            giftCard: { id: gc.id, gan: gc.gan, state: gc.state, balanceCents: gc.balanceCents },
          };
        } catch (err) {
          return {
            kind: "funding_gift_card",
            label,
            error: err instanceof Error ? err.message : "gift card fetch failed",
          };
        }
      })(),
    );
  });

  order("balance", "Balance charge", quote.square_balance_order_id, true);
  order("dayof_order", "Day-of order", quote.square_dayof_order_id);
  order("settled_order", "Settled order (paid directly in Square)", quote.square_settled_order_id);

  return Promise.all(tasks);
}

// ── Website payments (replaces the portal→website /api/portal/payments hop) ──
//
// The UI keys its payment map by projectId (group_function_quotes stores the
// BMI projectId in bmi_reservation_id — the portal translated its short codes
// to the same ids via its sales_prospects table before calling us).

// ── POS settlement pickup for QUOTE-LESS events ─────────────────────
//
// Pure PandaDoc/BMI events (no group_function_quotes row) are invisible to
// the group-square-settled-close cron — found live 2026-07-13 on event 3253:
// staff rang a proper "BMI 3253" check at the POS and nothing on our side
// noticed. The detail modal asks here directly instead.

/** BMI location → Square location candidates. FM events can be rung at
 *  either FM POS (HeadPinz or FastTrax), so both are searched in order. */
const BMI_TO_SQUARE_LOCATIONS: Record<number, string[]> = {
  332160: ["TXBSQN0FEKQ11", "LAB52GY480CJF"],
  467486: ["LAB52GY480CJF", "TXBSQN0FEKQ11"],
  332145: ["PPTR5G2N0QXF7"],
};

export interface PosSettlement {
  orderId: string;
  ticketName: string;
  totalCents: number | null;
  createdAt: string | null;
  squareLocationId: string;
}

/** Find a COMPLETED "BMI <event#>" POS check near the event date. */
export async function getPosSettlementCheck(opts: {
  eventNumber: string;
  eventISO: string;
  bmiLocationId: number;
}): Promise<PosSettlement | null> {
  const eventMs = Date.parse(opts.eventISO);
  if (Number.isNaN(eventMs)) return null;
  const { findSettlementCheck } = await import("@/lib/square-settled-check");
  const candidates = BMI_TO_SQUARE_LOCATIONS[opts.bmiLocationId] ?? [];
  for (const locationId of candidates) {
    const check = await findSettlementCheck({
      locationId,
      eventNumber: opts.eventNumber,
      eventMs,
    });
    if (check) return { ...check, squareLocationId: locationId };
  }
  return null;
}

/** Single-code lookup with the richer detail shape (payment entries, link, attempts). */
export async function getPaymentDetailByCode(code: string): Promise<WebsitePaymentInfo | null> {
  try {
    const quote = await getGfQuoteByReservationId(code);
    if (!quote) return null;
    return formatPaymentDetail(quote) as unknown as WebsitePaymentInfo;
  } catch {
    return null;
  }
}

export async function getPaymentsBulkByCodes(
  codes: string[],
): Promise<Record<string, WebsitePaymentInfo>> {
  const results: Record<string, WebsitePaymentInfo> = {};
  await Promise.all(
    codes.map(async (code) => {
      try {
        const quote = await getGfQuoteByReservationId(code);
        if (quote) results[code] = formatPaymentSummary(quote) as unknown as WebsitePaymentInfo;
      } catch {
        // per-code failure degrades silently (portal parity)
      }
    }),
  );
  return results;
}

// ── Event metadata (port of api/integrations/event-metadata.ts) ──────

export async function getEventMetadata(
  projectId: string,
  locationId: number,
  date: string,
): Promise<EventMetadata> {
  const row = await getEventMetadataRow(projectId, locationId, date);
  return row ?? EMPTY_EVENT_METADATA;
}

export async function extractFoodOut(params: {
  projectId: string;
  locationId: number;
  date: string;
  eventName: string;
  startTime: string;
  persons: number;
  notes: string;
}): Promise<{ data: EventMetadata; cached: boolean }> {
  // If manually set, don't overwrite — return the manual value (portal parity)
  const manual = await getManualEventMetadataRow(params.projectId, params.locationId, params.date);
  if (manual) {
    return { data: manual, cached: true };
  }

  const result = await extractEventMetadata({
    eventName: params.eventName,
    startTime: params.startTime,
    persons: params.persons,
    notes: params.notes,
  });

  console.log(
    `[daily-events] AI extraction for project ${params.projectId}: foodOutTime=${result.foodOutTime}, confidence=${result.confidence}`,
  );

  await upsertEventMetadataAi({
    projectId: params.projectId,
    locationId: params.locationId,
    date: params.date,
    foodOutTime: result.foodOutTime,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });

  // Fire-and-forget BMI sync (portal parity)
  syncBmiNotes(params.projectId, params.locationId).catch((e) =>
    console.error("[daily-events] BMI sync after AI extraction failed:", e),
  );

  return {
    data: {
      foodOutTime: result.foodOutTime,
      foodOutSource: "ai",
      foodOutConfidence: result.confidence,
      foodOutReasoning: result.reasoning,
      metadata: {},
      updatedAt: new Date().toISOString(),
    },
    cached: false,
  };
}

export async function saveManualFoodOut(params: {
  projectId: string;
  locationId: number;
  date: string;
  foodOutTime: string | null;
}): Promise<EventMetadata> {
  const timeVal = params.foodOutTime || null;
  await upsertEventMetadataManual({
    projectId: params.projectId,
    locationId: params.locationId,
    date: params.date,
    foodOutTime: timeVal,
  });

  syncBmiNotes(params.projectId, params.locationId).catch((e) =>
    console.error("[daily-events] BMI sync after manual food out update failed:", e),
  );

  return {
    foodOutTime: timeVal,
    foodOutSource: "manual",
    foodOutConfidence: "high",
    foodOutReasoning: null,
    metadata: {},
    updatedAt: new Date().toISOString(),
  };
}

// ── BMI private-note sync (port of api/labor/sync-bmi-notes.ts) ──────
//
// Party assignments were dropped (owner decision), so the synced section
// carries only the food-out line — or "(No staff assigned)", the exact
// string the portal wrote when it had nothing to report.

export async function syncBmiNotes(
  projectId: string,
  locationId: number,
): Promise<{ success: boolean; message?: string }> {
  const clientKey = LOCATION_TO_CLIENT_KEY[locationId];
  if (!clientKey) return { success: false, message: "Unknown location" };

  const foodOutTime = await getFoodOutTimeForProject(projectId, locationId);

  const lines: string[] = [];
  if (foodOutTime) {
    lines.push(`Food Out: ${foodOutTime}`);
  }
  const portalSection = lines.length > 0 ? lines.join("\n") : "(No staff assigned)";

  // Fetch existing project detail to get log entries. Never write when the
  // read failed — a blind write could wipe operator notes.
  const projectDetail = await fetchProjectRaw<BmiProjectDetail>(clientKey, projectId);
  const logs = projectDetail.logs || [];

  // Find the private log (kind === 1, public === false) — `kind` is not an
  // id field, so it survives parsing as a number (portal parity).
  const privateLog = logs.find((l) => l.public === false && l.kind === 1);

  if (privateLog) {
    const fullMemo = (privateLog.memo as string) || "";

    // Strip the old Portal Staff section (replace-section, portal parity) —
    // but PRESERVE the website's own "── FastTrax Web ──" audit section if
    // it was appended AFTER the separator (appendProjectPrivateNote appends
    // at the memo end, so it can land there; the portal's writer blindly
    // truncated it away — a destructive interaction we must not reproduce
    // now that both writers live in this codebase).
    let existingMemo = fullMemo;
    let preservedTail = "";
    const sepIdx = fullMemo.indexOf(PORTAL_SEPARATOR);
    if (sepIdx !== -1) {
      existingMemo = fullMemo.substring(0, sepIdx);
      const afterSep = fullMemo.substring(sepIdx + PORTAL_SEPARATOR.length);
      const ftIdx = afterSep.indexOf("── FastTrax Web ──");
      if (ftIdx !== -1) {
        preservedTail = "\n\n" + afterSep.substring(ftIdx).trimEnd();
      }
    }

    const newMemo = existingMemo.trimEnd() + PORTAL_SEPARATOR + portalSection + preservedTail;

    // PUT projectLog with the full log object (the portal's exact call).
    // serializeWithRawIds re-emits the parsed string ids as raw numeric
    // tokens so the body is byte-faithful to what the GET returned.
    await officePut(
      clientKey,
      "projectLog",
      serializeWithRawIds(
        {
          ...privateLog,
          memo: newMemo,
          updated: new Date().toISOString().replace("Z", ""),
        },
        OFFICE_ID_FIELDS,
      ),
    );

    return { success: true, message: "Synced to BMI" };
  }

  return { success: true, message: "No private log found — create a note in BMI first" };
}
