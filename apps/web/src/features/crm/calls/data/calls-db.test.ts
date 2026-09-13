import { describe, expect, it } from "vitest";
import { decodeCallCursor, encodeCallCursor, mapCallRow, type CallRowRaw } from "./calls-db";

/** The pure halves of the data layer: the keyset cursor and the row mapping. */

function raw(partial: Partial<CallRowRaw> = {}): CallRowRaw {
  return {
    id: "101",
    threecx_call_id: "00000000-01dd-43ab-25e4-c24300000ic5",
    direction: "in",
    from_e164: "+12395551234",
    to_e164: null,
    extension: "9027",
    rep_id: "7",
    lead_id: "9",
    contact_id: "5",
    started_at: "2026-09-13T18:10:36.104Z",
    answered_at: "2026-09-13T18:11:27.302Z",
    ended_at: "2026-09-13T18:12:40.000Z",
    duration_seconds: 73,
    status: "Answered",
    disposition: "Reached",
    disposition_note: "Booked a tour",
    recording_url: "9027/[…].wav",
    source: "reconcile",
    actor_email: null,
    guest_name: "Lee Health",
    call_type: "Extension",
    disposed_at: "2026-09-13T18:20:00.000Z",
    disposed_by: "kelsea@headpinz.com",
    created_at: "2026-09-13T18:12:41.000Z",
    lead_public_id: "L-9",
    contact_label: "Lee Health",
    rep_slug: "stephanie",
    rep_initials: "SW",
    rep_name: "Stephanie Wegman",
    ...partial,
  };
}

describe("mapCallRow", () => {
  it("keeps every id a string and every instant an ISO UTC stamp", () => {
    const row = mapCallRow(raw());
    expect(row.id).toBe("101");
    expect(typeof row.leadId).toBe("string");
    expect(row.threecxCallId).toBe("00000000-01dd-43ab-25e4-c24300000ic5");
    expect(row.startedAt).toBe("2026-09-13T18:10:36.104Z");
    expect(row.durationSeconds).toBe(73);
  });

  it("normalises a direction and a source it does not recognise, rather than trusting them", () => {
    expect(mapCallRow(raw({ direction: "sideways" })).direction).toBe("in");
    expect(mapCallRow(raw({ source: "aliens" })).source).toBe("manual");
  });

  it("nulls the joined columns when the call belongs to nobody", () => {
    const row = mapCallRow(
      raw({
        lead_id: null,
        lead_public_id: null,
        rep_id: null,
        rep_slug: null,
        contact_label: null,
      }),
    );
    expect(row.leadId).toBeNull();
    expect(row.leadPublicId).toBeNull();
    expect(row.repSlug).toBeNull();
    expect(row.contactLabel).toBeNull();
  });
});

describe("the keyset cursor", () => {
  it("round-trips", () => {
    const c = encodeCallCursor("2026-09-13T18:10:36.104Z", "101");
    expect(decodeCallCursor(c)).toEqual({ startedAt: "2026-09-13T18:10:36.104Z", id: "101" });
  });

  it("refuses anything it did not make, instead of throwing or trusting it", () => {
    expect(decodeCallCursor(null)).toBeNull();
    expect(decodeCallCursor("")).toBeNull();
    expect(decodeCallCursor("not-base64url!!")).toBeNull();
    expect(decodeCallCursor(Buffer.from("x|y", "utf8").toString("base64url"))).toBeNull();
    // An id that is not digits could otherwise be interpolated into the SQL.
    expect(
      decodeCallCursor(
        Buffer.from("2026-09-13T18:10:36.104Z|1; DROP", "utf8").toString("base64url"),
      ),
    ).toBeNull();
  });
});
