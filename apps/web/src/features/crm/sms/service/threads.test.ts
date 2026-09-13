import { describe, expect, it } from "vitest";
import { foldConversations, type FoldInput } from "./threads";
import { unionDids } from "./dids";
import type { CrmRep } from "../../core/types";
import type { LinkedContact, LinkedLead, SmsMessage, SmsThread } from "../types";

/**
 * ONE ENTRY PER PERSON. `crm_sms_threads` is keyed by (rep DID, guest number)
 * because that is all the carrier tells us; the screen shows one row per
 * person, and this is the fold that gets from one to the other.
 */

function thread(over: Partial<SmsThread>): SmsThread {
  return {
    id: "1",
    repId: "7",
    repDid: "+12392058142",
    guestE164: "+12395551234",
    contactId: "9",
    leadId: "1042",
    lastMessageAt: "2026-09-13T12:00:00.000Z",
    lastInboundAt: null,
    readAt: null,
    unreadCount: 0,
    stoppedAt: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    ...over,
  };
}

function message(over: Partial<SmsMessage>): SmsMessage {
  return {
    id: "1",
    threadId: "1",
    leadId: "1042",
    direction: "out",
    kind: "sms",
    body: "Hi Dana",
    sentFrom: "+12392058142",
    provider: "vox",
    providerMessageId: "vx_1",
    deliveryStatus: null,
    deliveryError: null,
    sendStatus: "sent",
    fallbackDid: false,
    templateId: null,
    actorEmail: null,
    occurredAt: "2026-09-13T12:00:00.000Z",
    ...over,
  };
}

const contact: LinkedContact = {
  id: "9",
  firstName: "Dana",
  lastName: "Whitfield",
  phoneE164: "+12395551234",
  email: null,
  accountName: "Lee Health",
};

const lead: LinkedLead = {
  id: "1042",
  publicId: "L-1042",
  source: "web",
  isProspect: false,
  assignedRepId: "7",
  centre: "HPFM",
  eventDate: "2026-10-17",
  eventType: "corporate",
  guests: 60,
  statusId: "quote",
};

function reps(): CrmRep[] {
  const base = {
    ssoSub: null,
    bmiUserId: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [] as CrmRep["centres"],
    active: true,
    sortOrder: 10,
    role: "rep" as const,
    email: null,
  };
  return [
    {
      ...base,
      id: "7",
      slug: "kelsea",
      displayName: "Kelsea",
      firstName: "Kelsea",
      initials: "KK",
      voxDid: "+12392058142",
    },
    {
      ...base,
      id: "8",
      slug: "lori",
      displayName: "Lori",
      firstName: "Lori",
      initials: "LL",
      voxDid: "+12392058143",
    },
  ];
}

function input(over: Partial<FoldInput> = {}): FoldInput {
  return {
    threads: [thread({})],
    lastByThread: new Map([["1", message({})]]),
    contactsById: new Map([["9", contact]]),
    contactsByPhone: new Map(),
    leadsByContact: new Map([["9", lead]]),
    repsById: new Map(reps().map((r) => [r.id, r])),
    ...over,
  };
}

describe("foldConversations", () => {
  it("one thread is one entry, named after the person with the lead's caption", () => {
    const [c] = foldConversations(input());
    expect(c.key).toBe("c-9");
    expect(c.name).toBe("Dana Whitfield");
    expect(c.leadTitle).toBe("Lee Health");
    expect(c.leadPublicId).toBe("L-1042");
    expect(c.repSlugs).toEqual(["kelsea"]);
    expect(c.lastBody).toBe("Hi Dana");
  });

  it("TWO REPS' THREADS WITH ONE PERSON ARE ONE ROW, newest message winning", () => {
    const out = foldConversations(
      input({
        threads: [
          thread({
            id: "1",
            repId: "7",
            repDid: "+12392058142",
            lastMessageAt: "2026-09-13T09:00:00.000Z",
            unreadCount: 1,
          }),
          thread({
            id: "2",
            repId: "8",
            repDid: "+12392058143",
            lastMessageAt: "2026-09-13T12:00:00.000Z",
            unreadCount: 2,
          }),
        ],
        lastByThread: new Map([
          ["1", message({ id: "1", threadId: "1", body: "older" })],
          ["2", message({ id: "2", threadId: "2", body: "newer", direction: "in" })],
        ]),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].threadIds).toEqual(["1", "2"]);
    expect(out[0].repSlugs).toEqual(["kelsea", "lori"]);
    expect(out[0].unread).toBe(3);
    expect(out[0].lastBody).toBe("newer");
    expect(out[0].lastDirection).toBe("in");
    expect(out[0].lastMessageAt).toBe("2026-09-13T12:00:00.000Z");
  });

  it("a STOP on ANY of a person's threads marks the person stopped", () => {
    const out = foldConversations(
      input({
        threads: [
          thread({ id: "1" }),
          thread({
            id: "2",
            repId: "8",
            repDid: "+12392058143",
            stoppedAt: "2026-09-13T10:00:00.000Z",
          }),
        ],
        lastByThread: new Map(),
      }),
    );
    expect(out[0].stopped).toBe(true);
  });

  it("a number we do not know keys on the NUMBER, and says so by having no name", () => {
    const out = foldConversations(
      input({
        threads: [thread({ contactId: null, guestE164: "+12399990000" })],
        contactsById: new Map(),
        contactsByPhone: new Map(),
        leadsByContact: new Map(),
      }),
    );
    expect(out[0].key).toBe("p-12399990000");
    expect(out[0].name).toBeNull();
    expect(out[0].leadPublicId).toBeNull();
  });

  it("a thread with no contact id still folds onto the person when the NUMBER matches", () => {
    const out = foldConversations(
      input({
        threads: [
          thread({ id: "1", contactId: "9" }),
          thread({ id: "2", contactId: null, repId: "8", repDid: "+12392058143" }),
        ],
        contactsByPhone: new Map([["+12395551234", contact]]),
        lastByThread: new Map(),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("c-9");
  });

  it("entries come back newest first", () => {
    const out = foldConversations(
      input({
        threads: [
          thread({ id: "1", contactId: "9", lastMessageAt: "2026-09-11T00:00:00.000Z" }),
          thread({
            id: "2",
            contactId: null,
            guestE164: "+12399990000",
            lastMessageAt: "2026-09-13T00:00:00.000Z",
          }),
        ],
        lastByThread: new Map(),
      }),
    );
    expect(out.map((c) => c.key)).toEqual(["p-12399990000", "c-9"]);
  });
});

describe("allowedDids union", () => {
  it("keeps the A2P number first and adds the reps' numbers once each", () => {
    expect(unionDids(["+12394412867"], ["+12392058142", "+12392058142", "+12392058143"])).toEqual([
      "+12394412867",
      "+12392058142",
      "+12392058143",
    ]);
  });

  it("canonicalises whatever the roster holds", () => {
    expect(unionDids([], ["(239) 205-8142"])).toEqual(["+12392058142"]);
  });

  it("an empty roster leaves the env list exactly as it was", () => {
    expect(unionDids(["+12394412867"], [])).toEqual(["+12394412867"]);
  });
});
