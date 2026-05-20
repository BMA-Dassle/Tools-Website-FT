"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActivityOffering, Brand } from "~/features/booking";
import type { AppliedPromo } from "~/features/discount-codes";

/**
 * Promo-aware booking landing — client island.
 *
 * Server component (`page.tsx`) does the initial code resolution +
 * tile filtering. This island handles:
 *   - Manual code input (when no `?code=` URL seed)
 *   - Re-validate on submit (calls `/api/booking/v2/promo`)
 *   - "Continue without code" toggle to show full offerings list
 *   - Routing to `/book/<slug>/v2` (with `?code=` carried through)
 *
 * Visual styling matches the dark booking theme set in
 * `app/globals.css` (#000418 body bg + cyan #00E2E5 CTAs + bg-white/N
 * card chrome). Brand-aware font cascade via the `brand-fasttrax` /
 * `brand-headpinz` class wrapper.
 */
export interface PromoLandingProps {
  entryBrand: Brand;
  seedCode: string;
  seededPromo: AppliedPromo | null;
  seedRejected: boolean;
  initialOfferings: ActivityOffering[];
  allOfferings: ActivityOffering[];
}

export function PromoLanding({
  entryBrand,
  seedCode,
  seededPromo,
  seedRejected,
  initialOfferings,
  allOfferings,
}: PromoLandingProps) {
  const router = useRouter();
  const brandClass = entryBrand === "fasttrax" ? "brand-fasttrax" : "brand-headpinz";

  const [input, setInput] = useState(seedCode);
  const [applied, setApplied] = useState<AppliedPromo | null>(seededPromo);
  const [offerings, setOfferings] = useState<ActivityOffering[]>(initialOfferings);
  const [rejected, setRejected] = useState(seedRejected);
  const [showAll, setShowAll] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const visibleOfferings = showAll ? allOfferings : offerings;

  async function submitCode(e?: React.FormEvent) {
    e?.preventDefault();
    const code = input.trim().toUpperCase();
    if (!code) {
      setApplied(null);
      setRejected(false);
      setOfferings(allOfferings);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/booking/v2/promo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.valid && data.promo) {
        const promo: AppliedPromo = data.promo;
        setApplied(promo);
        setRejected(false);
        setShowAll(false);
        // Filter offerings client-side using the catalog helper would
        // require a server round-trip; the server-supplied initialOfferings
        // matches what the server would compute. For client-side recompute
        // we'd inline the filter — kept simple by re-fetching once via the
        // server: just push to /book/v2?code=X to refresh the tile list.
        router.replace(`/book/v2?code=${encodeURIComponent(code)}`);
      } else {
        setApplied(null);
        setRejected(true);
      }
    } catch (err) {
      console.error("[promo-landing] validate failed:", err);
      setApplied(null);
      setRejected(true);
    } finally {
      setSubmitting(false);
    }
  }

  function clearCode() {
    setInput("");
    setApplied(null);
    setRejected(false);
    setShowAll(false);
    setOfferings(allOfferings);
    router.replace("/book/v2");
  }

  function tileHref(slug: string): string {
    return applied
      ? `/book/${slug}/v2?code=${encodeURIComponent(applied.code)}`
      : `/book/${slug}/v2`;
  }

  return (
    <section className={`${brandClass} mx-auto max-w-3xl p-4 sm:p-6`}>
      <div className="text-center">
        <h1 className="font-display text-3xl uppercase tracking-widest text-white sm:text-4xl">
          What are we booking?
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Pick an activity to get started. Have a promo code? Drop it below first.
        </p>
      </div>

      {/* Promo input */}
      <form
        onSubmit={submitCode}
        className="mx-auto mt-6 flex w-full max-w-md flex-wrap items-end gap-2"
      >
        <label className="min-w-[10rem] flex-1">
          <span className="block text-xs uppercase tracking-wider text-white/40">Promo code</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="MAY20WEEKDAY"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm uppercase text-white placeholder-white/30 tracking-wider focus:border-[#00E2E5]/60 focus:bg-white/10 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={submitting || input.trim() === (applied?.code ?? "")}
          className="rounded-xl bg-[#00E2E5] px-5 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "…" : applied ? "Update" : "Apply"}
        </button>
      </form>

      {/* Applied / rejected feedback */}
      {applied && (
        <div className="mx-auto mt-3 flex max-w-md items-center justify-between gap-3 rounded-lg border border-[#00E2E5]/30 bg-[#00E2E5]/10 px-4 py-2 text-sm">
          <div className="text-[#00E2E5]">
            <span className="font-semibold">{applied.code}</span> applied —{" "}
            {applied.mechanic === "percent" && applied.amountPct != null
              ? `${applied.amountPct}% off`
              : applied.mechanic === "fixed" && applied.amountCents != null
                ? `$${(applied.amountCents / 100).toFixed(2)} off`
                : ""}
          </div>
          <button
            type="button"
            onClick={clearCode}
            className="text-xs text-[#00E2E5]/70 transition-colors hover:text-[#00E2E5]"
          >
            Clear
          </button>
        </div>
      )}
      {rejected && !applied && (
        <p className="mx-auto mt-3 max-w-md text-center text-sm text-amber-400/80">
          We couldn&apos;t apply that code. It may be expired, fully used, or for a different
          activity. Pick an option below to continue without it.
        </p>
      )}

      {/* Offerings */}
      <div className="mt-8">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[#00E2E5]">
          {applied ? "Eligible activities" : "Pick an activity"}
        </h2>
        {visibleOfferings.length === 0 ? (
          <p className="mt-4 rounded-xl border border-white/10 bg-white/3 p-6 text-center text-sm text-white/50">
            Your code doesn&apos;t match any of our current activities.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {visibleOfferings.map((o) => (
              <li key={o.slug}>
                <Link
                  href={tileHref(o.slug)}
                  className="block rounded-lg border border-white/10 bg-white/3 p-4 transition-all hover:border-white/20 hover:bg-white/6"
                >
                  <div className="text-sm font-semibold text-white">{o.displayName}</div>
                  <div className="mt-0.5 text-xs text-white/40">{o.blurb}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {applied && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-4 text-xs text-white/40 underline-offset-4 transition-colors hover:text-white/70 hover:underline"
          >
            Browse everything instead — your code stays applied where it&apos;s valid.
          </button>
        )}
        {applied && showAll && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="mt-4 text-xs text-white/40 underline-offset-4 transition-colors hover:text-white/70 hover:underline"
          >
            Show only eligible activities
          </button>
        )}
      </div>
    </section>
  );
}
