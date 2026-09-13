import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE EXTRACTION CONTRACT (brief §4, B5): the CRM and the two v1 surfaces run
 * the SAME code, and the v1 surfaces keep working. This file reads the source
 * — the cheapest possible check, and the only one that catches "somebody
 * pasted the body back in" — while `approve-route.contract.test.ts` proves the
 * v1 route still behaves.
 *
 * A copy-paste regression here is not hypothetical: the day-of order builder
 * had two copies once, and a tax misclassification had to be found twice.
 */
const WEB = path.resolve(__dirname, "../../../../..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");

describe("the balance charge has ONE implementation", () => {
  const cron = read("app/api/cron/group-balance-charge/route.ts");
  const lib = read("lib/group-balance-charge.ts");

  it("the cron calls chargeBalanceForQuote and no longer carries the body", () => {
    expect(cron).toContain('from "@/lib/group-balance-charge"');
    expect(cron).toContain("chargeBalanceForQuote(q)");
    for (const moved of [
      "claimGfBalanceCharge",
      "loadBalanceOntoGiftCards",
      "updateGfBalanceCharged",
      "gf-bal-pay-",
    ]) {
      expect(cron, `${moved} must live only in lib/group-balance-charge.ts`).not.toContain(moved);
    }
  });

  it("the extracted module still claims before it charges, and still resumes", () => {
    expect(lib).toContain("claimGfBalanceCharge(quote.id");
    expect(lib).toContain("updateGfBalanceChargeCaptured");
    expect(lib).toContain("square_balance_payment_id && !quote.balance_paid_at");
    // Money captured but fulfilment failed must NOT invite a second payment.
    expect(lib).toContain('do NOT send a "balance due"');
  });

  it("the CRM's charge action goes through the same module", () => {
    const transport = read("src/features/crm/contracts/transport.ts");
    expect(transport).toContain('from "@/lib/group-balance-charge"');
    expect(read("src/features/crm/contracts/service/actions.ts")).toContain(
      "deps.chargeBalanceForQuote(quote",
    );
  });
});

describe("the approval has ONE implementation", () => {
  const v1 = read("app/api/group-function/approve/route.ts");
  const lib = read("lib/group-function-approve.ts");

  it("the v1 route calls approveQuote / denyQuote and keeps its own allowlist", () => {
    expect(v1).toContain('from "@/lib/group-function-approve"');
    expect(v1).toContain("approveQuote(quote, { approverEmail, memo })");
    expect(v1).toContain("denyQuote(quote, { approverEmail, reason: reason! })");
    expect(v1).toContain('const ALLOWED_APPROVERS = ["eric@headpinz.com", "jacob@headpinz.com"]');
  });

  it("the v1 route no longer imports the symbol it never used", () => {
    // `updateGfQuoteDetails` was an unused import; it failed --max-warnings=0
    // and the brief names deleting it as part of this PR.
    expect(v1).not.toContain("updateGfQuoteDetails");
  });

  it("the extracted module keeps every step, in order", () => {
    // Inside `approveQuote`'s body only — the import list at the top names
    // several of these and would satisfy the order test for free.
    const body = lib.slice(lib.indexOf("export async function approveQuote"));
    const steps = [
      "approved_at = NOW()",
      "updateGfContractSent",
      "postpaid_approved",
      "notifyContractSent",
      "noteOnProject(",
      "approval.approved",
    ];
    // …and the note helper really writes a BMI private note.
    expect(lib).toContain("appendProjectPrivateNote");
    let last = -1;
    for (const step of steps) {
      const at = body.indexOf(step);
      expect(at, step).toBeGreaterThan(last);
      last = at;
    }
  });

  it("the CRM approve route never POSTs to the v1 URL and never reads an email from a body", () => {
    const crm = read("app/api/admin/crm/contracts/[shortId]/approve/route.ts");
    // Not "does the file mention the v1 URL" — the header explains WHY it does
    // not use it. It must make no HTTP hop of any kind: it calls the service.
    const code = crm.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("group-function");
    expect(crm).toContain("user.email");
    expect(crm).toContain("director: true");
    const schemas = read("src/features/crm/contracts/schemas.ts");
    expect(schemas).toContain("ApproveBodySchema");
    // The approve body carries a memo and nothing that names a person.
    const approveBody = schemas.slice(schemas.indexOf("ApproveBodySchema"));
    expect(approveBody.slice(0, 200)).not.toMatch(/email|approver/i);
  });
});

describe("no second writer for a BMI project", () => {
  it("the contracts sub writes project state only through setProjectState", () => {
    const actions = read("src/features/crm/contracts/service/actions.ts");
    expect(actions).toContain("deps.setProjectState(");
    expect(actions).not.toContain("putProject(");
    expect(actions).not.toContain("serializeWithRawIds");
    expect(actions).not.toContain("JSON.stringify(project");
  });

  it("and proves the built-in -4 by its OWN re-read", () => {
    const actions = read("src/features/crm/contracts/service/actions.ts");
    expect(actions).toContain("pollProjectState");
    expect(actions).toContain("fetchProjectRawIds");
    expect(actions).toContain("CANCEL_VERIFY_ATTEMPTS = 3");
    expect(actions).toContain("CANCEL_VERIFY_GAP_MS = 1200");
  });
});
