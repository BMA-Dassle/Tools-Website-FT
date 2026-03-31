import Image from "next/image";

const photos = [
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/gallery/gallery-1.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/racing-2.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/gallery/gallery-2.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/racing-3.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/gallery/gallery-3.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-2.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/gallery/gallery-4.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/attraction-4.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/gallery/gallery-5.webp",
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/racing-5.webp",
];

export default function GalleryStrip() {
  return (
    <section className="bg-[#000418] py-12 overflow-hidden">
      <div className="text-center mb-8 px-4">
        <p className="font-[var(--font-jakarta)] text-[#00E2E5] text-xs font-bold uppercase tracking-[0.3em]">
          See It For Yourself
        </p>
      </div>

      {/* Scrolling strip */}
      <div className="relative flex gap-3 overflow-hidden">
        <div className="flex gap-3 animate-[scroll_40s_linear_infinite] shrink-0">
          {[...photos, ...photos].map((src, i) => (
            <div key={i} className="relative w-48 h-32 md:w-64 md:h-44 shrink-0 rounded-xl overflow-hidden">
              <Image
                src={src}
                alt="FastTrax gallery"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
                sizes="(max-width: 768px) 192px, 256px"
              />
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </section>
  );
}
