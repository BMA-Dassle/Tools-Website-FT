import { NextRequest, NextResponse } from "next/server";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { logWaiverSignAttempt, type WaiverSignOutcome } from "@/lib/waiver-sign-log";
import { storeWaiverSignature, settleWaiverSignature } from "@/lib/waiver-signature-store";
import { signLicenceGrant } from "~/features/racing/wallet/licence-grant";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

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
    } = body;

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
     * WAIT FOR THE PERSON TO REACH THE LOCAL SERVER, BEFORE SIGNING.
     *
     * Pandora writes a waiver against the CENTER'S OWN server, and under
     * cloud-first the person was just minted on the BMI cloud — invisible
     * locally for ~10-30s (measured). Signing inside that window cannot
     * succeed: Pandora answers a generic 500 "Unexpected Error Occured", the
     * retry ladder burns all three attempts on it, and the guest gets
     * "Waiver signing failed" on the signature screen. Seen live 2026-08-12 on
     * kiosk guest "Test 18": minted 09:32:56, signed 09:33:03, three 500s while
     * the person read 404 locally — then a manual retry at 09:33:10 succeeded
     * the moment sync caught up.
     *
     * Diagnosing this AFTER the attempts (the first version of this fix) is too
     * late: by then the person has usually appeared, the barrier reads "open",
     * and the failure looks like a real vendor fault. So the wait belongs here,
     * in front. The guest is already watching a spinner, and a few seconds of it
     * is strictly better than an error they have to retry by hand.
     *
     * Bounded so the request can never hang: poll to WAIT_MS, then hand the push
     * to the sync queue and tell the caller the waiver is accepted — the
     * signature is already durable in Neon (stored before any vendor call).
     */
    {
      const WAIT_MS = 24_000;
      const STEP_MS = 2_000;
      const { personLocalBarrier } = await import("@/lib/bmi-sync-barriers");
      const startedWait = Date.now();
      let verdict = (await personLocalBarrier(locationID, personID)).verdict;
      if (verdict === "closed") {
        console.log(
          `[pandora-waiver] person ${personID} not on the local server yet — waiting up to ${WAIT_MS / 1000}s before signing`,
        );
        while (verdict === "closed" && Date.now() - startedWait < WAIT_MS) {
          await new Promise((r) => setTimeout(r, STEP_MS));
          verdict = (await personLocalBarrier(locationID, personID)).verdict;
        }
        const waited = ((Date.now() - startedWait) / 1000).toFixed(1);
        if (verdict === "closed") {
          // Still not there. Queue the push rather than generating vendor 500s.
          try {
            const { enqueueSync } = await import("@/lib/bmi-sync-queue");
            const queued = await enqueueSync({
              kind: "push-waiver-signature",
              idempotencyKey: `waiver-push:${personID}:${new Date().toISOString().slice(0, 10)}`,
              barrier: "person-local",
              barrierRef: String(personID),
              locationId: locationID,
              payload: {
                personId: String(personID),
                name: String(firstName ?? "").trim() || "Guest",
                locationKey: location ?? null,
                signaturePngB64: sigBase64,
              },
            });
            console.log(
              `[pandora-waiver] still not local after ${waited}s — queued waiver push (row ${queued?.id ?? "n/a"}) for ${personID}. Signature is safe in Neon.`,
            );
            await logSignOutcome("queued", 0, null, null);
            return NextResponse.json({
              ok: true,
              waiverID: null,
              queuedForSync: true,
              licenceGrant: grant(),
            });
          } catch (err) {
            // Could not queue — fall through and let the sign attempts run, so a
            // queue outage never silently drops the waiver.
            console.warn("[pandora-waiver] could not queue the waiver push:", err);
          }
        } else {
          console.log(
            `[pandora-waiver] person ${personID} became visible locally after ${waited}s — signing now`,
          );
        }
      }
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
          return NextResponse.json({
            ok: true,
            waiverID: null,
            alreadyValid: true,
            licenceGrant: grant(),
          });
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
        return NextResponse.json({ ok: true, waiverID, licenceGrant: grant() });
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
      return NextResponse.json({
        ok: true,
        waiverID: null,
        alreadyValid: true,
        licenceGrant: grant(),
      });
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
     * `personLocalBarrier` distinguishes the cases: 404 = genuinely not local
     * yet (queue it), anything else = the person IS there and the failure is a
     * real vendor problem (report it, exactly as before).
     */
    try {
      const { personLocalBarrier } = await import("@/lib/bmi-sync-barriers");
      const barrier = await personLocalBarrier(locationID, personID);
      if (barrier.verdict === "closed") {
        const { enqueueSync } = await import("@/lib/bmi-sync-queue");
        const queued = await enqueueSync({
          kind: "push-waiver-signature",
          // Keyed per person per DAY: a re-signed waiver on a later visit is a
          // new followup, while a retried submit on the same visit is not.
          idempotencyKey: `waiver-push:${personID}:${new Date().toISOString().slice(0, 10)}`,
          barrier: "person-local",
          barrierRef: personID,
          locationId: locationID,
          payload: {
            personId: String(personID),
            name: String(firstName ?? "").trim() || "Guest",
            locationKey: location ?? null,
            // The already-stripped base64 (no data: prefix) — the handler
            // rehydrates it to a Buffer for the multipart upload.
            signaturePngB64: sigBase64,
          },
        });
        console.log(
          `[pandora-waiver] person not local yet (${barrier.detail}) — queued waiver push` +
            ` (row ${queued?.id ?? "n/a"}) for ${personID}. Signature is safe in Neon.`,
        );
        await logSignOutcome("queued", 3, null, lastError);
        return NextResponse.json({
          ok: true,
          waiverID: null,
          /** The vendor record is owed, not lost — Neon holds the signature and
           *  the sync queue completes the push within a tick or two. */
          queuedForSync: true,
          licenceGrant: grant(),
        });
      }
    } catch (err) {
      console.warn("[pandora-waiver] could not queue the waiver push:", err);
    }

    // The row that matters: the guest signed and has NO waiver.
    await logSignOutcome("failed", 3, null, lastError);
    return NextResponse.json(
      { error: lastError?.message || "Waiver signing failed" },
      { status: lastError?.status || 502 },
    );
  } catch (err) {
    console.error("[pandora-waiver] sign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Waiver signing failed" },
      { status: 500 },
    );
  }
}
