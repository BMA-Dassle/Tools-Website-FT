import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWithRawIds } from "@ft/db";
import { HttpResponse, http, installMsw, rawJson } from "../../../../../test/msw/server";
import { OFFICE_BASE } from "../../../../../test/msw/handlers/office";
import { PANDORA_BASE } from "../../../../../test/msw/handlers/pandora";
import { fixtureText } from "../../../../../test/msw/handlers/fixture";
import type { GroupFunctionQuote } from "../transport";
import {
  CANCEL_VERIFY_JOB_KIND,
  ContractActionError,
  approveContract,
  cancelEvent,
  chargeBalance,
  clientKeyForCenterCode,
  denyContract,
  resendContract,
  runCancelVerifyJob,
  type ActionDeps,
} from "./actions";
import { cancelVerifyJobKey } from "./detail";

/**
 * The contract actions, with Office and Pandora behind MSW.
 *
 * THE ONE THAT MATTERS is the cancel: `setProjectState` sends built-in
 * negative ids through Pandora and returns on Pandora's 200 with NO re-read
 * (`lib/bmi-office-actions.ts:537-546`). The fake here answers that 200 — and
 * then Office keeps saying `-3`. Nothing may be recorded as cancelled; a
 * verify job must be queued instead. That is the whole of R5 in one test.
 *
 * The Office fixture is RAW TEXT with a bare 17-digit personId, served exactly
 * as Office serves it, so `parseWithRawIds` is really exercised on the path the
 * poll uses — with the negative control below to prove the fixture is still the
 * ugly case.
 */

/** The `-3` project (Confirmation) straight from the shared fixtures. */
const PROJECT_MINUS_3 = fixtureText("office-project-58454077.json.txt");
/** The same project after a cancellation lands, byte for byte but `-4`. */
const PROJECT_MINUS_4 = PROJECT_MINUS_3.replace('"stateId":-3', '"stateId":-4');

const PROJECT_ID = "58454077";
let officeState: "-3" | "-4" = "-3";

installMsw(
  http.get(`${OFFICE_BASE}/api/:clientKey/project/:id`, ({ params }) =>
    params.id === PROJECT_ID
      ? rawJson(officeState === "-4" ? PROJECT_MINUS_4 : PROJECT_MINUS_3)
      : new HttpResponse("Not found", { status: 404 }),
  ),
  http.post(`${PANDORA_BASE}/bmi/reservation/state`, () => HttpResponse.json({ success: true })),
);

const QUOTE = {
  id: 4821,
  contract_short_id: "7Hx2Qk",
  bmi_reservation_id: PROJECT_ID,
  center_code: "fort-myers",
  center_name: "HeadPinz Fort Myers",
  status: "pending_approval",
  guest_email: "rick@stormsmart.test",
  guest_phone: "2395551234",
  event_name: "Storm Smart",
  balance_cents: 100_375,
  collected_cents: 0,
  saved_card_id: "ccof:abc",
} as unknown as GroupFunctionQuote;

const ACTOR = "eric@headpinz.com";

