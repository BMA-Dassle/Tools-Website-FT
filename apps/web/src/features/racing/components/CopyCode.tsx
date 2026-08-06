"use client";

import { useState } from "react";

/**
 * The login code, big, with one-tap copy.
 *
 * Typing a 13-character code into a phone keyboard is the friction this
 * removes — it is the same code the licence QR carries, shown large because
 * Activity Box asks the racer to type it rather than scan it.
 *
 * `navigator.clipboard` needs a secure context and can be refused outright, so
 * the fallback is not decoration: without it a guest on an older browser taps a
 * button that silently does nothing.
 */
export default function CopyCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Older browsers and any non-secure context: select-and-execCommand still
      // works where the Clipboard API is unavailable or blocked.
      const el = document.createElement("textarea");
      el.value = code;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing left to try — the code is on screen and readable, which is
        // why it is rendered large rather than hidden behind this button.
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <code className="font-mono text-[#00E2E5] text-lg sm:text-xl tracking-[0.12em] select-all">
        {code}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className="shrink-0 rounded-lg border border-white/20 px-2.5 py-1.5 text-[11px] font-semibold text-white/70 hover:text-white"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}
