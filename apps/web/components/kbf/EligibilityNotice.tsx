/**
 * Kids Bowl Free eligibility disclaimer — shared across the KBF landing,
 * register, and book pages so the policy text lives in one place. Per
 * leadership: Kids Bowl Free is for individual families only.
 */
export default function KbfEligibilityNotice() {
  return (
    <section style={{ padding: "0 clamp(16px, 4vw, 32px) clamp(60px, 10vw, 100px)" }}>
      <div
        className="max-w-3xl mx-auto rounded-lg p-6"
        style={{
          backgroundColor: "rgba(7,16,39,0.5)",
          border: "1.78px dashed rgba(255,215,0,0.3)",
        }}
      >
        <h2
          className="font-heading uppercase text-white text-base tracking-wider mb-3"
          style={{ textShadow: "0 0 15px rgba(255,215,0,0.2)" }}
        >
          Individual Families Only
        </h2>
        <p className="font-body text-white/70 text-sm leading-relaxed">
          Kids Bowl Free is for individual families only. It is not valid for youth groups, day
          cares, home school, events, youth camps, birthday parties, or any organized event outside
          of an individual family.
        </p>
      </div>
    </section>
  );
}
