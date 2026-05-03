"use client";

/**
 * ViewPoint POV camera voucher block — purple/coral card with one
 * monospace chip per code, plus the "heads-up sent automatically"
 * banner explaining how the customer redeems them.
 *
 * Originally lived inline at app/book/confirmation/page.tsx:1121-1158.
 * Extracted so the e-ticket pages (/t/[id], /g/[id], and the future
 * HeadPinz mirrors) can render the same UI when a participant has
 * `viewpointCredit > 0` and we auto-claim codes for them via
 * /api/pov-codes?action=claim-from-credit.
 *
 * The visual idiom matches the confirmation page exactly so customers
 * who see codes in both places get a consistent experience. Variant
 * prop swaps the accent for the HeadPinz coral palette where needed.
 */

interface Props {
  codes: string[];
  /** Optional caption under the title. Falls back to a generic
   *  notification heads-up explaining when the redemption email/
   *  SMS arrives. */
  caption?: React.ReactNode;
  /** Theme accent. Defaults to FastTrax purple — matches the existing
   *  confirmation-page card. HeadPinz e-tickets render with `coral`
   *  so the block reads as part of the HP brand instead of FastTrax. */
  variant?: "fasttrax" | "headpinz";
  /** Reissued-from-cache hint shown next to the title. Surfaces the
   *  fact that codes are persistent — refreshing doesn't pop new
   *  ones. Off by default. */
  cached?: boolean;
}

export default function PovVoucherBlock({ codes, caption, variant = "fasttrax", cached = false }: Props) {
  if (!codes || codes.length === 0) return null;

  const palette =
    variant === "headpinz"
      ? {
          card: "border-[#fd5b56]/30 bg-[#fd5b56]/5",
          banner: "border-emerald-400/30 bg-emerald-400/5",
          chip: "border-[#fd5b56]/40",
          chipLabel: "text-[#fd5b56]",
        }
      : {
          card: "border-purple-500/20 bg-purple-500/5",
          banner: "border-emerald-500/30 bg-emerald-500/5",
          chip: "border-purple-500/30",
          chipLabel: "text-purple-300",
        };

  return (
    <div className={`rounded-2xl border ${palette.card} p-6 sm:p-8`}>
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
        <h3 className="font-display text-white text-xl uppercase tracking-widest">Your ViewPoint POV Camera Codes</h3>
        {cached && (
          <span className="text-white/40 text-[11px] uppercase tracking-wider">Reissued</span>
        )}
      </div>

      <div className={`rounded-xl border ${palette.banner} px-4 py-3 mb-3 flex items-start gap-3`}>
        <span aria-hidden="true" className="text-xl leading-none">📨</span>
        <div>
          <p className="text-emerald-300 text-sm font-semibold mb-0.5">
            Heads-up sent automatically
          </p>
          <p className="text-white/60 text-xs leading-relaxed">
            {caption ?? (
              <>
                About 5–10 minutes after your race, you&apos;ll get an{" "}
                <strong className="text-white/80">email and text</strong> letting you know your video is ready. Use
                the codes below to redeem it.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mt-4">
        {codes.map((code, i) => (
          <div key={i} className={`bg-white/10 border ${palette.chip} rounded-lg px-5 py-3`}>
            <p className={`${palette.chipLabel} text-xs font-semibold uppercase tracking-wider mb-1`}>
              Code {i + 1}
            </p>
            <p className="text-white font-mono text-xl font-bold tracking-wider">{code}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
