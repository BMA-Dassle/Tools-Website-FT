import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { verifyCron } from "./cron-auth";

const req = (auth?: string): NextRequest =>
  new NextRequest("https://x/api/cron/anything", {
    headers: auth ? { authorization: auth } : undefined,
  });

beforeEach(() => {
  delete process.env.ADMIN_DEPLOYMENT;
  delete process.env.VERCEL_ENV;
  delete process.env.CRON_SECRET;
});

describe("verifyCron", () => {
  it("skips on the admin deployment — even with a valid bearer", async () => {
    process.env.ADMIN_DEPLOYMENT = "1";
    process.env.CRON_SECRET = "s3cret";
    try {
      const res = verifyCron(req("Bearer s3cret"));
      expect(res).not.toBeNull();
      expect(await res!.json()).toEqual({ ok: true, skipped: "admin deployment" });
    } finally {
      delete process.env.ADMIN_DEPLOYMENT;
      delete process.env.CRON_SECRET;
    }
  });

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
    // Pinned on purpose: this open door is WHY the admin-deployment guard
    // above exists — omitting CRON_SECRET on the second project would not
    // have stopped its crons.
    expect(verifyCron(req())).toBeNull();
  });
});
