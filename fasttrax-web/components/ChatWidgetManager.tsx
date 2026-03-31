"use client";

import { useEffect } from "react";
import { useChatAvailable } from "@/hooks/useChatAvailable";

export default function ChatWidgetManager() {
  const agentsOnline = useChatAvailable();

  useEffect(() => {
    const el = document.querySelector("call-us-selector") as HTMLElement | null;
    if (!el) return;

    // Show the 3CX floating widget only on desktop when agents are online.
    // On mobile, we hide it visually but keep it in DOM so shadow DOM initializes
    // (useChatAvailable reads the shadow DOM to detect agent status for MobileBookBar).
    const mq = window.matchMedia("(min-width: 768px)");
    if (agentsOnline && mq.matches) {
      el.style.setProperty("display", "block", "important");
      el.style.removeProperty("visibility");
      el.style.removeProperty("position");
    } else {
      // Off-screen but still in DOM so shadow DOM renders
      el.style.setProperty("position", "absolute", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("display", "block", "important");
    }
  }, [agentsOnline]);

  return null;
}
