import Link from "next/link";

const locations = [
  {
    name: "Fort Myers",
    address: "14513 Global Parkway",
    city: "Fort Myers, FL 33913",
    phone: "(239) 302-2155",
    phoneTel: "+12393022155",
    hours: "Sun-Thu 11AM-12AM, Fri-Sat 11AM-2AM",
    href: "/hp/fort-myers",
    mapUrl:
      "https://www.google.com/maps/search/?api=1&query=14513+Global+Parkway+Fort+Myers+FL+33913",
  },
  {
    name: "Naples",
    address: "8525 Radio Lane",
    city: "Naples, FL 34104",
    phone: "(239) 455-3755",
    phoneTel: "+12394553755",
    hours: "Sun-Thu 11AM-12AM, Fri-Sat 11AM-2AM",
    href: "/hp/naples",
    mapUrl:
      "https://www.google.com/maps/search/?api=1&query=8525+Radio+Lane+Naples+FL+34104",
  },
];

export default function HeadPinzFooter() {
  return (
    <footer className="relative bg-gradient-to-b from-[#0a1628] to-[#0d1a2f] pt-12 pb-8">
      {/* Top accent gradient line */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#fd5b56] via-white/60 to-[#123075]" />
      <div className="max-w-7xl mx-auto px-4">
        {/* Logo + tagline */}
        <div className="text-center mb-10">
          <Link
            href="/hp"
            className="font-heading text-3xl uppercase tracking-widest text-white inline-block"
          >
            HEADPINZ
          </Link>
          <p className="text-white/40 text-sm mt-1 font-body">
            Where Fun Comes Together
          </p>
        </div>

        {/* Locations grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
          {locations.map((loc) => (
            <div
              key={loc.name}
              className="text-center md:text-left space-y-2"
            >
              <h3 className="font-heading text-lg text-[#fd5b56] uppercase tracking-wider">
                {loc.name}
              </h3>
              <p className="text-white/60 text-sm font-body leading-relaxed">
                <a
                  href={loc.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                >
                  {loc.address}
                  <br />
                  {loc.city}
                </a>
              </p>
              <p className="text-white/60 text-sm font-body">
                <a
                  href={`tel:${loc.phoneTel}`}
                  className="hover:text-white transition-colors"
                >
                  {loc.phone}
                </a>
              </p>
              <p className="text-white/40 text-xs font-body">
                {loc.hours}
              </p>
            </div>
          ))}
        </div>

        {/* Social links */}
        <div className="flex items-center justify-center gap-5 mb-8">
          <a
            href="https://www.facebook.com/HeadPinzFortMyers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/40 hover:text-[#fd5b56] transition-colors"
            aria-label="Facebook"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z" />
            </svg>
          </a>
          <a
            href="https://www.instagram.com/headpinz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/40 hover:text-[#fd5b56] transition-colors"
            aria-label="Instagram"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
            </svg>
          </a>
          <a
            href="https://www.youtube.com/@headpinz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/40 hover:text-[#fd5b56] transition-colors"
            aria-label="YouTube"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
          </a>
        </div>

        {/* Contact email */}
        <div className="text-center mb-6">
          <a
            href="mailto:guestservices@headpinz.com"
            className="text-white/40 hover:text-white text-sm font-body transition-colors"
          >
            guestservices@headpinz.com
          </a>
        </div>

        {/* Copyright */}
        <div className="border-t border-white/10 pt-6 flex flex-col sm:flex-row justify-between items-center gap-2 text-xs text-white/30 font-body">
          <p>&copy; 2026 BMA Leisure. All rights reserved.</p>
          <p>
            <a
              href="https://kiosk.bmileisure.com/headpinzftmyers"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/60 transition-colors"
            >
              Waiver
            </a>
            <span className="mx-2">&middot;</span>
            <a
              href="https://bowlandheadpinzfasttrax.applytojob.com/apply"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/60 transition-colors"
            >
              Careers
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
