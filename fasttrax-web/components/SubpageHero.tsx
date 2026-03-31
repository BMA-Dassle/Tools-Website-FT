import Image from "next/image";

interface SubpageHeroProps {
  title: string;
  backgroundImage: string;
}

export default function SubpageHero({ title, backgroundImage }: SubpageHeroProps) {
  return (
    <section className="relative overflow-hidden" style={{ height: "575px" }}>
      <Image
        src={backgroundImage}
        alt={title}
        fill
        className="object-cover object-center"
        sizes="100vw"
        priority
        quality={90}
        unoptimized
      />
      {/* No overlay - live site has none */}
      <div className="relative z-10 flex items-center justify-center px-8" style={{ height: "575px" }}>
        <h1
          className="font-[var(--font-anton)] italic uppercase text-white text-center"
          style={{ fontSize: "clamp(3rem, 8vw, 100px)", fontWeight: 600, lineHeight: "1.25", letterSpacing: "3.4px" }}
        >
          {title}
        </h1>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
    </section>
  );
}
