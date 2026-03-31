"use client";

import { useEffect } from "react";
import { useChatAvailable } from "@/hooks/useChatAvailable";

export default function ChatWidgetManager() {
  const agentsOnline = useChatAvailable();

  useEffect(() => {
    const el = document.querySelector("call-us-selector") as HTMLElement | null;
    if (!el) return;

    // Only show the default 3CX widget on desktop (md+) when agents are online
    const mq = window.matchMedia("(min-width: 768px)");
    if (agentsOnline && mq.matches) {
      el.style.setProperty("display", "block", "important");
    } else {
      el.style.setProperty("display", "none", "important");
    }
  }, [agentsOnline]);

  return null;
}
