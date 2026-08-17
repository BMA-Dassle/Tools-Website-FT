import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { verifyCron } from "./cron-auth";

const req = (auth?: string): NextRequest =>
  new NextRequest("https://x/api/cron/anything", {
    headers: auth ? { authorization: auth } : undefined,
  });

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.CRON_SECRET;
});

describe("verifyCron", () => {
  it("skips on preview deployments", async () => {
    process.env.VERCEL_ENV = "preview";
    try {
      const res = verifyCron(req());
      expect(await res!.json()).toEqual({ ok: true, skipped: "not production" });
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });

  it("401s a wrong or missing bearer when CRON_SECRET is set", () => {
    process.env.CRON_SECRET = "s3cret";
    try {
      expect(verifyCron(req("Bearer nope"))!.status).toBe(401);
      expect(verifyCron(req())!.status).toBe(401);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it("passes a matching bearer", () => {
    process.env.CRON_SECRET = "s3cret";
    try {
      expect(verifyCron(req("Bearer s3cret"))).toBeNull();
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it("passes anything when CRON_SECRET is unset (documents today's fail-open)", () => {
    // Pinned on purpose: any second Vercel project sharing apps/web's root
    // would register vercel.json's crons too, and omitting CRON_SECRET there
    // would NOT stop them (see the note on verifyCron). The staff admin
    // project sidesteps this by living at its own root (apps/admin, no
    // vercel.json) — this pin is the tripwire if that ever changes.
    expect(verifyCron(req())).toBeNull();
  });
});
