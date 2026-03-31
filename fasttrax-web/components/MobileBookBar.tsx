"use client";

import { useChatAvailable, openChat } from "@/hooks/useChatAvailable";

export default function MobileBookBar() {
  const chatAvailable = useChatAvailable();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[#000418]/95 backdrop-blur border-t border-white/10 p-3 safe-area-inset-bottom">
      <div className="flex gap-2">
        <a
          href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 block bg-[#E53935] hover:bg-[#c62828] text-white font-[var(--font-poppins)] font-bold text-sm py-3.5 rounded-full text-center uppercase tracking-widest transition-colors"
        >
          Book Now
        </a>
        {chatAvailable && (
          <button
            onClick={openChat}
            className="flex items-center justify-center gap-1.5 bg-[#071027] hover:bg-[#0d1a3a] text-white font-[var(--font-poppins)] font-bold text-sm py-3.5 px-4 rounded-full uppercase tracking-widest transition-colors border border-white/10"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Chat
          </button>
        )}
      </div>
    </div>
  );
}
