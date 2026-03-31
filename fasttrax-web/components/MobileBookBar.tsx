export default function MobileBookBar() {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[#000418]/95 backdrop-blur border-t border-white/10 p-3 safe-area-inset-bottom">
      <a
        href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full bg-[#E53935] hover:bg-[#c62828] text-white font-[var(--font-jakarta)] font-bold text-sm py-3.5 rounded-full text-center uppercase tracking-widest transition-colors"
      >
        Book Your Race Now
      </a>
    </div>
  );
}
