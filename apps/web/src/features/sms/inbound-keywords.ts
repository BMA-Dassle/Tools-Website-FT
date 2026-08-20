/**
 * Inbound SMS keyword classifier.
 *
 * Pure and deterministic: message text in, decision out. No I/O, no
 * consent writes, no model call — so it can be pinned by tests, which is
 * the point. A wrong answer here is either a lawsuit (missed opt-out) or a
 * guest who stops getting the ticket that admits them (false positive).
 *
 * ── Why three outcomes and not two ──────────────────────────────────
 *
 * A bare-keyword matcher is required but nowhere near sufficient:
 *
 *  - **T-Mobile Code of Conduct § 2.11** — the keyword opts out "only when
 *    sent as a single word with no punctuation or leading spaces… If the
 *    consumer uses the opt-out keyword within a sentence, then an opt-out
 *    should also be honored." Its worked examples that MUST opt out:
 *    "please stop texting me", "you have the wrong number, stop",
 *    "Stop it!". Its counter-example that must NOT: "I cannot get my
 *    device to stop, can you help?"
 *  - **CTIA Short Code Monitoring Handbook § 3.8.2** — senders must scan
 *    logs and honor opt-outs "regardless of whether the subscribers used
 *    the correct opt-out keywords or methods."
 *  - **47 CFR 64.1200(a)(11)** — any other reasonable expression is a
 *    rebuttable revocation.
 *  - **Fla. Stat. § 501.059(10)(c)** — a missed one starts a 15-day clock,
 *    after which every later text is $500-$1,500.
 *
 * No regex distinguishes "Stop it!" from "I cannot get my device to stop,
 * can you help?" reliably enough to bet money on. So this returns
 * `"review"` for everything it cannot decide, and a human closes the loop.
 * The asymmetry is deliberate: a false negative in the queue costs one
 * guest an SMS they still receive by email; a false negative in the
 * AUTO-OPT-OUT path costs a statutory violation per subsequent message.
 *
 * `"review"` is only safe if the queue is actually worked. `priority:
 * "high"` marks the ones with a real revocation signal.
 */

/** What the caller should do. */
export type InboundAction =
  | "opt_out" // Unambiguous. Safe to action automatically.
  | "opt_in" // Unambiguous re-subscribe.
  | "help" // Send the branded HELP reply (TCR 30890).
  | "review"; // A human decides.

export type ReviewReason =
  | "embedded_opt_out" // Keyword inside a sentence that reads as a request to stop.
  | "opt_out_phrase" // No CTIA keyword, but plain-language revocation.
  | "ambiguous_keyword" // Keyword present, but the message looks like a question for help.
  | "ambiguous_opt_in" // Reads like consent, too weak to manufacture consent from.
  | "unclassified"; // Ordinary inbound message. Nothing matched.

export interface InboundClassification {
  action: InboundAction;
  /** Set when `action === "review"`. */
  reviewReason?: ReviewReason;
  /** Queue ordering. "high" = a real revocation signal a human must see. */
  priority: "high" | "normal";
  /** The token or phrase that drove the decision — shown in the admin
   *  queue so a staffer can see WHY, and asserted in tests. */
  matched: string | null;
  /** Normalized text the decision was made on, for debugging. */
  normalized: string;
}

/**
 * Mandatory CTIA/carrier opt-out keywords plus the ones our own plan
 * commits to. Stored in collapsed form (letters and digits only) so a
 * single comparison absorbs case, punctuation, inner spaces and hyphens:
 * "STOP.", "Stop!", "opt-out", "OPT OUT" and " stop " all collapse to a
 * member of this set.
 *
 * CANCEL is here because it is a mandatory keyword. It is also why this
 * handler must never be attached to the call-center DIDs, where "cancel
 * my 4pm" means the opposite — that isolation is structural, enforced by
 * the separate Voxtelesys Messaging Application, not by this list.
 */
const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "end",
  "quit",
  "cancel",
  "revoke",
  "optout",
  "remove",
]);

/**
 * Auto-honored re-subscribe keywords.
 *
 * Deliberately EXCLUDES "YES", which the original plan listed. A bare
 * "yes" is usually an answer to something else, and the failure is
 * asymmetric: wrongly opting someone OUT delays one message, while
 * wrongly opting someone IN manufactures consent and makes every
 * subsequent send unconsented on a record we forged ourselves. "yes"
 * routes to review as `ambiguous_opt_in`. Overridable — it is a
 * judgement call, not a legal requirement.
 */
const OPT_IN_KEYWORDS = new Set(["start", "unstop", "resume"]);

const HELP_KEYWORDS = new Set(["help", "info"]);

/** Weak-consent tokens: read as intent to opt in, never acted on alone. */
const WEAK_OPT_IN = new Set(["yes", "y", "yeah", "yep", "ok", "okay"]);

/**
 * Plain-language revocations carrying no CTIA keyword. Matched as
 * substrings against the normalized text. `64.1200(a)(11)` makes these
 * revocations; none of them is safe to automate, so they raise priority
 * rather than acting.
 */
