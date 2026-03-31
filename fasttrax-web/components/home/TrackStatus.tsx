export default function TrackStatus() {
  // Static for now — can be made dynamic later
  const tracks = [
    { name: "Red Track", status: "On Time", color: "#E53935", dot: "bg-green-400" },
    { name: "Blue Track", status: "+15m Delay", color: "#00E2E5", dot: "bg-yellow-400" },
  ];

  return (
    <section className="bg-[#010A20] border-y border-white/10 py-4">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-8">
          <span className="font-[var(--font-anton)] italic text-white/40 text-sm uppercase tracking-widest">
            Live Track Status
          </span>
          <div className="flex flex-wrap gap-4">
            {tracks.map((t) => (
              <div
                key={t.name}
                className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                style={{ borderColor: `${t.color}40` }}
              >
                <span className={`w-2 h-2 rounded-full ${t.dot} animate-pulse`} />
                <span className="font-[var(--font-jakarta)] font-semibold text-white text-sm">
                  {t.name}
                </span>
                <span
                  className="font-[var(--font-jakarta)] text-xs font-bold"
                  style={{ color: t.color }}
                >
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
