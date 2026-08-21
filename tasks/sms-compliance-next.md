# SMS compliance — next step: reply to non-keyword inbound messages

**Status:** planned, not started. Written 2026-08-20.
**Predecessor work:** all landed on `main` (see "What already shipped" below).

---

## The gap

A guest who replies to **239-441-2867** with an ordinary message — "what time do you close?", "can I move
my party?", "wrong number" — **gets nothing back**. The message is captured and parked for a human, but
no acknowledgement is ever sent.

[`apps/web/src/features/sms/inbound-service.ts`](../apps/web/src/features/sms/inbound-service.ts) ends its
`review` branch with:

```ts
await effects.enqueueReview({ … });
return { outcome: "queued_for_review", replied: false, … };
```

[`inbound-replies.ts`](../apps/web/src/features/sms/inbound-replies.ts) exports exactly three bodies —
`optOutConfirmation`, `optInConfirmation`, `helpReply` — and its docstring states "the three replies this
program is allowed to send inbound." **Adding a fourth, and sending it, is the entire job.**

## What already shipped (do not re-plan this)

| Commit | What |
| --- | --- |
| `bd656c867` | every automated message now leaves from the one A2P number — `DEFAULT_A2P_DID = "+12394412867"` in `features/sms/sender.ts` |
| `ee2f6fe8f` | one check, and all 48 send sites honor an opt-out |
| `d63e7a5c6` | a guest who texts STOP is now actually opted out |
| `4166dc62c` | read what a guest actually meant, and say so without acting yet |

Plus: authenticated MO webhook `api/sms-webhook/vox/inbound/route.ts`, payload parser `mo-payload.ts`,
classifier `inbound-keywords.ts`, suppression ledger `suppression-db.ts` / `suppression-policy.ts`,
human review queue `review-queue.ts`.

Sender consolidation is **done**. START/STOP genuinely works. E-tickets, check-in alerts and check-in
videos all send from 239-441-2867. No sender work remains.

## Decisions already taken (owner, 2026-08-20)

- **Support number:** set `SMS_SUPPORT_NUMBER=239-441-2867` in Vercel (all envs). It already feeds
  `supportNumber()` in `inbound-replies.ts` (default `239-481-9666`), so this moves all four replies onto
  one number **with no deploy**. The existing code comment argues for the published cancellation-policy
  number instead; that is overridden by owner decision, and the comment must be updated to record the
  decision rather than left contradicting the value.
- **Who gets the courtesy reply:** everything non-keyword, **including** messages that read like a
  possible revocation ("please stop texting me"). The risk was raised — replying to an apparent
  revocation is the fact pattern that draws a complaint — and the owner decided to reply anyway. Two
  things make that defensible, and both are in the design: the reply carries `Reply STOP to opt out`, so
  it hands the guest the working mechanism, and the item still lands in the human queue at
  `priority: "high"`.
- **The one exception:** a number carrying a **standing** suppression from an earlier STOP gets no
  courtesy reply. That is a revocation already on file, not a judgment call about the current message.

---

## Changes

### 1. `features/sms/inbound-replies.ts` — add a fourth reply

```ts
/**
 * Courtesy acknowledgement for a message we cannot action automatically.
 *
 * Not a compliance reply — (a)(12) governs the opt-out confirmation, not
 * this. It exists because a guest who texts a real question and hears
 * nothing concludes we do not read the number we told them to trust.
 *
 * Carries STOP for the same reason every other body does, and because
 * this reply also goes to messages that READ like a revocation but are
 * too ambiguous to auto-action: handing that guest the working keyword
 * is the most useful thing one message can do.
 */
export function courtesyReply(): string {
  const body =
    `${BRAND}: We got your message, but this line can't take replies. ` +
    `Call us at ${supportNumber()} and we'll help. Reply STOP to opt out.`;
  assertGsm7Safe(body, "sms_courtesy_reply");
  return body;
}
```

136 chars — one segment, matching the existing three. Reuses `BRAND` and `supportNumber()` so the env var
moves all four together.

### 2. `features/sms/inbound-service.ts` — send it

Two new injected effects, matching the file's existing effects-are-injected-so-they-are-testable pattern:

```ts
/** Standing revocation check. NOT the same as this message looking like
 *  an opt-out — that is the classifier's job and does not gate the reply. */
