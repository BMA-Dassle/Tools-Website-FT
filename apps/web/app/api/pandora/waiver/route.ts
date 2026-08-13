import { NextRequest, NextResponse } from "next/server";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { logWaiverSignAttempt, type WaiverSignOutcome } from "@/lib/waiver-sign-log";
import { storeWaiverSignature, settleWaiverSignature } from "@/lib/waiver-signature-store";
import { signLicenceGrant } from "~/features/racing/wallet/licence-grant";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/**
 * This route deliberately BLOCKS on cross-rail sync (the local-visibility poll
 * below) and then runs a 3-attempt retry ladder, so it needs a stated ceiling.
 * Vercel's implicit default (10-15s by plan) is shorter than the work: an
 * invocation killed mid-poll never reaches the enqueue, which loses the owed
 * push AND fails the guest — the one outcome the queue exists to prevent.
 * 60s is the 15s poll + the diagnosis probe + the 3-attempt ladder + the salvage
 * reads, with headroom for a slow Pandora on any one of them. Matches the ceiling
 * the sync-queue cron already declares.
 */
export const maxDuration = 60;

function resolveLocation(key: string | null): string {
  return (key && PANDORA_LOCATION_MAP[key]) || PANDORA_DEFAULT_LOCATION_ID;
}

/**
 * GET  ?age=25&location=headpinz  → Fetch age-appropriate waiver template
 * POST { personID, waiverContentID, signature (base64 PNG), location?, invalidationDate? }
 *      → Sign waiver
 */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const age = searchParams.get("age");
  const locKey = searchParams.get("location");
  const locationID = resolveLocation(locKey);

  if (!age) {
    return NextResponse.json({ error: "age required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/waiver/search?locationID=${locationID}&age=${age}`,
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[pandora-waiver] search failed ${res.status}: ${text.substring(0, 200)}`);
      return NextResponse.json({ error: "Waiver template not found" }, { status: res.status });
    }

    const raw = await res.json();

    // Pandora wraps: { success: true, data: { id, contentID, name, duration, body } }
    const template = raw?.data ?? raw;

    if (!template || !template.contentID) {
      console.error(`[pandora-waiver] unexpected shape:`, JSON.stringify(raw).substring(0, 300));
      return NextResponse.json({ error: "No waiver template found" }, { status: 404 });
    }

    // Pass through — Pandora field names match our PandoraWaiverTemplate type.
    // `duration` is in YEARS (BMI semantics; all locations return 1).
    const normalized = {
      id: String(template.id || ""),
      contentID: String(template.contentID),
      name: template.name || "",
      duration: template.duration ?? 1,
      body: template.body || "",
    };

    console.log(
      `[pandora-waiver] template "${normalized.name}" contentID=${normalized.contentID} bodyLen=${normalized.body.length}`,
    );
    return NextResponse.json(normalized);
  } catch (err) {
    console.error("[pandora-waiver] search error:", err);
    return NextResponse.json({ error: "Failed to fetch waiver" }, { status: 500 });
  }
}

/** Is this person's waiver valid RIGHT NOW? Salvage probe for the sign retry
 *  loop below — a Pandora write-then-500 (or a concurrent sign) shows up here
 *  as a future waiverExpiry, which is the business outcome we actually need. */
async function waiverNowValid(locationID: string, personID: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationID}/${personID}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" },
    );
    const data = await res.json();
    if (!res.ok || !data?.data) {
      // This is the post-sign confirmation read, so an unreadable record makes
      // a waiver that DID land look like it failed. A null birthdate 500s this
      // endpoint — and the guest who just signed is exactly the person whose
      // birthdate may still be missing. False is the safe answer; silence is not.
      console.warn(
        `[pandora-waiver] person ${personID} UNREADABLE (HTTP ${res.status}) — ` +
          `cannot confirm the signature landed; a null birthdate causes this`,
      );
      return false;
    }
    const expiry = data.data.waiverExpiry ? new Date(data.data.waiverExpiry) : null;
    return !!expiry && !Number.isNaN(expiry.getTime()) && expiry > new Date();
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      personID,
      waiverContentID,
      signature,
      location,
      invalidationDate,
      sigPersonID,
      // Display label for the licence offer on the "you're all set" card. Only
      // ever a label — the grant below is what carries authority.
      firstName,
      // Kiosk 99 only (the client sets it from `isTestKiosk`). When set, every
      // response carries `debug: string[]` — this route's own narration — so the
      // on-glass console can show the half of the story the browser cannot see:
      // barrier verdicts, which path was taken, what Pandora actually answered.
      debug,
    } = body;

    /**
     * Server-side trace for the kiosk debug console. Costs nothing when unasked.
     *
     * Convention (see `kioskDebugServerTrace`): a leading "!" marks a problem and
     * "+" a success, so the server colours its own lines without inventing a
     * schema. Never put a signature, key, or card detail in here — it crosses the
     * wire to a screen on the shop floor.
     */
    const wantDebug = debug === true;
    const t0 = Date.now();
    const dbg: string[] = [];
    const trace = (line: string) => {
      if (wantDebug) dbg.push(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
    };
    /** Attach the trace to any response body, so no return path forgets it. */
    const withDbg = <T extends Record<string, unknown>>(payload: T) =>
      wantDebug ? { ...payload, debug: dbg } : payload;

    /**
     * THIS is the only place a waiver licence grant may be minted, because it is
     * the only place that knows Pandora accepted the signature. Every success
     * return below carries one; nothing else in the codebase calls
     * `signLicenceGrant`.
     *
     * Handing the grant back to the browser is what lets the finished waiver
     * card offer a racing licence with no booking to hang off — see
     * licence-grant.ts for why a client-supplied list of personIds could not do
     * the same job.
     */
    const grant = () => signLicenceGrant(String(personID), String(firstName ?? ""));

    if (!personID || !waiverContentID || !signature) {
      return NextResponse.json(
        { error: "personID, waiverContentID, and signature required" },
        { status: 400 },
      );
    }

    // Naples has its OWN Pandora location (PPTR5G2N0QXF7). resolveLocation()
    // silently falls back to HeadPinz Fort Myers for anything it doesn't know, so
    // a typo'd or renamed key would record a Naples guest's waiver at the wrong
    // center — the 2026-07-20 misroute class, and worse here than for a booking
    // because a waiver filed at the wrong location isn't valid where they play.
    // An UNKNOWN key is a bug, not a default: refuse it loudly.
    if (location && !PANDORA_LOCATION_MAP[String(location)]) {
      console.error(
        `[pandora-waiver] REFUSING sign — unknown location "${location}" (known: ${Object.keys(
          PANDORA_LOCATION_MAP,
        ).join(", ")}). Would have defaulted to ${PANDORA_DEFAULT_LOCATION_ID}.`,
      );
      return NextResponse.json({ error: `Unknown waiver location "${location}"` }, { status: 400 });
    }
    if (!location) {
      console.warn(
        `[pandora-waiver] no location sent — defaulting to ${PANDORA_DEFAULT_LOCATION_ID} (HeadPinz Fort Myers). A Naples guest signed here would be filed at the wrong center.`,
      );
    }
    const locationID = resolveLocation(location || null);

    // Convert base64 PNG signature to a Buffer for multipart upload
    const sigBase64 = signature.replace(/^data:image\/png;base64,/, "");
    const sigBuffer = Buffer.from(sigBase64, "base64");

    // Every log line carries the full sign context — the 2026-07-18 kiosk
    // failures were undiagnosable because errors logged neither WHO was being
    // signed nor with what (owner: "maybe add logging to this?").
    const meta = `person=${personID} signer=${sigPersonID || personID} content=${waiverContentID} loc=${locationID} sig=${sigBuffer.length}B`;

    // Build multipart/form-data body manually
    const boundary = `----PandoraWaiver${Date.now()}`;
    const parts: Buffer[] = [];

    function addField(name: string, value: string) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }

    addField("locationID", locationID);
    addField("personID", personID);
    addField("waiverContentID", waiverContentID);
    // Signer defaults to the person themselves; a guardian signing a minor's
    // waiver passes their own (SHORT Pandora) id here instead.
    addField("sigPersonID", sigPersonID || personID);
    // NEVER send an empty invalidationDate. Pandora answers a blank one with a
    // bare 400 "Validation Exception" — proven by probe 2026-07-30: the identical
    // payload failed without it and returned waiverID 56906749 with it. The
    // browser always computes one from the template duration, so this only bites
    // a caller that forgets (a script, a retry, a future server-side signer) and
    // the failure gives no hint why. Fall back to a year out rather than blank.
    const safeInvalidation =
      typeof invalidationDate === "string" && invalidationDate.trim()
        ? invalidationDate.trim()
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    addField("invalidationDate", safeInvalidation);
    // Appended so every sign log line carries the value actually SENT, including
    // when it was defaulted — the old line logged "default" and hid the blank.
    const signMeta = `${meta} invalidation=${safeInvalidation}${
      invalidationDate ? "" : " (DEFAULTED — caller sent none)"
    }`;

    // Signature file part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(sigBuffer);
    parts.push(Buffer.from("\r\n"));

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const multipartBody = Buffer.concat(parts);

    // ── SAVE THE SIGNATURE FIRST ────────────────────────────────────────────
    // Before Pandora is called at all. BMI has been the only holder of the
    // image, and it hands back no way to read one — so a signature that BMI
    // silently drops was, until now, gone: unprovable and un-re-pushable.
    // Awaited so the capture genuinely precedes the send; its errors are
    // swallowed inside, so a DB outage still cannot cost a guest their waiver.
    // (owner 2026-08-08, W57821. CLAUDE.md § persist guest input at capture.)
    trace(
      `signing person ${personID}${
        String(sigPersonID || personID) === String(personID)
          ? " (self-sign)"
          : ` — signer is ${sigPersonID} (guardian)`
      }, template ${waiverContentID}, expires ${safeInvalidation}`,
    );

    const signatureRowId = await storeWaiverSignature({
      personId: String(personID),
      signerPersonId: String(sigPersonID || personID),
      waiverContentId: String(waiverContentID),
      locationId: locationID,
      invalidationDate: safeInvalidation,
      signatureBase64: sigBase64,
      signatureBytes: sigBuffer.length,
    });

    // Durable, per-guest, queryable record of EVERY outcome — the thing
    // console.log could not give us. Awaited (not fire-and-forget) so a failed
    // sign cannot return to the guest before its row exists; the write swallows
    // its own errors, so it can still never cost anyone a signature.
    const logSignOutcome = async (
      outcome: WaiverSignOutcome,
      attempts: number,
      waiverId: string | null,
      err: { status: number; message: string } | null,
    ) => {
      // Stamp the stored image with what Pandora ultimately said, so the saved
      // signature and the outcome are one queryable fact rather than two.
      await settleWaiverSignature(signatureRowId, outcome, waiverId);
      return logWaiverSignAttempt({
        personId: String(personID),
        signerPersonId: String(sigPersonID || personID),
        waiverContentId: String(waiverContentID),
        locationId: locationID,
        invalidationDate: safeInvalidation,
        invalidationDefaulted: !invalidationDate,
        signatureBytes: sigBuffer.length,
        attempts,
        outcome,
        waiverId,
        httpStatus: err?.status ?? null,
        upstreamMessage: err?.message ?? null,
        ipAddress:
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          req.headers.get("x-real-ip") ||
          null,
        userAgent: req.headers.get("user-agent"),
      });
    };

    /**
     * EVERY id this Pandora write will name — `personID` (whose waiver) plus
     * `sigPersonID` (who signed) when a guardian is signing for a minor. Both
     * the pre-sign wait and both queue enqueues barrier on this same list, so
     * there is exactly one definition of "who has to be local first".
     */
    const signerId = String(sigPersonID || personID);
    const needLocal = [String(personID), signerId];
    const who = signerId === String(personID) ? `${personID}` : `${personID}+signer ${signerId}`;

    /**
     * Hand the push off. Vercel Queues FIRST (delayed visibility + push delivery
     * gets BMI caught up in ~20-30s instead of the cron's 1-4 minutes), with the
     * Neon `bmi_sync_queue` as the fallback — so a Queues outage, a missing
     * entitlement, or `WAIVER_QUEUE_VERCEL=false` all degrade to the transport
     * that has been working, rather than to a failed waiver.
     *
     * Returns a label for the log/trace only. Either way the signature is already
     * durable in Neon, which is what makes falling back safe.
     */
    const handOffPush = async (): Promise<string> => {
      // A Queues message carries only the signature ROW ID, so it is unusable
      // without one. `storeWaiverSignature` returns null when the Neon write
      // failed (it swallows its own errors so a DB outage can never cost a guest
      // their waiver) — in that case the Neon queue is the only viable transport,
      // because its payload carries the PNG inline.
      if (signatureRowId != null) {
        const { sendWaiverPush } = await import("~/features/kiosk/waiver/waiver-queue");
        const messageId = await sendWaiverPush({
          signatureRowId,
          personId: String(personID),
          signerPersonId: signerId,
          locationId: locationID,
          name: String(firstName ?? "").trim() || "Guest",
        });
        if (messageId) {
          // Stamp the transport so the admin board can still SEE this push — a
          // Queues message has no bmi_sync_queue row to be seen through
          // (owner 2026-08-13: "can these still show up on admin board").
          const { setWaiverPushTransport } = await import("@/lib/waiver-signature-store");
          await setWaiverPushTransport(signatureRowId, "vercel-queue");
          return `vercel-queue ${messageId}`;
        }
      } else {
        console.warn(
          "[pandora-waiver] no Neon signature row id — Vercel Queues cannot carry this push; using the Neon queue, which holds the image inline.",
        );
      }

      const { enqueueSync } = await import("@/lib/bmi-sync-queue");
      const queued = await enqueueSync({
        kind: "push-waiver-signature",
        idempotencyKey: `waiver-push:${personID}:${new Date().toISOString().slice(0, 10)}`,
        barrier: "persons-local",
        barrierRef: String(personID),
        locationId: locationID,
        payload: {
          personId: String(personID),
          personIds: needLocal,
          signerPersonId: signerId,
          name: String(firstName ?? "").trim() || "Guest",
          locationKey: location ?? null,
          signaturePngB64: sigBase64,
          waiverContentId: String(waiverContentID),
          invalidationDate: safeInvalidation,
        },
      });
      if (signatureRowId != null) {
        const { setWaiverPushTransport } = await import("@/lib/waiver-signature-store");
        await setWaiverPushTransport(signatureRowId, "neon-cron");
      }
      return `neon-queue row ${queued?.id ?? "n/a"}`;
    };

    /**
     * DO NOT WAIT FOR CLOUD→LOCAL SYNC. Probe once and move on.
     *
     * This used to poll for up to 24s (then 15s) so the waiver could be filed with
     * BMI while the guest stood there. It worked, and it was the wrong trade: the
     * guest paid the entire sync latency on the glass for a vendor record that
     * nobody is waiting on (owner 2026-08-13, on the wait: "honestly don't like how
     * long it takes for waiver to submit").
     *
     * What makes it safe to stop waiting:
     *   - The signature is already durable in Neon, written above, before any
     *     vendor call. That is the record that matters.
     *   - `hasUnexpiredCapturedWaiver` means every consumer of "does this person
     *     have a waiver" now counts that row, so a guest is never asked to sign
     *     twice during the gap.
     *   - Vercel Queues delivers the push ~20-30s later and retries on a closed
     *     barrier in seconds, so the vendor record is owed for well under a minute.
     *
     * ONE probe, WITHOUT the cross-center diagnosis. That search costs two extra
     * Pandora GETs on a 404 and its only purpose is to distinguish "never going to
     * sync" from "not yet" — a distinction that no longer changes anything HERE,
     * because either way we hand off and return. The CONSUMER pays for it instead,
     * where the guest is not waiting: it settles an `impossible` row as failed so
     * it surfaces in the owed list rather than retrying for a day.
     *
     * `!== "open"` deliberately covers `error` as well as `closed`. If we cannot
     * even read the local server, firing the sign ladder at it would just generate
     * the 500 bursts this whole path exists to avoid.
     */
    {
      const { personsLocalBarrier } = await import("@/lib/bmi-sync-barriers");
      const barrier = await personsLocalBarrier(locationID, needLocal, {
        diagnoseElsewhere: false,
      });
      trace(
        `signature saved to Neon. local-server check for ${who}: ${barrier.verdict} — ${barrier.detail}`,
      );

      if (barrier.verdict !== "open") {
        const where = await handOffPush();
        console.log(
          `[pandora-waiver] ${who} not local yet (${barrier.detail}) — push handed to ${where}. Signature is safe in Neon; guest is done.`,
        );
        await logSignOutcome("queued", 0, null, null);
        trace(`+ handed to ${where}. Guest is done; BMI catches up in ~20-30s.`);
        return NextResponse.json(
          withDbg({
            ok: true,
            waiverID: null,
            queuedForSync: true,
            licenceGrant: grant(),
          }),
        );
      }
      trace(`both people already local — signing with BMI inline`);
    }

    // Pandora (Azure App Service) throws transient 5xx "Unexpected Error
    // Occured" bursts — the same pathology every OTHER Pandora call here
    // already retries (pandoraCreatePerson 3x, getWithRetry, the state -3
    // confirm 3x). Sign was the one unretried call: kiosk guests saw the raw
    // error on the signature screen and "it worked the second time" (owner
    // 2026-07-18 — five 500s in the 00:50–00:55Z window; a live probe minutes
    // later signed the same person + fresh persons 4/4, confirming transient).
    // Retry server-side; before each retry AND after final failure, probe
    // whether the waiver actually landed (a write-then-500 leaves a valid
    // waiver behind) and salvage instead of failing the guest.
    let lastError: { status: number; message: string } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt - 1)));
        if (await waiverNowValid(locationID, personID)) {
          console.log(
            `[pandora-waiver] salvaged — waiver already valid after failed attempt(s) (${signMeta})`,
          );
          await logSignOutcome("salvaged", attempt, null, lastError);
          trace(`+ salvaged — BMI already shows a valid waiver despite the error`);
          return NextResponse.json(
            withDbg({
              ok: true,
              waiverID: null,
              alreadyValid: true,
              licenceGrant: grant(),
            }),
          );
        }
      }

      let res: Response;
      try {
        res = await fetch(`${PANDORA_URL}/bmi/waiver`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
        });
      } catch (err) {
        lastError = { status: 502, message: "Pandora unreachable" };
        console.error(
          `[pandora-waiver] sign attempt ${attempt}/3 network error (${signMeta}):`,
          err,
        );
        continue;
      }

      const data = await res.json().catch(() => null);

      // Pandora wraps: { success, data: { waiverID } }. A 200 with success:false
      // or no waiverID is a NON-write — treat it as a failure, never a success.
      // (This is the bug that silently lost ~240 Health Net waivers on 2026-06-18.)
      const waiverID = data?.data?.waiverID || data?.waiverID;
      if (res.ok && data?.success !== false && waiverID) {
        console.log(
          `[pandora-waiver] signed waiver for person ${personID}: waiverID=${waiverID} (attempt ${attempt}/3, ${signMeta})`,
        );
        await logSignOutcome("signed", attempt, String(waiverID), {
          status: res.status,
          message: "",
        });
        trace(`+ BMI recorded it: waiverID ${waiverID} on attempt ${attempt}/3`);
        return NextResponse.json(withDbg({ ok: true, waiverID, licenceGrant: grant() }));
      }

      lastError = {
        status: res.ok ? 502 : res.status,
        message: data?.message || data?.data?.message || "Waiver signing failed",
      };
      console.error(
        `[pandora-waiver] sign attempt ${attempt}/3 failed status=${res.status} success=${data?.success} id=${waiverID ?? "none"} (${signMeta}):`,
        JSON.stringify(data).substring(0, 300),
      );

      // A real 4xx (bad person/template) won't improve with retries.
      if (!res.ok && res.status < 500) break;
    }

    // Final salvage: did one of the "failed" attempts actually write?
    if (await waiverNowValid(locationID, personID)) {
      console.log(`[pandora-waiver] salvaged after final attempt — waiver is valid (${signMeta})`);
      await logSignOutcome("salvaged", 3, null, lastError);
      trace(`+ salvaged after the last attempt — BMI shows a valid waiver`);
      return NextResponse.json(
        withDbg({
          ok: true,
          waiverID: null,
          alreadyValid: true,
          licenceGrant: grant(),
        }),
      );
    }

    /**
     * CLOUD-FIRST BACKSTOP (2026-08-12). Before giving up, work out WHY.
     *
     * Under cloud-first minting the person is created on the BMI cloud and is
     * not visible to the center's local server — which is the only thing
     * Pandora can write a waiver against — for ~13-32s. So a brand-new guest
     * signing immediately hits a sign that cannot possibly succeed yet. That is
     * not a lost waiver and must not be reported as one: the signature is
     * already durable in Neon (stored before the first vendor call), so the
     * honest move is to hand the push to the sync queue behind a `person-local`
     * barrier and tell the caller the waiver is accepted.
     *
     * `personsLocalBarrier` distinguishes the cases: a 404 on ANY named person
     * (the minor or the signing guardian) = genuinely not local yet (queue it),
     * anything else = they ARE there and the failure is a real vendor problem
     * (report it, exactly as before).
     */
    try {
      const { personsLocalBarrier } = await import("@/lib/bmi-sync-barriers");
      const barrier = await personsLocalBarrier(locationID, needLocal);
      if (barrier.verdict === "closed") {
        const where = await handOffPush();
        console.log(
          `[pandora-waiver] ${who} not local yet (${barrier.detail}) — push handed to ${where}. Signature is safe in Neon.`,
        );
        await logSignOutcome("queued", 3, null, lastError);
        trace(`+ handed to ${where} after the sign attempts failed.`);
        return NextResponse.json(
          withDbg({
            ok: true,
            waiverID: null,
            /** The vendor record is owed, not lost — Neon holds the signature and
             *  the sync queue completes the push within a tick or two. */
            queuedForSync: true,
            licenceGrant: grant(),
          }),
        );
      }
    } catch (err) {
      console.warn("[pandora-waiver] could not queue the waiver push:", err);
    }

    // The row that matters: the guest signed and has NO waiver.
    await logSignOutcome("failed", 3, null, lastError);
    trace(
      `! FAILED — ${lastError?.message ?? "unknown"} (HTTP ${lastError?.status ?? "?"}). Signature IS safe in Neon.`,
    );
    return NextResponse.json(withDbg({ error: lastError?.message || "Waiver signing failed" }), {
      status: lastError?.status || 502,
    });
  } catch (err) {
    console.error("[pandora-waiver] sign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Waiver signing failed" },
      { status: 500 },
    );
  }
}
