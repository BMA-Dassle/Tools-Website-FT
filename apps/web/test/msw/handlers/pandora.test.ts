import { describe, expect, it } from "vitest";
import { BMI_ID_FIELDS, parseWithRawIds } from "@ft/db";
import { installMsw } from "../server";
import { PANDORA_BASE, PANDORA_PERSON_ID, PANDORA_PROJECT_ID, pandoraHandlers } from "./pandora";

/**
 * Pandora transport: `projectID` (capital D) is NOT in `BMI_ID_FIELDS`, so the
 * default list would leave it to be rounded — the explicit list is the rule
 * (brief §1.2 trap). Negative control included.
 */

installMsw(...pandoraHandlers);

describe("msw: Pandora", () => {
  it("POST party-lead — projectID / personID survive only with the explicit field list", async () => {
    const res = await fetch(`${PANDORA_BASE}/bmi/party-lead`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const text = await res.text();

    // NEGATIVE CONTROLS: JSON.parse rounds; the DEFAULT list misses projectID.
    const naive = JSON.parse(text) as { data: { projectID: number; personID: number } };
    expect(String(naive.data.projectID)).not.toBe(PANDORA_PROJECT_ID);
    const defaults = parseWithRawIds<{ data: { projectID: unknown; personID: unknown } }>(text);
    expect(defaults.data.personID).toBe(PANDORA_PERSON_ID); // personID IS in the default list
    expect(defaults.data.projectID).not.toBe(PANDORA_PROJECT_ID); // projectID is NOT

    const parsed = parseWithRawIds<{
      success: boolean;
      data: {
        projectID: string;
        projectNumber: string;
        personID: string;
        assignedAgent: { name: string };
      };
    }>(text, [...BMI_ID_FIELDS, "projectID"]);
    expect(parsed.success).toBe(true);
    expect(parsed.data.projectID).toBe(PANDORA_PROJECT_ID);
    expect(parsed.data.personID).toBe(PANDORA_PERSON_ID);
    expect(parsed.data.projectNumber).toBe("DH3249");
    expect(parsed.data.assignedAgent.name).toBe("Kelsea Kosco");
  });

  it("POST reservation/state — the built-in-state write answers {success:true}", async () => {
    const res = await fetch(`${PANDORA_BASE}/bmi/reservation/state`, {
      method: "POST",
      body: "{}",
    });
    expect(await res.json()).toEqual({ success: true });
  });
});
