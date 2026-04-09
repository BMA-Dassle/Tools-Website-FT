import Link from "next/link";

export default function HeadPinzNotFound() {
  return (
    <div className="min-h-screen bg-[#0a1628] flex flex-col items-center justify-center text-center px-4">
      <h1
        className="font-heading font-black uppercase text-white mb-4"
        style={{ fontSize: "clamp(80px, 20vw, 200px)", lineHeight: "1", textShadow: "rgba(255,215,0,0.3) 0px 0px 30px" }}
      >
        404
      </h1>
      <h2
        className="font-heading font-black uppercase text-white mb-6"
        style={{ fontSize: "clamp(24px, 5vw, 48px)", lineHeight: "1", letterSpacing: "3px" }}
      >
        Page Not Found
      </h2>
      <p className="font-body text-white/70 text-lg mb-10 max-w-md">
        The page you&apos;re looking for doesn&apos;t exist. Let&apos;s get you back to the fun.
      </p>
      <div className="flex flex-wrap gap-4 justify-center">
        <Link
          href="/"
          className="font-body font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
          style={{ backgroundColor: "#FFD700", color: "#0a1628", borderRadius: "555px", padding: "16px 32px", fontSize: "14px" }}
        >
          Back to HeadPinz
        </Link>
        <Link
          href="/book/bowling"
          className="font-body font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
          style={{ backgroundColor: "rgb(253,91,86)", borderRadius: "555px", padding: "16px 32px", fontSize: "14px" }}
        >
          Book Bowling
        </Link>
      </div>
    </div>
  );
}
