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

      // Only check visible text, not CSS content from <style> tags
      const visibleText = Array.from(shadow.querySelectorAll("*"))
        .filter((n) => n.tagName !== "STYLE")
        .map((n) => n.textContent)
        .join(" ")
        .toLowerCase();
      const noAgents = visibleText.includes("no agent") || visibleText.includes("offline");

      if (noAgents || offlineEl) {
        setAvailable(false);
      } else if (onlineEl) {
        setAvailable(true);
      } else {
        // Fallback: widget rendered with a clickable button = agents available
        const hasContent = shadow.querySelector("button, a");
        setAvailable(!!hasContent);
      }
    }

    // Poll since 3CX loads asynchronously and state can change
    const id = setInterval(check, 3000);
    // Multiple early checks to catch 3CX loading on slow connections
    const t1 = setTimeout(check, 2000);
    const t2 = setTimeout(check, 4000);
    const t3 = setTimeout(check, 6000);

    return () => {
      clearInterval(id);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
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
