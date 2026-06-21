import { createHash, randomInt, timingSafeEqual } from "crypto";
import redis from "@/lib/redis";
import {
  CODE_TTL_SEC,
  LOCKOUT_TTL_SEC,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_SEC,
  SEND_PER_CONTACT_PER_HOUR,
  SEND_PER_IP_PER_HOUR,
} from "../constants";

const PEPPER = process.env.ACCOUNT_OTP_PEPPER || "";

/** Codes are stored hashed+peppered (never raw) so a Redis dump leaks nothing live. */
function hashCode(code: string): string {
  return createHash("sha256").update(`${code}.${PEPPER}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateCode(): string {
  return String(randomInt(100000, 1000000)); // 100000–999999 inclusive
}

const otpKey = (k: string) => `acct:otp:${k}`;
const lockKey = (k: string) => `acct:otp:lock:${k}`;
const cooldownKey = (k: string) => `acct:otp:cooldown:${k}`;
const sendKey = (k: string) => `acct:otp:send:${k}`;
const ipKey = (ip: string) => `acct:otp:ip:${ip}`;

export async function storeOtp(contactKey: string, code: string): Promise<void> {
  await redis.set(
    otpKey(contactKey),
    JSON.stringify({ codeHash: hashCode(code), attempts: 0 }),
    "EX",
    CODE_TTL_SEC,
  );
}

export type ReserveResult = { blocked: true; retryAfterSec: number } | { blocked: false };

/**
 * Abuse mitigation before sending a code: respects an active lockout, a 60s
 * resend cooldown, a per-contact hourly cap, and a per-IP hourly cap. Records
 * the send (counters + cooldown) when allowed.
 */
export async function reserveSend(contactKey: string, ip: string): Promise<ReserveResult> {
  const lockTtl = await redis.ttl(lockKey(contactKey));
  if (lockTtl > 0) return { blocked: true, retryAfterSec: lockTtl };

  const cdTtl = await redis.ttl(cooldownKey(contactKey));
  if (cdTtl > 0) return { blocked: true, retryAfterSec: cdTtl };

  const contactCount = await redis.incr(sendKey(contactKey));
  if (contactCount === 1) await redis.expire(sendKey(contactKey), 3600);
  if (contactCount > SEND_PER_CONTACT_PER_HOUR) {
    const ttl = await redis.ttl(sendKey(contactKey));
    return { blocked: true, retryAfterSec: ttl > 0 ? ttl : 3600 };
  }

  const ipCount = await redis.incr(ipKey(ip));
  if (ipCount === 1) await redis.expire(ipKey(ip), 3600);
  if (ipCount > SEND_PER_IP_PER_HOUR) {
    const ttl = await redis.ttl(ipKey(ip));
    return { blocked: true, retryAfterSec: ttl > 0 ? ttl : 3600 };
  }

  await redis.set(cooldownKey(contactKey), "1", "EX", RESEND_COOLDOWN_SEC);
  return { blocked: false };
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "incorrect" | "locked"; attemptsLeft: number };

/** Verify (and on success, single-use consume) a submitted code. */
export async function consumeOtp(contactKey: string, code: string): Promise<ConsumeResult> {
  if ((await redis.ttl(lockKey(contactKey))) > 0) {
    return { ok: false, reason: "locked", attemptsLeft: 0 };
  }

  const raw = await redis.get(otpKey(contactKey));
  if (!raw) return { ok: false, reason: "expired", attemptsLeft: 0 };

  let parsed: { codeHash: string; attempts: number };
  try {
    parsed = JSON.parse(raw);
  } catch {
    await redis.del(otpKey(contactKey));
    return { ok: false, reason: "expired", attemptsLeft: 0 };
  }

  if (parsed.attempts >= MAX_VERIFY_ATTEMPTS) {
    await lockOut(contactKey);
    return { ok: false, reason: "locked", attemptsLeft: 0 };
  }

  if (safeEqualHex(parsed.codeHash, hashCode(code))) {
    await redis.del(otpKey(contactKey));
    return { ok: true };
  }

  const attempts = parsed.attempts + 1;
  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    await lockOut(contactKey);
    return { ok: false, reason: "locked", attemptsLeft: 0 };
  }
  const ttl = await redis.ttl(otpKey(contactKey));
  await redis.set(
    otpKey(contactKey),
    JSON.stringify({ codeHash: parsed.codeHash, attempts }),
    "EX",
    ttl > 0 ? ttl : CODE_TTL_SEC,
  );
  return { ok: false, reason: "incorrect", attemptsLeft: MAX_VERIFY_ATTEMPTS - attempts };
}

async function lockOut(contactKey: string): Promise<void> {
  await redis.del(otpKey(contactKey));
  await redis.set(lockKey(contactKey), "1", "EX", LOCKOUT_TTL_SEC);
}
