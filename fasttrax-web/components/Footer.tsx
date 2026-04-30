"use client";

import Link from "next/link";
import Image from "next/image";
import { useChatAvailable } from "@/hooks/useChatAvailable";

const quickLinks = [
  { label: "Racing", href: "/racing" },
  { label: "Attractions", href: "/attractions" },
  { label: "Racer's Journey", href: "/racing" },
  { label: "Group Events", href: "/group-events" },
  { label: "Pricing", href: "/pricing" },
  { label: "Nemo's Trackside", href: "/menu" },
  { label: "Leaderboards", href: "/leaderboards" },
  { label: "Gift Cards", href: "https://squareup.com/gift/2Z728TECCNWSE/order" },
  { label: "Careers", href: "/careers" },
];

export default function Footer() {
  const agentsOnline = useChatAvailable();

  return (
    <footer className="bg-[#010A20] border-t border-white/10 pt-12 pb-24 md:pb-8">
      <div className="max-w-7xl mx-auto px-4 grid grid-cols-1 md:grid-cols-3 gap-10">
        {/* Brand */}
        <div>
          <Image
            src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/logo/FT_logo.png"
            alt="FastTrax Entertainment"
            width={160}
            height={60}
            className="h-14 w-auto object-contain mb-3"
          />
          <p className="text-white/50 text-sm leading-relaxed">
            Florida&apos;s Largest Indoor Racing Destination
          </p>
          <div className="flex items-center gap-4 mt-5">
            <a href="https://www.facebook.com/FastTraxFM" target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-[#00E2E5] transition-colors" aria-label="Facebook">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>
            </a>
          </div>
        </div>

        {/* Quick Links */}
        <div>
          <h3 className="font-heading font-bold text-lg text-[#00E2E5] uppercase tracking-widest mb-4">Quick Links</h3>
          <ul className="space-y-2">
            {quickLinks.map((l) => (
              <li key={l.label}>
                {l.href.startsWith("http") ? (
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white text-sm transition-colors font-heading">
                    {l.label}
                  </a>
                ) : (
                  <Link href={l.href} className="text-white/50 hover:text-white text-sm transition-colors font-heading">
                    {l.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Connect */}
        <div>
          <h3 className="font-heading font-bold text-lg text-[#00E2E5] uppercase tracking-widest mb-4">Connect</h3>
          <div className="space-y-3 text-sm text-white/60">
            <p className="leading-relaxed">
              14501 Global Parkway<br />
              Fort Myers, FL 33913
            </p>
            <p>
              <a href="tel:+12394819666" className="hover:text-[#00E2E5] transition-colors">(239) 481-9666</a>
            </p>
            <p>
              <a href="mailto:guestservices@headpinz.com" className="hover:text-[#00E2E5] transition-colors">guestservices@headpinz.com</a>
            </p>
            {agentsOnline && (
              <p>
                <a href="sms:+12394819666" className="hover:text-[#00E2E5] transition-colors">Text Us</a>
              </p>
            )}
            <div className="pt-2 text-white/40 text-xs space-y-1">
              <p>Mon–Thu: 3:00 PM – 11:00 PM</p>
              <p>Fri: 3:00 PM – 12:00 AM</p>
              <p>Sat: 11:00 AM – 12:00 AM</p>
              <p>Sun: 11:00 AM – 11:00 PM</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 mt-10 pt-6 border-t border-white/10 flex flex-col sm:flex-row justify-between items-center gap-2 text-xs text-white/30">
        <p>© 2026 Fast Trax FEC LLC. All rights reserved.</p>
        <p>
          <a href="https://kiosk.bmileisure.com/headpinzftmyers" target="_blank" rel="noopener noreferrer" className="hover:text-white/60 transition-colors">Waiver</a>
          <span className="mx-2">·</span>
          <a href="https://bowlandheadpinzfasttrax.applytojob.com/apply" target="_blank" rel="noopener noreferrer" className="hover:text-white/60 transition-colors">Careers</a>
          <span className="mx-2">·</span>
          <Link href="/accessibility" className="hover:text-white/60 transition-colors">Accessibility</Link>
        </p>
      </div>
    </footer>
  );
}
