"use client";

import { useEffect, useState } from "react";

export function useChatAvailable() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const res = await fetch("/api/chat-status", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setAvailable(data.available === true);
        }
      } catch {
        // Keep last known state on error
      }
    }

    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  return available;
}

export function openChat() {
  const el = document.querySelector("call-us-selector") as HTMLElement | null;
  if (!el) return;
  el.style.setProperty("display", "block", "important");

  // 3CX nests: call-us-selector > shadow > call-us > shadow > #wplc-chat-button
  const outerShadow = el.shadowRoot;
  if (!outerShadow) return;

  const innerEl = outerShadow.querySelector("call-us") as HTMLElement | null;
  const innerShadow = innerEl?.shadowRoot;
  if (innerShadow) {
    const btn = innerShadow.querySelector("#wplc-chat-button, button, a") as HTMLElement | null;
    if (btn) { btn.click(); return; }
  }

  // Fallback: try the outer shadow
  const btn = outerShadow.querySelector("a, button") as HTMLElement | null;
  if (btn) btn.click();
  else el.click();
}