interface Spies {
  deps: ActionDeps;
  audit: ReturnType<typeof vi.fn>;
  activity: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  deny: ReturnType<typeof vi.fn>;
  charge: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  privateNote: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

function makeDeps(quote: GroupFunctionQuote = QUOTE, settings: unknown = null): Spies {
  const audit = vi.fn(async () => {});
  const activity = vi.fn(async () => "1");
  const enqueue = vi.fn(async () => ({ job: { id: "1" }, created: true }));
  const approve = vi.fn(async () => ({
    action: "approved" as const,
    quoteId: 4821,
    shortId: "7Hx2Qk",
    approverEmail: ACTOR,
  }));
  const deny = vi.fn(async () => ({
    action: "denied" as const,
    quoteId: 4821,
    shortId: "7Hx2Qk",
    approverEmail: ACTOR,
  }));
  const charge = vi.fn(async () => "auto_charged" as const);
  const notify = vi.fn(async () => {});
  const privateNote = vi.fn(async () => {});

  /** Pandora-first, exactly as `setProjectState` does for a built-in id. */
  const setState = vi.fn(async (p: { projectId: string; stateId: string }) => {
    const res = await fetch(`${PANDORA_BASE}/bmi/reservation/state`, {
      method: "POST",
      body: JSON.stringify({ projectId: p.projectId, stateId: p.stateId }),
    });
    if (!res.ok) throw new Error(`pandora ${res.status}`);
    // …and returns. No re-read. That is the behaviour under test.
  });

  const deps = {
    getQuote: vi.fn(async () => quote),
    getRow: vi.fn(async () => null),
    approveQuote: approve,
    denyQuote: deny,
    chargeBalanceForQuote: charge,
    notifyContractSent: notify,
    createDayofOrder: vi.fn(async () => ({ id: "sq-day", totalCents: 189_000 })),
    updateGfQuoteDetails: vi.fn(async () => {}),
    appendAuditLog: vi.fn(async () => {}),
    recordEventNotification: vi.fn(async () => {}),
    eventWaiverLinkUrl: vi.fn(async () => null),
    setProjectState: setState,
    fetchProjectRawIds: vi.fn(async (clientKey: string, projectId: string) => {
      const res = await fetch(`${OFFICE_BASE}/api/${clientKey}/project/${projectId}`);
      if (!res.ok) return null;
      return parseWithRawIds<Record<string, unknown>>(await res.text());
    }),
    appendProjectPrivateNote: privateNote,
    writeAudit: audit,
    recordActivity: activity,
    listLeadContractRefs: vi.fn(async () => [
      { id: "77", publicId: "L-1048", gfShortId: "7Hx2Qk", bmiProjectId: PROJECT_ID },
    ]),
    getSettingValue: vi.fn(async () => settings),
    jobs: { enqueue },
    getJobByIdempotencyKey: vi.fn(async () => null),
    sleep: vi.fn(async () => {}),
    now: () => new Date("2026-09-13T16:30:00.000Z"),
  } as unknown as ActionDeps;

  return { deps, audit, activity, enqueue, approve, deny, charge, notify, privateNote, setState };
}

beforeEach(() => {
  officeState = "-3";
});

describe("the Office fixture is still the ugly case", () => {
  it("a 17-digit bill id survives parseWithRawIds and does NOT survive JSON.parse", () => {
    // NEGATIVE CONTROL, naming the ROUNDED value: 63000000009561443 is not
    // representable as a double and comes back as …440. `personId` in this
    // fixture happens to be …440 already, which is exactly why a control has to
    // name the rounded number rather than assume any 17-digit id will move.
    const naive = JSON.parse(PROJECT_MINUS_3) as { bills: { id: number }[] };
    expect(String(naive.bills[0].id)).toBe("63000000009561440");
    expect(String(naive.bills[0].id)).not.toBe("63000000009561443");

    const guarded = parseWithRawIds<{ bills: { id: string }[]; personId: string }>(PROJECT_MINUS_3);
    expect(guarded.bills[0].id).toBe("63000000009561443");
    expect(guarded.personId).toBe("63000000009561440");
  });
});

describe("approve / deny record the SIGNED-IN actor", () => {
  it("approve passes the session email as the approver and audits it", async () => {
    const s = makeDeps();
    const result = await approveContract(
      { shortId: "7Hx2Qk", actor: ACTOR, memo: "DR-14 on file" },
      s.deps,
    );

    expect(s.approve).toHaveBeenCalledWith(QUOTE, {
      approverEmail: ACTOR,
      memo: "DR-14 on file",
    });
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "contract",
        entityId: "7Hx2Qk",
        action: "approve",
        actorEmail: ACTOR,
      }),
    );
    expect(s.activity).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "77", actorEmail: ACTOR, kind: "payment" }),
    );
    expect(result.message).toContain("Approved");
  });

  it("deny carries the reason to the planner rail and to the ledger", async () => {
    const s = makeDeps();
    await denyContract({ shortId: "7Hx2Qk", actor: ACTOR, reason: "No youth products" }, s.deps);
    expect(s.deny).toHaveBeenCalledWith(QUOTE, {
      approverEmail: ACTOR,
      reason: "No youth products",
    });
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deny", actorEmail: ACTOR }),
    );
  });

  it("a contract that has moved on is a 409, not a 500", async () => {
    const s = makeDeps();
    const { QuoteNotPendingApprovalError } = await import("@/lib/group-function-approve");
    (s.approve as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new QuoteNotPendingApprovalError("contract_sent"),
    );
    await expect(
      approveContract({ shortId: "7Hx2Qk", actor: ACTOR }, s.deps),
    ).rejects.toMatchObject({ status: 409, code: "not_pending_approval" });
  });

  it("a missing contract is a 404", async () => {
    const s = makeDeps();
    (
      s.deps.getQuote as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(null);
    await expect(approveContract({ shortId: "nope", actor: ACTOR }, s.deps)).rejects.toBeInstanceOf(
      ContractActionError,
    );
  });
});

describe("resend goes through the existing notify rail", () => {
  it("sends, appends to the v1 audit ledger, notes BMI and writes our own audit", async () => {
    const s = makeDeps();
    await resendContract({ shortId: "7Hx2Qk", actor: ACTOR, note: "went to spam" }, s.deps);
    expect(s.notify).toHaveBeenCalledWith(QUOTE);
    expect(s.privateNote).toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resend", actorEmail: ACTOR }),
    );
  });
});

describe("charge balance", () => {
  it("runs the cron's own function with the actor and reason", async () => {
    const s = makeDeps();
    const r = await chargeBalance(
      { shortId: "7Hx2Qk", actor: ACTOR, reason: "Guest asked to pay early" },
      s.deps,
    );
    expect(s.charge).toHaveBeenCalledWith(QUOTE, {
      actor: ACTOR,
      reason: "Guest asked to pay early",
      mode: "auto",
    });
    expect(r.outcome).toBe("auto_charged");
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "charge-balance", actorEmail: ACTOR }),
    );
  });

  it("refuses to 'charge the card' when there is no card, rather than falling through to a link", async () => {
    const s = makeDeps({ ...QUOTE, saved_card_id: null } as GroupFunctionQuote);
    await expect(
      chargeBalance({ shortId: "7Hx2Qk", actor: ACTOR, mode: "auto" }, s.deps),
    ).rejects.toMatchObject({ status: 409, code: "no_card_on_file" });
    expect(s.charge).not.toHaveBeenCalled();
  });

  it("the link mode does not need a card and is audited as its own action", async () => {
    const s = makeDeps({ ...QUOTE, saved_card_id: null } as GroupFunctionQuote);
    (s.charge as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      "link_sent",
    );
    const r = await chargeBalance({ shortId: "7Hx2Qk", actor: ACTOR, mode: "link" }, s.deps);
    expect(r.outcome).toBe("link_sent");
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "send-balance-link" }));
  });
});

