/**
 * Kids Bowl Free eligibility disclaimer. The text lives here as shared
 * constants so every surface (KBF landing, register, book pages, and the
 * booking wizard) renders the exact same policy. Per leadership: Kids Bowl
 * Free is for individual families only.
 */

export const KBF_ELIGIBILITY_HEADING = "Individual Families Only";

export const KBF_ELIGIBILITY_TEXT =
  "Kids Bowl Free is for individual families only. It is not valid for youth groups, day cares, " +
  "home school, events, youth camps, birthday parties, or any organized event outside of an " +
  "individual family.";

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
          {KBF_ELIGIBILITY_HEADING}
        </h2>
        <p className="font-body text-white/70 text-sm leading-relaxed">{KBF_ELIGIBILITY_TEXT}</p>
      </div>
    </section>
  );
}
