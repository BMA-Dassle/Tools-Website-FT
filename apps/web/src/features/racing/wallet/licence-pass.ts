/**
 * FastTrax Racing Licence — the Apple/Google Wallet pass, server side.
 *
 * The MEMBER (multi-use) half of the wallet programme. Its sibling,
 * `game-cards/wallet/voucher-pass.ts`, drives the single-use coupon family, and
 * the two differ in the way that matters most:
 *
 *   voucher   billed ONCE at issuance   → issue lazily, on the guest's tap
 *   licence   billed EVERY MONTH it exists (~$0.045)
 *
 * So a licence is opt-in and never bulk-issued, and `updateLicencePass` below is
 * FREE no matter how often it runs — pass updates and API calls are included in
 * the platform fee. That asymmetry is the whole reason this design works: a
 * per-heat e-ticket would be a fresh single-use charge every race, whereas
 * rewriting "next race" onto a licence someone already holds costs nothing.
 *
 * ── Rules inherited from the voucher mirror, all load-bearing ────────────────
 *
 * 1. A SYNC FAILURE IS NEVER A CALLER FAILURE. Every export swallows its own
 *    errors. BMI and Neon hold the truth; the pass is a rendering of it. A
 *    racer must never miss a check-in because PassKit was slow.
 * 2. NEVER READ THE PASS TO DECIDE ANYTHING. It is write-only from our side.
 *    What we last pushed lives in `racer_wallet_passes`, not on the guest's
 *    phone — a second copy of state on a device we don't control is not a
 *    source of truth.
 * 3. NO PASS, NO CALL. Skip on a missing row rather than asking PassKit whether
 *    one exists. Almost no racer holds a licence, and the check-in cron runs
 *    every minute.
 * 4. PUSH ONLY REAL CHANGES. Apple raises a lock-screen alert only when a value
 *    changes, so re-sending the same string is silent — but still a wasted call
 *    per racer per minute.
 */
import { passkit, passUrls, isPassKitConfigured, PassKitError } from "~/lib/api/passkit";
import { PASSKIT_LICENCE } from "~/config/passkit";
import {
  getRacerPass,
  getRacerPasses,
  markPushed,
  recordRacerPass,
  saveMeta,
} from "~/features/racing/data/racer-wallet-db";

/** Emergency off switch, shared with the voucher sync. Kill switch only — a
 *  merged feature is ON, so this defaults on and is never set in normal life. */
export function licencePassEnabled(): boolean {
  return process.env.PASSKIT_SYNC !== "false" && isPassKitConfigured();
}

export type LicenceRefusal = "disabled" | "no-pass" | "error";

export interface LicenceIssueResult {
  ok: boolean;
  refusal?: LicenceRefusal;
  memberId?: string;
  urls?: { apple: string; google: string; landing: string };
}

interface MemberResponse {
  id?: string;
}

/** Metadata the template renders. Keys are referenced as `${meta.x}` in the
 *  pass design, so RENAMING ONE SILENTLY BLANKS A FIELD on every issued pass —
 *  `scripts/passkit-licence-pass.mts` is the other half of this contract. */
export interface LicenceMeta {
  code: string;
  memberName: string;
  memberQr: string;
  licenceUrl: string;
  tier?: string;
  validUntil?: string;
  races?: string;
  nextRace?: string;
  checkinStatus?: string;
}

/**
 * Create the racer's pass, or recover the one they already have.
 *
 * A duplicate `externalId` answers 409 — verified live for members, not just
 * coupons — which is what makes this idempotent. That matters far more here
 * than for a voucher: a second member record is a RECURRING charge, not a
 * one-off, so a guest double-tapping "Add to Wallet" must never mint one.
 */
