/**
 * Which racing licences are actually ON a phone — and deleting the ones that
 * are not, because every live record is billed every month.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A multi-use pass is re-billed for as long as it exists, and the 250-free
 * allowance is a STANDING CAP on live records rather than a monthly reset. So a
 * pass issued to a racer who never installed it, or installed and later swiped
 * it out of their wallet, is a line item forever in exchange for nothing.
 *
 * ── What PassKit actually tells us (measured 2026-08-06) ────────────────────
 * There are NO webhook endpoints on the REST API — every spelling 404s, the
 * same as free-text push messages, which are portal/gRPC only. What does work
 * is `passMetaData.status` on the member record:
 *
 *     PASS_ISSUED     created, never reached a device
 *     PASS_INSTALLED  on a phone   (lifecycleEvents gains INSTALLED_APPLE etc.)
 *
 * And `DELETE /members/member` with `{id}` in the BODY returns 200, after which
 * the record 404s — unlike a single-use coupon, which cannot be deleted at all
 * (501). So the meter really can be stopped; it just has to be polled rather
 * than pushed. `app/api/webhooks/passkit/route.ts` is the push half, ready for
 * the day the portal can point at it.
 *
 * ── The rule, and why it is conservative ────────────────────────────────────
 * Deleting a pass a racer still holds would break a live credential in their
 * wallet, so a delete only ever happens on a DEFINITE not-installed signal:
 *
 *   - never installed  → reap after GRACE_DAYS. They were offered it, tapped
 *                        nothing, and we have been paying since.
 *   - installed, then reported uninstalled/deleted → reap immediately. They
 *                        made the decision; we are just no longer paying for it.
 *   - PASS_INSTALLED   → never touched.
 *   - unreadable / unknown status → never touched. A PassKit blip must not cost
 *                        a racer their licence.
 */
import { passkit, isPassKitConfigured, PassKitError } from "~/lib/api/passkit";
import { PASSKIT_LICENCE } from "~/config/passkit";
import {
  getBillablePasses,
  recordPassStatus,
  markPassReaped,
} from "~/features/racing/data/racer-wallet-db";

/** How long an uninstalled pass is left alone before it is reaped. Long enough
 *  that a racer who adds it on the walk to their car is never caught. */
const GRACE_DAYS = 14;

/** Statuses that mean "this is on a device". Anything not listed is treated as
 *  UNKNOWN and left alone — the safe direction. */
const INSTALLED = new Set(["PASS_INSTALLED"]);

/** Statuses that mean the guest deliberately removed it. PassKit's exact
 *  wording for this is unconfirmed (we have never observed one), so several
 *  plausible spellings are matched and anything unrecognised is left alone. */
const REMOVED = new Set(["PASS_DELETED", "PASS_UNINSTALLED", "PASS_REMOVED", "DELETED"]);

export interface ReconcileStats {
  checked: number;
  installed: number;
  awaitingInstall: number;
  reaped: number;
  failed: number;
  /** Statuses we did not recognise — worth a log line, since a new PassKit
   *  value silently landing in here is how a reaper starts doing nothing. */
  unknown: string[];
}

interface MemberRecord {
  id?: string;
  passMetaData?: { status?: string; lifecycleEvents?: string[] };
}

/** Read the live install state for one member. Null when PassKit cannot tell
 *  us — which is NOT the same as "not installed". */
async function readStatus(personId: string): Promise<string | null> {
  try {
    const m = await passkit<MemberRecord>(
      "GET",
      `/members/member/externalId/${PASSKIT_LICENCE.programId}/${personId}`,
    );
    const status = m?.passMetaData?.status;
    return typeof status === "string" && status ? status : null;
  } catch (err) {
    // A 404 means the record is already gone — someone deleted it in the
    // portal, or a previous run reaped it and failed to write the row back.
    if (err instanceof PassKitError && err.isNotFound) return "GONE";
    return null;
  }
}

/** Stop the meter. Returns true when PassKit no longer holds the record. */
async function deleteMember(memberId: string): Promise<boolean> {
  try {
    // The id goes in the BODY. `DELETE /members/member/{id}` is a 404 — the
    // path-style call that every other resource uses does not exist here.
    await passkit("DELETE", "/members/member", { id: memberId });
    return true;
  } catch (err) {
    if (err instanceof PassKitError && err.isNotFound) return true; // already gone
    return false;
  }
}

/**
 * Poll every pass we are being billed for, record what PassKit says, and reap
 * the ones nobody is holding.
 *
 * `dryRun` reports what it WOULD delete without touching anything — the only
 * responsible way to run a reaper the first time against real guests' passes.
 */
export async function reconcileLicencePasses(
  opts: { dryRun?: boolean } = {},
): Promise<ReconcileStats> {
  const stats: ReconcileStats = {
    checked: 0,
    installed: 0,
    awaitingInstall: 0,
    reaped: 0,
    failed: 0,
    unknown: [],
  };
  if (!isPassKitConfigured()) return stats;

  const rows = await getBillablePasses();
  const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const row of rows) {
    stats.checked++;
    const status = await readStatus(row.personId);

    // Unknown means PassKit did not answer, not that the pass is gone.
    if (!status) {
      stats.failed++;
      continue;
    }

    if (status !== "GONE") await recordPassStatus(row.personId, status);

    if (INSTALLED.has(status)) {
      stats.installed++;
      continue;
    }

    // The record no longer exists upstream — reconcile our side so nothing
    // tries to push to it, but there is nothing to delete.
    if (status === "GONE") {
      await markPassReaped(row.personId);
      continue;
    }

    const removed = REMOVED.has(status);
    if (!removed && status !== "PASS_ISSUED") {
      // A status we have never seen. Leave it alone and surface it — a reaper
      // that silently ignores a new value is a reaper that has stopped working.
      if (!stats.unknown.includes(status)) stats.unknown.push(status);
      continue;
    }

    // Never installed: give them the grace window from when we issued it.
    if (!removed) {
      const age = row.createdAt ? now - row.createdAt.getTime() : 0;
      if (age < graceMs) {
        stats.awaitingInstall++;
        continue;
      }
    }

    if (opts.dryRun) {
      stats.reaped++;
      continue;
    }

    if (await deleteMember(row.memberId)) {
      await markPassReaped(row.personId);
      stats.reaped++;
    } else {
      stats.failed++;
    }
  }

  return stats;
}

/**
 * Apply a single event, for the webhook path. Same rules as the sweep, one
 * record — so push and poll can never disagree about what is safe to delete.
 */
export async function applyPassEvent(
  personId: string,
  status: string,
): Promise<{ recorded: boolean; reaped: boolean }> {
  const pid = String(personId || "").trim();
  if (!/^\d+$/.test(pid) || !status) return { recorded: false, reaped: false };

  await recordPassStatus(pid, status);
  if (!REMOVED.has(status)) return { recorded: true, reaped: false };

  // A removal is the guest's own decision, so there is no grace period — but we
  // still only act on the row we are actually billed for.
  const rows = await getBillablePasses();
  const row = rows.find((r) => r.personId === pid);
  if (!row) return { recorded: true, reaped: false };

  const ok = await deleteMember(row.memberId);
  if (ok) await markPassReaped(pid);
  return { recorded: true, reaped: ok };
}
