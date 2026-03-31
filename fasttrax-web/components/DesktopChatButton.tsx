"use client";

import { useChatAvailable, openChat } from "@/hooks/useChatAvailable";

export default function DesktopChatButton() {
  const chatAvailable = useChatAvailable();

  if (!chatAvailable) return null;

  return (
    <button
      onClick={openChat}
      className="hidden md:flex fixed bottom-6 right-6 z-50 items-center gap-2 bg-[#00E2E5] hover:bg-[#00c8cb] text-[#000418] font-[var(--font-poppins)] font-bold text-sm py-3 px-5 rounded-full shadow-lg shadow-[#00E2E5]/20 transition-all hover:scale-105 cursor-pointer"
      aria-label="Live Chat"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
      Live Chat
    </button>
  );
}