isSuppressed: (phoneE164: string) => Promise<SuppressionState>;
/** One courtesy reply per number per window. Returns false when already
 *  replied recently. Without it, one auto-responder on the other end is
 *  an infinite billed loop. */
claimCourtesySlot: (phoneE164: string) => Promise<boolean>;
```

The `review` branch becomes, **in this order**:

1. `enqueueReview(...)` **first** — the human signal must survive a send failure.
2. If `added === false`, this is a retried Vox callback for a message id already queued → return
   `duplicate_callback`, send nothing. _(Reuses the dedupe `enqueueForReview` already returns; the branch
   currently ignores it, so a retried callback double-queues today — fixed as a side effect.)_
3. `claimCourtesySlot(phone)` false → `replied: false`, reason `throttled`.
4. `isSuppressed(phone).suppressed` true → `replied: false`, reason `standing_optout`.
   On `lookupFailed`, do **not** send — an unknown suppression state is the one case where silence is
   strictly safer, consistent with how `suppression-policy.ts` already reasons about lookup failure.
5. `sendReply(phone, courtesyReply())`.

`InboundResult` gains `courtesySkipped?: "throttled" | "standing_optout" | "lookup_failed"`; the existing
`replyFailed` covers a failed send. `outcome` stays `queued_for_review` — the review semantics did not
change, only whether we also said something.

### 3. `app/api/sms-webhook/vox/inbound/route.ts` — wire the effects

`handleInbound` is called at ~:247 with `{ recordConsent, sendReply, enqueueReview }`. Add:

- `isSuppressed: lookupSuppression` — already exported from `suppression-db.ts:181`.
- `claimCourtesySlot: (p) => redis.set(\`sms:courtesy:${p}\`, "1", "EX", 43200, "NX").then(r => r !== null)`
  — 12h, the `SET NX` idiom already used throughout this repo.

`sendReply` is reused as-is. It deliberately bypasses suppression for the (a)(12) confirmation; step 4
above performs the suppression check before calling it, so that bypass is **not** extended to the
courtesy path.

### 4. Env

`SMS_SUPPORT_NUMBER=239-441-2867` in Vercel, all environments. Takes effect on the existing three replies
immediately, no deploy needed.

---

## Verification

1. `npx vitest run apps/web/src/features/sms` — extend the existing `inbound-replies.test.ts` (GSM-7 +
   one-segment pin, same as the other three) and `inbound-service.test.ts`. New cases:
   - ordinary message → replies
   - repeat within 12h → `throttled`, no send
   - standing opt-out → no send
   - `lookupFailed` → no send
   - retried callback (`enqueueReview` returns `added:false`) → no send
   - revocation-signal message (`priority:"high"`) → **does** reply _and_ still enqueues at high priority
   - STOP / START / HELP paths unchanged
2. Confirm no regression in the three compliance replies after the env change — bodies must stay one
   segment with the 12-char number substituted.
3. `npx turbo run build` once at the end.
4. **On-glass smoke, staff handset only (never a guest's):**
   - "what time do you close" → courtesy reply arrives, item appears in the review queue
   - same message again immediately → no second reply (throttle)
   - "please stop texting me" → reply arrives **and** item queued `priority: high`
   - STOP → opt-out confirmation; then an ordinary message → **no** courtesy reply (standing suppression)
   - START to restore

## Notes

- Work in a worktree off `origin/main` (hard rule). Branch `feat/sms-courtesy-reply`.
- No kill-switch flag. `SMS_SUPPORT_NUMBER` and the Vox portal MO binding are both runtime levers, and
  the review queue keeps working regardless.
