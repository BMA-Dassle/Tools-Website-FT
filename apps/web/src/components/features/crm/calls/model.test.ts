import { describe, expect, it } from "vitest";
import type { CallRow, CallsConnectivity } from "~/features/crm/calls/contracts";
import {
  callGlyph,
  callPill,
  callTitle,
  connectivityNotices,
  isMissed,
  needsDisposition,
  prettyNumber,
  statusLabel,
  talkTime,
} from "./model";

/** What the Calls list actually prints. */

function call(partial: Partial<CallRow> = {}): CallRow {
  return {
    id: "1",
    threecxCallId: "g",
    direction: "in",
    fromE164: "+12395551234",
    toE164: null,
    extension: "9027",
    repId: "7",
    repSlug: "kelsea",
    repInitials: "KK",
    repName: "Kelsea Kosco",
    leadId: "9",
    leadPublicId: "L-9",
    contactId: "5",
    contactLabel: "Lee Health",
    guestName: null,
    startedAt: "2026-09-13T18:00:00.000Z",
    answeredAt: null,
    endedAt: null,
    durationSeconds: 228,
    status: "Answered",
    callType: "Extension",
    disposition: null,
    dispositionNote: null,
    disposedAt: null,
    disposedBy: null,
    recordingUrl: null,
    source: "reconcile",
    actorEmail: null,
    createdAt: "2026-09-13T18:00:00.000Z",
    ...partial,
  };
}

describe("talkTime", () => {
  it("is the prototype's m:ss", () => {
    expect(talkTime(228)).toBe("3:48");
    expect(talkTime(0)).toBe("0:00");
    expect(talkTime(52)).toBe("0:52");
    expect(talkTime(555)).toBe("9:15");
  });

  it("never prints NaN", () => {
    expect(talkTime(null)).toBe("0:00");
    expect(talkTime(undefined)).toBe("0:00");
  });
});

describe("prettyNumber", () => {
  it("formats a US number and leaves anything else alone", () => {
    expect(prettyNumber("+12395551234")).toBe("(239) 555-1234");
    expect(prettyNumber("+442071234567")).toBe("+442071234567");
    expect(prettyNumber(null)).toBe("Unknown");
  });
});

describe("callTitle / callPill", () => {
  it("prefers the PBX's name, then the account, then the number", () => {
    expect(callTitle(call({ guestName: "Renee Alvarado" }))).toBe("Renee Alvarado");
    expect(callTitle(call())).toBe("Lee Health");
    expect(callTitle(call({ contactLabel: null }))).toBe("(239) 555-1234");
  });

  it("marks a call matched to nothing", () => {
    expect(callPill(call())).toBeNull();
    expect(callPill(call({ leadId: null }))).toBe("Unknown");
  });
});

describe("status", () => {
  it("knows a missed call from an answered one and from a dial in flight", () => {
    expect(isMissed(call({ status: "Answered" }))).toBe(false);
    expect(isMissed(call({ status: "Unanswered" }))).toBe(true);
    expect(isMissed(call({ status: "Dialing" }))).toBe(false);
    expect(callGlyph(call({ status: "Unanswered" }))).toBe("missed");
    expect(callGlyph(call({ direction: "out" }))).toBe("out");
  });

  it("labels a voicemail as such", () => {
    expect(statusLabel(call({ status: "Unanswered", disposition: "Voicemail" }))).toBe("Voicemail");
    expect(statusLabel(call({ status: "Unanswered", disposition: null }))).toBe("Missed");
  });
});

describe("needsDisposition", () => {
  it("asks for an outcome on an answered call that has a lead and no outcome yet", () => {
    expect(needsDisposition(call())).toBe(true);
    expect(needsDisposition(call({ disposition: "Reached" }))).toBe(false);
    expect(needsDisposition(call({ status: "Unanswered" }))).toBe(false);
    // Busywork: a call that belongs to nobody goes in the tray, not the to-do.
    expect(needsDisposition(call({ leadId: null }))).toBe(false);
  });
});

describe("connectivityNotices", () => {
  const base: CallsConnectivity = {
    apiConfigured: true,
    journalConfigured: true,
    clickToCallEnabled: true,
    myExtension: "9025",
  };

  it("says nothing when everything is wired", () => {
    expect(connectivityNotices(base)).toEqual([]);
  });

  it("says the ONE thing that matters when there is no credential", () => {
    const out = connectivityNotices({ ...base, apiConfigured: false, journalConfigured: false });
    expect(out).toHaveLength(1);
    expect(out[0].tone).toBe("crit");
  });

  it("names the journal as the missing half — today's real state", () => {
    const out = connectivityNotices({ ...base, journalConfigured: false });
    expect(out[0].text).toContain("3CX journaling is not connected yet");
    expect(out[0].tone).toBe("warn");
  });

  it("explains a missing extension rather than just failing to dial", () => {
    const out = connectivityNotices({ ...base, myExtension: null });
    expect(out[0].text).toContain("No 3CX extension on your rep record");
  });

  it("prefers the kill switch over the extension, since it explains more", () => {
    const out = connectivityNotices({ ...base, clickToCallEnabled: false, myExtension: null });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Click-to-call is switched off");
  });
});