const OPT_OUT_PHRASES = [
  "stop texting",
  "stop sending",
  "stop messaging",
  "stop the text",
  "quit texting",
  "no more text",
  "no more message",
  "dont text",
  "do not text",
  "dont message",
  "do not message",
  "take me off",
  "remove me",
  "delete my number",
  "opt me out",
  "unsubscribe me",
  "leave me alone",
  "wrong number",
  "not my number",
  "lose my number",
  "stop contacting",
];

/**
 * Cues that the message is asking FOR help rather than to be left alone —
 * T-Mobile's "I cannot get my device to stop, can you help?" case. When
 * one of these is present alongside an opt-out keyword, the message still
 * goes to review, but without the high-priority flag that would otherwise
 * push a staffer to suppress.
 */
const HELP_SEEKING_CUES = [
  "can you help",
  "can u help",
  "help me",
  "how do i",
  "how can i",
  "cant get",
  "cannot get",
  "wont stop",
  "will not stop",
  "trying to",
  "unable to",
];

/**
 * Normalize for matching. NFKC folds full-width and compatibility forms;
 * zero-width characters are stripped because they are invisible to the
 * guest and would otherwise defeat an exact comparison.
 *
 * Whitespace is collapsed and trimmed, which intentionally makes "STOP "
 * — the trailing-space form of the very first real message we captured —
 * identical to "STOP". T-Mobile § 2.11 says a leading space or
 * punctuation should not defeat an opt-out, so treating them as bare is
 * the compliant reading, not a shortcut.
 */
export function normalizeBody(body: string): string {
  return body
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Letters and digits only — the form keywords are compared in. */
function collapse(normalized: string): string {
  return normalized.replace(/[^a-z0-9]/g, "");
}

/** Word tokens, for substring-free membership checks. */
function tokens(normalized: string): string[] {
  return normalized.split(/[^a-z0-9']+/).filter(Boolean);
}

/**
 * Phrase-matching form: apostrophes removed.
 *
 * The phrase lists are written apostrophe-free ("dont text") so one entry
 * covers every contraction spelling a guest might send — "don't", "don’t"
 * (already folded to a straight quote by `normalizeBody`), and "dont".
 * Enumerating contractions instead would mean the list is only as good as
 * the last person who remembered to extend it, which is how
 * "don't text me anymore" slipped through the first version.
 */
function phraseForm(normalized: string): string {
  return normalized.replace(/'/g, "");
}

function containsAny(normalized: string, needles: string[]): string | null {
  const haystack = phraseForm(normalized);
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

/**
 * Classify one inbound message body.
 *
 * Order matters. Bare keywords are checked first so that an exact "stop"
 * can never be downgraded by a phrase heuristic; only once the message is
 * NOT a bare keyword do the softer signals get a say.
 */
export function classifyInbound(body: string): InboundClassification {
  const normalized = normalizeBody(body);
  const collapsed = collapse(normalized);
  const words = tokens(normalized);

  if (normalized === "") {
    return {
      action: "review",
      reviewReason: "unclassified",
      priority: "normal",
      matched: null,
      normalized,
    };
  }

  // ── 1. Bare keyword. Single word after normalization. ──────────────
  if (OPT_OUT_KEYWORDS.has(collapsed)) {
    return { action: "opt_out", priority: "high", matched: collapsed, normalized };
  }
  if (OPT_IN_KEYWORDS.has(collapsed)) {
    return { action: "opt_in", priority: "normal", matched: collapsed, normalized };
  }
  if (HELP_KEYWORDS.has(collapsed)) {
    return { action: "help", priority: "normal", matched: collapsed, normalized };
  }
  if (WEAK_OPT_IN.has(collapsed)) {
    return {
      action: "review",
      reviewReason: "ambiguous_opt_in",
      priority: "normal",
      matched: collapsed,
      normalized,
    };
  }

  // ── 2. Multi-word. Does it carry a revocation signal? ──────────────
  const helpCue = containsAny(normalized, HELP_SEEKING_CUES);
  const phrase = containsAny(normalized, OPT_OUT_PHRASES);
  const keyword = words.find((w) => OPT_OUT_KEYWORDS.has(w)) ?? null;

  // A help-seeking cue downgrades but never dismisses: "I cannot get my
  // device to stop, can you help?" still reaches a human, just without
  // the flag that says "suppress this one."
  if (helpCue && (phrase || keyword)) {
    return {
      action: "review",
      reviewReason: "ambiguous_keyword",
      priority: "normal",
      matched: phrase ?? keyword,
      normalized,
    };
  }

  // "please stop texting me", "you have the wrong number, stop" —
  // T-Mobile's must-honor examples. High priority, human actions it.
  if (phrase) {
    return {
      action: "review",
      reviewReason: keyword ? "embedded_opt_out" : "opt_out_phrase",
      priority: "high",
      matched: phrase,
      normalized,
    };
  }
  if (keyword) {
    return {
      action: "review",
      reviewReason: "embedded_opt_out",
      priority: "high",
      matched: keyword,
      normalized,
    };
  }

  // HELP inside a sentence is a support request, not a compliance event.
  const helpWord = words.find((w) => HELP_KEYWORDS.has(w)) ?? null;
  if (helpWord) {
    return {
      action: "review",
      reviewReason: "unclassified",
      priority: "normal",
      matched: helpWord,
      normalized,
    };
  }

  return {
    action: "review",
    reviewReason: "unclassified",
    priority: "normal",
    matched: null,
    normalized,
  };
}
