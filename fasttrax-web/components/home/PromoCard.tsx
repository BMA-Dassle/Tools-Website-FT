"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";

function useCountdown(targetDays: number) {
  const [time, setTime] = useState({ days: targetDays, hours: 23, mins: 59, secs: 59 });

  useEffect(() => {
    const target = new Date();
    target.setDate(target.getDate() + targetDays);
    const tick = setInterval(() => {
      const diff = target.getTime() - Date.now();
      if (diff <= 0) { clearInterval(tick); return; }
      setTime({
        days: Math.floor(diff / 86400000),
        hours: Math.floor((diff % 86400000) / 3600000),
        mins: Math.floor((diff % 3600000) / 60000),
        secs: Math.floor((diff % 60000) / 1000),
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [targetDays]);

  return time;
}

function CountUnit({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center min-w-[3rem]">
      <span className="font-[var(--font-anton)] italic text-white leading-none" style={{ fontSize: "clamp(1.8rem, 5vw, 2.5rem)" }}>
        {String(value).padStart(2, "0")}
      </span>
      <span className="font-[var(--font-jakarta)] text-white/40 text-[10px] uppercase tracking-widest mt-1">
        {label}
      </span>
    </div>
  );
}

export default function PromoCard() {
  const { days, hours, mins, secs } = useCountdown(30);

  return (
    <section className="bg-[#000418] py-14 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="border border-dashed border-[#00E2E5]/40 rounded-2xl overflow-hidden bg-[#071027]">
          <div className="grid md:grid-cols-2 gap-0">
            {/* Left: info */}
            <div className="p-8 md:p-10 flex flex-col justify-between gap-6">
              <div>
                <div className="inline-block bg-[#E53935]/20 text-[#E53935] font-[var(--font-jakarta)] font-bold text-xs uppercase tracking-widest px-3 py-1.5 rounded-full mb-5">
                  Limited Spots Available — This Pass Will Sell Out
                </div>
                <h2
                  className="font-[var(--font-anton)] italic text-white uppercase leading-tight mb-3"
                  style={{ fontSize: "clamp(1.8rem, 4.5vw, 3rem)" }}
                >
                  On The Grid —<br />Spring Break
                </h2>
                <p className="text-[#00E2E5] font-[var(--font-jakarta)] font-bold text-3xl">$124.95</p>
                <p className="text-white/50 text-sm mt-2 font-[var(--font-poppins)]">
                  Unlimited racing access for the entire spring break period.
                </p>
              </div>

              {/* Countdown */}
              <div>
                <p className="font-[var(--font-jakarta)] text-white/35 text-[10px] uppercase tracking-widest mb-3">
                  Offer Expires In
                </p>
                <div className="flex items-center gap-4">
                  <CountUnit value={days} label="Days" />
                  <span className="font-[var(--font-anton)] italic text-white/25 text-2xl pb-3">:</span>
                  <CountUnit value={hours} label="Hours" />
                  <span className="font-[var(--font-anton)] italic text-white/25 text-2xl pb-3">:</span>
                  <CountUnit value={mins} label="Min" />
                  <span className="font-[var(--font-anton)] italic text-white/25 text-2xl pb-3">:</span>
                  <CountUnit value={secs} label="Sec" />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <a
                  href="https://booking.bmileisure.com/headpinzftmyers/book/product-list"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-[#E53935] hover:bg-[#c62828] text-white font-[var(--font-jakarta)] font-bold text-sm px-6 py-3 rounded-full uppercase tracking-wider transition-colors"
                >
                  Book Your Race Now
                </a>
                <Link href="/attractions" className="bg-[#003580] hover:bg-[#004aaa] text-white font-[var(--font-jakarta)] font-bold text-sm px-6 py-3 rounded-full uppercase tracking-wider transition-colors">
                  Explore Combos
                </Link>
              </div>
            </div>

            {/* Right: Spring Break Pass image */}
            <div className="relative min-h-[280px] md:min-h-0">
              <Image
                src="https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/graphics/spring-break-pass.png"
                alt="Spring Break Pass"
                fill
                className="object-cover object-center"
                sizes="(max-width: 768px) 100vw, 50vw"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#071027]/60 to-transparent md:bg-gradient-to-l md:from-transparent md:to-[#071027]/40" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
