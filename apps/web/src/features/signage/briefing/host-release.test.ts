import { describe, expect, it } from "vitest";

import { releasesHostOnExit } from "./host-release";

/**
 * Three of these cases are the bug and its two undo paths; the rest are the
 * things that must NOT release. The Mega row is the one worth being loud about:
 * getting it wrong would blank a name off a wall in front of a group still
 * watching the film in the room next door.
 */
describe("releasesHostOnExit", () => {
  it("releases a group pulled in and undone before the film — the reported bug", () => {
    expect(releasesHostOnExit({ sessionId: "60", phase: "waiting", otherRoomSessionIds: [] })).toBe(
      true,
    );
  });

  it("releases an assignment that timed out unstarted", () => {
    expect(releasesHostOnExit({ sessionId: "60", phase: "idle", otherRoomSessionIds: [] })).toBe(
      true,
    );
  });

  it("KEEPS the host once the film is rolling — they briefed this group", () => {
    expect(releasesHostOnExit({ sessionId: "60", phase: "video", otherRoomSessionIds: [] })).toBe(
      false,
    );
  });

  it("KEEPS the host on the helmet board — the film has already played", () => {
    expect(releasesHostOnExit({ sessionId: "60", phase: "helmet", otherRoomSessionIds: [] })).toBe(
      false,
    );
  });

  it("KEEPS the host on a Mega night while the other room still has them", () => {
    expect(
      releasesHostOnExit({ sessionId: "60", phase: "waiting", otherRoomSessionIds: ["60"] }),
    ).toBe(false);
  });

  it("releases when the other room holds a DIFFERENT group", () => {
    expect(
      releasesHostOnExit({
        sessionId: "60",
        phase: "waiting",
        otherRoomSessionIds: ["61", null, undefined],
      }),
    ).toBe(true);
  });

  it("does nothing without a session", () => {
    expect(releasesHostOnExit({ sessionId: null, phase: "waiting", otherRoomSessionIds: [] })).toBe(
      false,
    );
    expect(releasesHostOnExit({ sessionId: "", phase: "idle", otherRoomSessionIds: [] })).toBe(
      false,
    );
  });

  it("compares session ids as the strings they are — no numeric coercion", () => {
    // Pandora ids exceed MAX_SAFE_INTEGER; a == comparison that coerced would
    // fold two distinct 17-digit sessions into one (house rule, CLAUDE.md).
    expect(
      releasesHostOnExit({
        sessionId: "90071992547409931",
        phase: "waiting",
        otherRoomSessionIds: ["90071992547409932"],
      }),
    ).toBe(true);
  });
});
