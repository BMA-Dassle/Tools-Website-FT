"use client";

import { useEffect, useState } from "react";

export function useChatAvailable() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    function check() {
      const el = document.querySelector("call-us-selector") as HTMLElement | null;
      if (!el) return;

      // 3CX nests: call-us-selector > shadow > call-us > shadow
      const outerShadow = el.shadowRoot;
      if (!outerShadow) return;

      const innerEl = outerShadow.querySelector("call-us") as HTMLElement | null;
      const shadow = innerEl?.shadowRoot ?? outerShadow;

      // Check for offline indicators in the shadow DOM
      const offlineEl = shadow.querySelector("[class*='offline']");
      const onlineEl = shadow.querySelector("[class*='online']");
      const noAgents = shadow.textContent?.toLowerCase().includes("no agent") ||
                       shadow.textContent?.toLowerCase().includes("offline");

      if (noAgents || offlineEl) {
        setAvailable(false);
      } else if (onlineEl) {
        setAvailable(true);
      } else {
        // Fallback: check if the widget rendered at all with active state
        const hasContent = shadow.querySelector("a, button");
        setAvailable(!!hasContent);
      }
    }

    // Poll since 3CX loads asynchronously and state can change
    const id = setInterval(check, 5000);
    // Initial delayed check to let 3CX load
    const timeout = setTimeout(check, 3000);

    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
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
