"use client";

import { useEffect, useState } from "react";

export function useChatAvailable() {
  // TODO: revert — forced true for testing
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    // TESTING: skip availability check
    return;

    function check() {
      const el = document.querySelector("call-us-selector") as HTMLElement | null;
      if (!el) return;

      // 3CX sets data attributes and shadow DOM state for online/offline
      const shadow = el.shadowRoot;
      if (!shadow) return;

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
  el.style.display = "block";
  const shadow = el.shadowRoot;
  const btn = shadow?.querySelector("a, button, [class*='call']") as HTMLElement | null;
  if (btn) btn.click();
  else el.click();
}
