import { NextRequest, NextResponse } from "next/server";
import { recordClipResult } from "~/features/pov-reel/data/pov-reel-clips-db";

/**
 * THE CLIPPER REPORTING BACK — one finished 12s cut at a time.
 *
 * The Railway clipper answers the cron with 202 and then works for minutes, so
 * this is the only channel through which a run's outcome reaches us. It reports
 * PER CLIP rather than in one batch at the end, which is why this route writes
 * each result immediately: a run that dies halfway should still have published
 * everything it managed.
 *
 * WATCH `anchor`. "burn-in" means OCR read the camera's burned-in wall clock and
 * the cut is exact; "estimate" is the centring fallback, measured 55 SECONDS
 * wrong on a real video. One estimate is a bad frame. A whole run of them means
 * tesseract is broken inside the container — the single most likely way the
 * first live deploy fails, and invisible unless it is written down. So the
 * summary line counts them and says so out loud.
 *
 * Deliberately SEPARATE from /api/webhooks/vt3-video-event, which is about whole
 * videos arriving from the camera system. This one is about slices we asked for.
 * Folding them together would put a synthetic shape on a rail whose consumers
 * (notify, survey, the videos admin) would each have to ignore it correctly.
 *
 * Auth is the same either-secret gate the two bridges use, because the clipper
 * signs with `KART_BRIDGE_SECRET` — one shared secret across all three services
 * is the deployed reality.
 */

const KART_SECRET = process.env.KART_BRIDGE_SECRET || "";
const VT3_SECRET = process.env.VT3_BRIDGE_SECRET || "";

interface ClipResultPayload {
  videoCode?: unknown;
  url?: unknown;
  bytes?: unknown;
  cutAtS?: unknown;
  anchor?: unknown;
}

interface Payload {
  kind?: unknown;
  result?: ClipResultPayload;
  built?: unknown;
  failed?: Array<{ videoCode?: unknown; reason?: unknown }>;
}

function secretValid(provided: string | null): boolean {
  if (!provided) return false;
  if (KART_SECRET && provided === KART_SECRET) return true;
  if (VT3_SECRET && provided === VT3_SECRET) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!KART_SECRET && !VT3_SECRET) {
    console.error("[pov-reel-clip] no secret configured (set KART_BRIDGE_SECRET)");
    return NextResponse.json({ error: "server not configured" }, { status: 500 });
  }
  if (!secretValid(req.headers.get("x-kart-bridge-secret"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // End-of-run summary. Nothing to store — the per-clip writes already landed —
  // but the failure list is the only place a "no usable media" skip is ever
  // named, so it goes to the log rather than the floor.
  if (body.kind === "run-complete") {
    const failed = Array.isArray(body.failed) ? body.failed : [];
    console.log(
      `[pov-reel-clip] run complete: built=${Number(body.built) || 0} failed=${failed.length}`,
    );
    for (const f of failed) {
      console.warn(`[pov-reel-clip] failed ${String(f?.videoCode)}: ${String(f?.reason)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.kind !== "clip" || !body.result) {
    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  }

  const r = body.result;
  const videoCode = typeof r.videoCode === "string" ? r.videoCode.trim() : "";
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!videoCode || !url) {
    return NextResponse.json({ error: "videoCode and url are required" }, { status: 400 });
  }
  // Only the two the clipper can produce. An unrecognised value would otherwise
  // read as a third, unexamined provenance in the manifest.
  const anchor = r.anchor === "burn-in" ? "burn-in" : "estimate";

  try {
    const matched = await recordClipResult({
      videoCode,
      url,
      bytes: Number.isFinite(r.bytes) ? Number(r.bytes) : 0,
      cutAtS: Number.isFinite(r.cutAtS) ? Number(r.cutAtS) : 0,
      anchor,
    });
    if (!matched) {
      // A result for footage we never dispatched. Not an error to the clipper —
      // it did its job — but it must not reach the wall, and a silent no-op here
      // would be indistinguishable from a successful write.
      console.warn(`[pov-reel-clip] no dispatched row for ${videoCode} — result ignored`);
      return NextResponse.json({ ok: true, recorded: false, reason: "not dispatched" });
    }
  } catch (err) {
    console.error("[pov-reel-clip] write failed:", err);
    // 500 here is deliberate, unlike the bridge lifecycle log: this is the clip
    // manifest the wall reads from, and the clipper's next run re-dispatches
    // anything still missing a blob. Losing it silently would strand the row.
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }

  console.log(
    `[pov-reel-clip] ${videoCode} anchor=${anchor} ` +
      `${(Number(r.bytes) / 1e6 || 0).toFixed(1)}MB cut@${Number(r.cutAtS) || 0}s`,
  );
  if (anchor === "estimate") {
    console.warn(
      `[pov-reel-clip] ${videoCode} fell back to the centring estimate ` +
        `(~55s error) — if every clip in a run says this, OCR is broken in the container`,
    );
  }
  return NextResponse.json({ ok: true, recorded: true });
}