export async function issueLicencePass(args: {
  personId: string;
  meta: LicenceMeta;
}): Promise<LicenceIssueResult> {
  if (!licencePassEnabled()) return { ok: false, refusal: "disabled" };
  const personId = String(args.personId || "").trim();
  if (!/^\d+$/.test(personId)) return { ok: false, refusal: "error" };

  try {
    let memberId = "";
    try {
      const created = await passkit<MemberResponse>("POST", "/members/member", {
        programId: PASSKIT_LICENCE.programId,
        tierId: PASSKIT_LICENCE.tierId,
        // personId, never a login code: a racer holds many codes and one identity.
        externalId: personId,
        person: { displayName: args.meta.memberName },
        metaData: args.meta,
      });
      memberId = String(created?.id ?? "");
    } catch (err) {
      if (!(err instanceof PassKitError) || !err.isDuplicate) throw err;
      const existing = await passkit<MemberResponse>(
        "GET",
        `/members/member/externalId/${PASSKIT_LICENCE.programId}/${personId}`,
      );
      memberId = String(existing?.id ?? "");
      if (!memberId) throw err;
      // A re-tap is also a free self-heal: push current state onto the pass
      // they already hold rather than leaving it stale.
      await passkit("PUT", "/members/member", { id: memberId, metaData: args.meta }).catch(
        () => undefined,
      );
    }
    if (!memberId) return { ok: false, refusal: "error" };

    await recordRacerPass({ personId, memberId, loginCode: args.meta.code });
    // Full metaData, so later partial updates have a complete base to build on.
    await saveMeta(personId, args.meta as unknown as Record<string, string>);
    await markPushed(personId, {
      ...(args.meta.nextRace !== undefined ? { nextRace: args.meta.nextRace } : {}),
      ...(args.meta.checkinStatus !== undefined
        ? { checkinStatus: args.meta.checkinStatus }
        : {}),
    });
    return { ok: true, memberId, urls: passUrls(memberId) };
  } catch (err) {
    console.warn(
      `[licence-pass] issue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, refusal: "error" };
  }
}

/**
 * Write live fields onto one racer's pass. Silent no-op when they hold no pass
 * or nothing actually changed.
 *
 * The lock-screen alert the racer sees is the field's `changeMessage` in the
 * template — there is NO REST endpoint for an arbitrary push (five spellings
 * probed, all 404/501; free-text messages are gRPC or portal only). So the
 * value IS the notification, which is why these strings read as sentences.
 */
export async function updateLicencePass(
  personId: string,
  patch: { nextRace?: string; checkinStatus?: string },
): Promise<boolean> {
  if (!licencePassEnabled()) return false;
  const row = await getRacerPass(personId);
  if (!row) return false; // rule 3 — no pass, no call

  const changed: { nextRace?: string; checkinStatus?: string } = {};
  if (patch.nextRace !== undefined && patch.nextRace !== row.nextRace) {
    changed.nextRace = patch.nextRace;
  }
  if (patch.checkinStatus !== undefined && patch.checkinStatus !== row.checkinStatus) {
    changed.checkinStatus = patch.checkinStatus;
  }
  if (Object.keys(changed).length === 0) return false; // rule 4 — nothing to say

  // SEND THE COMPLETE metaData, ALWAYS.
  //
  // PUT /members/member REPLACES metaData rather than merging it — the opposite
  // of PUT /template. Sending only the changed keys deleted every other field,
  // including the one the barcode is built from, and left a live pass reading
  // "missing: meta.code" that would not scan. This happened TWICE on 2026-08-05:
  // once from the original bug, and once because the fix was reverted by a
  // commit built in a worktree branched off a stale origin/main.
  //
  // With no stored copy we must NOT push — a partial write here IS that bug.
  // Skipping costs a stale field; guessing costs the barcode.
  if (!row.meta) {
    console.warn(
      `[licence-pass] no stored meta for ${personId} — skipping rather than writing a partial pass`,
    );
    return false;
  }
  const full = { ...row.meta, ...changed };

  try {
    await passkit("PUT", "/members/member", { id: row.memberId, metaData: full });
    await markPushed(personId, changed);
    await saveMeta(personId, full);
    return true;
  } catch (err) {
    // Rule 1. The racer is standing at a desk; a stale pass is survivable, a
    // thrown cron is not. It self-heals on the next real change.
    console.warn(
      `[licence-pass] update failed for ${personId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Same, for a whole heat. ONE Neon query decides who holds a pass, then only
 * those racers cost a PassKit call — which is what keeps a per-minute cron from
 * fanning out across an entire roster to learn that nobody has one.
 */
export async function updateLicencePasses(
  entries: Array<{
    personId: string | number;
    nextRace?: string;
    checkinStatus?: string;
    /** Which heat the field refers to — recorded for the clear-down. */
    checkinSessionId?: string;
    nextRaceSessionId?: string;
  }>,
): Promise<number> {
  if (!licencePassEnabled() || entries.length === 0) return 0;
  const holders = await getRacerPasses(entries.map((e) => e.personId));
  if (holders.size === 0) return 0;

  let pushed = 0;
  for (const e of entries) {
    const pid = String(e.personId ?? "").trim();
    if (!holders.has(pid)) continue;
    const ok = await updateLicencePass(pid, {
      ...(e.nextRace !== undefined ? { nextRace: e.nextRace } : {}),
      ...(e.checkinStatus !== undefined ? { checkinStatus: e.checkinStatus } : {}),
    });
    if (ok) {
      // Only stamp when the push actually happened — recording a session for a
      // field we did not write would let the clear-down blank something else.
      await markPushed(pid, {
        ...(e.checkinSessionId !== undefined && e.checkinStatus !== undefined
          ? { checkinSessionId: e.checkinSessionId }
          : {}),
        ...(e.nextRaceSessionId !== undefined && e.nextRace !== undefined
          ? { nextRaceSessionId: e.nextRaceSessionId }
          : {}),
      });
      pushed++;
    }
  }
  return pushed;
}
