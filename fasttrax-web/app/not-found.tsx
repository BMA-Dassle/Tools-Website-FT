import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#000418] flex flex-col items-center justify-center text-center px-4">
      <h1
        className="font-heading italic uppercase text-white mb-4"
        style={{ fontSize: "clamp(80px, 20vw, 200px)", lineHeight: "1", textShadow: "rgba(229,0,0,0.48) 0px 0px 30px" }}
      >
        404
      </h1>
      <h2
        className="font-heading italic uppercase text-white mb-6"
        style={{ fontSize: "clamp(24px, 5vw, 48px)", lineHeight: "1", letterSpacing: "3px" }}
      >
        Wrong Turn, Racer
      </h2>
      <p className="font-body text-white/70 text-lg mb-10 max-w-md">
        Looks like you took a detour off the track. Let&apos;s get you back to the action.
      </p>
      <div className="flex flex-wrap gap-4 justify-center">
        <Link
          href="/"
          className="font-body font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
          style={{ backgroundColor: "rgb(228,28,29)", borderRadius: "555px", padding: "16px 32px", fontSize: "14px" }}
        >
          Back to Home
        </Link>
        <Link
          href="/racing"
          className="font-body font-bold uppercase text-white tracking-wider transition-all hover:scale-105"
          style={{ backgroundColor: "rgb(0,74,173)", borderRadius: "555px", padding: "16px 32px", fontSize: "14px" }}
        >
          Book a Race
        </Link>
      </div>
    </div>
  );
}