describe("cancel — Pandora's 200 is not a cancellation", () => {
  it("Pandora 200 but Office still -3 → NO audit row, a verify job, and an honest message", async () => {
    const s = makeDeps({ ...QUOTE, status: "deposit_paid" } as GroupFunctionQuote);
    const result = await cancelEvent(
      { shortId: "7Hx2Qk", actor: ACTOR, reason: "Guest cancelled", note: null },
      s.deps,
    );

    // Pandora really answered 200 through MSW.
    expect(s.setState).toHaveBeenCalledWith(
      expect.objectContaining({ stateId: "-4", projectId: PROJECT_ID }),
    );
    expect(result.verified).toBe(false);
    expect(result.observedStateId).toBe("-3");

    // NOTHING is recorded as cancelled.
    expect(s.audit).not.toHaveBeenCalled();

    // A job is queued to keep asking, under one key per contract.
    expect(result.jobEnqueued).toBe(true);
    expect(s.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: CANCEL_VERIFY_JOB_KIND,
        idempotencyKey: cancelVerifyJobKey("7Hx2Qk"),
        createdBy: ACTOR,
      }),
    );

    // And the deal timeline says exactly what happened.
    expect(s.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        body: expect.stringContaining("Office still reads -3"),
      }),
    );
    expect(result.message).toContain("waiting for Office to confirm");
  });

  it("polls three times before giving up", async () => {
    const s = makeDeps({ ...QUOTE, status: "deposit_paid" } as GroupFunctionQuote);
    await cancelEvent({ shortId: "7Hx2Qk", actor: ACTOR, reason: "Duplicate" }, s.deps);
    expect(s.deps.fetchProjectRawIds).toHaveBeenCalledTimes(3);
    expect(s.deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("Office says -4 → the audit row is written and no job is queued", async () => {
    officeState = "-4";
    const s = makeDeps({ ...QUOTE, status: "deposit_paid" } as GroupFunctionQuote);
    const result = await cancelEvent(
      { shortId: "7Hx2Qk", actor: ACTOR, reason: "Weather / closure", note: "Hurricane" },
      s.deps,
    );
    expect(result.verified).toBe(true);
    expect(result.jobEnqueued).toBe(false);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel",
        actorEmail: ACTOR,
        after: expect.objectContaining({ stateId: "-4" }),
      }),
    );
    expect(s.privateNote).toHaveBeenCalled();
  });

  it("refuses entirely when BMI writes are paused for the centre", async () => {
    const s = makeDeps({ ...QUOTE, status: "deposit_paid" } as GroupFunctionQuote, {
      enabled: false,
    });
    await expect(
      cancelEvent({ shortId: "7Hx2Qk", actor: ACTOR, reason: "Duplicate" }, s.deps),
    ).rejects.toMatchObject({ status: 409, code: "bmi_writes_paused" });
    expect(s.setState).not.toHaveBeenCalled();
  });

  it("resolves the Office tenant from the center_code, Naples included", () => {
    expect(clientKeyForCenterCode("fort-myers")).toBe("headpinzftmyers");
    expect(clientKeyForCenterCode("fasttrax")).toBe("headpinzftmyers");
    expect(clientKeyForCenterCode("naples")).toBe("headpinznaples");
  });
});

describe("the verify job", () => {
  it("still -3 → an ordinary failure the runner will retry", async () => {
    const s = makeDeps();
    const out = await runCancelVerifyJob(
      { shortId: "7Hx2Qk", projectId: PROJECT_ID, clientKey: "headpinzftmyers", actor: ACTOR },
      s.deps,
    );
    expect(out).toEqual({ ok: false, error: "Office reads -3, expected -4" });
    expect(s.audit).not.toHaveBeenCalled();
  });

  it("-4 at last → writes the audit row the cancel could not", async () => {
    officeState = "-4";
    const s = makeDeps();
    const out = await runCancelVerifyJob(
      {
        shortId: "7Hx2Qk",
        projectId: PROJECT_ID,
        clientKey: "headpinzftmyers",
        actor: ACTOR,
        reason: "Guest cancelled",
      },
      s.deps,
    );
    expect(out.ok).toBe(true);
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancel", actorEmail: ACTOR }),
    );
  });

  it("a payload with no shortId parks instead of retrying forever", async () => {
    const s = makeDeps();
    expect(await runCancelVerifyJob({}, s.deps)).toMatchObject({ ok: false, park: true });
  });
});
