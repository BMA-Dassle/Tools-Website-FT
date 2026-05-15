"use client";

import { useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

// ── Types ──────────────────────────────────────────────────────────────────

export type ResendChannel = "sms" | "email" | "both";

export interface AdminResendModalProps {
  /** Modal title, e.g. "Resend e-ticket" or "Resend video". */
  title: string;
  /** Which channels the modal offers. */
  channels: ResendChannel[];
  /** Default channel selection. */
  defaultChannel: ResendChannel;
  /** Original phone on file (null → force "Different number"). */
  originalPhone?: string | null;
  /** Original email on file (null → force "Different email"). */
  originalEmail?: string | null;
  /** Force "different" mode even when originals exist (e.g. no-consent). */
  forceNew?: boolean;
  /** Called with resolved destinations when the user clicks Send. */
  onSend: (opts: {
    channel: ResendChannel;
    phone: string | null;
    email: string | null;
  }) => Promise<string>;
  onClose: () => void;
  /** Optional alert banner rendered above the form (e.g. consent script). */
  alertBanner?: React.ReactNode;
  /** Optional context section rendered below the title (e.g. racer info). */
  contextSection?: React.ReactNode;
  /** Optional body preview text shown in a <pre> block. */
  bodyPreview?: string | null;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function AdminResendModal({
  title,
  channels,
  defaultChannel,
  originalPhone,
  originalEmail,
  forceNew = false,
  onSend,
  onClose,
  alertBanner,
  contextSection,
  bodyPreview,
}: AdminResendModalProps) {
  const [channel, setChannel] = useState<ResendChannel>(defaultChannel);
  const hasOriginalPhone = !!originalPhone && !forceNew;
  const hasOriginalEmail = !!originalEmail && !forceNew;

  const [phoneMode, setPhoneMode] = useState<"same" | "new">(hasOriginalPhone ? "same" : "new");
  const [emailMode, setEmailMode] = useState<"same" | "new">(hasOriginalEmail ? "same" : "new");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const showPhone = channel === "sms" || channel === "both";
  const showEmail = channel === "email" || channel === "both";

  async function submit() {
    setSending(true);
    setErr(null);
    try {
      // Resolve phone — normalize to E.164 (+1XXXXXXXXXX) so every
      // downstream API gets a consistent format regardless of what
      // the user typed or what was stored on file.
      let destPhone: string | null = null;
      if (showPhone) {
        const raw = phoneMode === "same" ? originalPhone || "" : phone.trim();
        if (!raw) {
          throw new Error(
            phoneMode === "same"
              ? "No phone on file. Switch to 'Different number' and enter one."
              : "Enter a phone number.",
          );
        }
        const digits = raw.replace(/\D/g, "");
        if (digits.length === 10) {
          destPhone = `+1${digits}`;
        } else if (digits.length === 11 && digits.startsWith("1")) {
          destPhone = `+${digits}`;
        } else {
          throw new Error("Enter 10 digits (area code + number), or 11 starting with 1.");
        }
      }

      // Resolve email
      let destEmail: string | null = null;
      if (showEmail) {
        if (emailMode === "same") {
          destEmail = originalEmail || null;
          if (!destEmail)
            throw new Error("No email on file. Switch to 'Different email' and enter one.");
        } else {
          destEmail = email.trim();
          if (!destEmail) throw new Error("Enter an email address.");
        }
      }

      const msg = await onSend({ channel, phone: destPhone, email: destEmail });
      onClose();
      // msg is handled by the parent (toast/flash)
      void msg;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setSending(false);
    }
  }

  // Disable Send when the required destination is empty
  const sendDisabled =
    sending ||
    (() => {
      if (showPhone) {
        if (phoneMode === "same" && !originalPhone) return true;
        if (phoneMode === "new" && !phone.trim()) return true;
      }
      if (showEmail) {
        if (emailMode === "same" && !originalEmail) return true;
        if (emailMode === "new" && !email.trim()) return true;
      }
      return false;
    })();

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 bg-black/80"
      style={{ height: "100dvh" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-lg rounded-xl"
        style={{
          backgroundColor: "#0a1128",
          border: "1.78px solid rgba(255,255,255,0.1)",
          maxHeight: "calc(100dvh - 1.5rem)",
          overflowY: "auto",
        }}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          &times;
        </button>

        <div className="p-5 sm:p-6">
          {/* Title */}
          <h3 className="text-lg font-bold uppercase tracking-wide mb-3 pr-10">{title}</h3>

          {/* Alert banner (e.g. consent script) */}
          {alertBanner}

          {/* Context section (e.g. racer info, reservation details) */}
          {contextSection}

          {/* Channel picker — only if more than one channel offered */}
          {channels.length > 1 && (
            <div className="mb-3">
              <div className="text-xs text-white/60 mb-1">Channel</div>
              <div className="flex gap-2">
                {channels.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${
                      channel === c
                        ? "bg-[#00E2E5] border-[#00E2E5] text-[#000418]"
                        : "border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10"
                    }`}
                  >
                    {c === "both" ? "BOTH" : c.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Phone destination */}
          {showPhone && (
            <fieldset className="mb-3">
              <legend className="text-xs text-white/60 mb-1.5">
                {showEmail ? "Send SMS to" : "Send to"}
              </legend>
              <div className="flex flex-col gap-2">
                {hasOriginalPhone && (
                  <label className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                    <input
                      type="radio"
                      name="phoneMode"
                      value="same"
                      checked={phoneMode === "same"}
                      onChange={() => setPhoneMode("same")}
                      className="accent-[#00E2E5]"
                    />
                    <span>
                      Same number <span className="font-mono text-white/60">{originalPhone}</span>
                    </span>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                    <input
                      type="radio"
                      name="phoneMode"
                      value="new"
                      checked={phoneMode === "new"}
                      onChange={() => setPhoneMode("new")}
                      className="accent-[#00E2E5]"
                    />
                    Different number
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onFocus={() => setPhoneMode("new")}
                    disabled={phoneMode !== "new"}
                    className="ml-6 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                    placeholder="2395551234"
                  />
                  {phoneMode === "new" && (
                    <span className="ml-6 text-[11px] text-white/40">
                      10 digits, or 11 starting with 1
                    </span>
                  )}
                </label>
              </div>
            </fieldset>
          )}

          {/* Email destination */}
          {showEmail && (
            <fieldset className="mb-3">
              <legend className="text-xs text-white/60 mb-1.5">
                {showPhone ? "Send email to" : "Send to"}
              </legend>
              <div className="flex flex-col gap-2">
                {hasOriginalEmail && (
                  <label className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                    <input
                      type="radio"
                      name="emailMode"
                      value="same"
                      checked={emailMode === "same"}
                      onChange={() => setEmailMode("same")}
                      className="accent-[#00E2E5]"
                    />
                    <span>
                      Same email <span className="text-white/60">{originalEmail}</span>
                    </span>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                    <input
                      type="radio"
                      name="emailMode"
                      value="new"
                      checked={emailMode === "new"}
                      onChange={() => setEmailMode("new")}
                      className="accent-[#00E2E5]"
                    />
                    Different email
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setEmailMode("new")}
                    disabled={emailMode !== "new"}
                    className="ml-6 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    placeholder="guest@example.com"
                  />
                </label>
              </div>
            </fieldset>
          )}

          {/* Body preview */}
          {bodyPreview != null && (
            <>
              <div className="text-xs text-white/60 mb-1">Preview</div>
              <pre
                className="text-xs bg-black/40 rounded border border-white/10 p-3 whitespace-pre-wrap font-sans text-white/80 mb-4"
                style={{ maxHeight: "180px", overflow: "auto" }}
              >
                {bodyPreview || "(no body)"}
              </pre>
            </>
          )}

          {/* Error */}
          {err && <div className="text-xs text-red-400 mb-3">{err}</div>}

          {/* Actions */}
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="text-sm px-4 py-3 sm:py-2 rounded border border-white/20 text-white/70 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={sendDisabled}
              className="text-sm px-5 py-3 sm:py-2 rounded bg-[#00E2E5] text-[#000418] font-bold hover:bg-white disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
