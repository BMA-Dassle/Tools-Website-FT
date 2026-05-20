import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  getGuestSurveyByToken,
  markGuestSurveyOpened,
  type GuestSurveyQuestion,
} from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import { SurveyForm } from "./SurveyForm";

const HP_BG = "#0a1628";
const HP_LOGO_URL =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/hp-logo.webp";

export const dynamic = "force-dynamic";

interface SurveyPageProps {
  params: Promise<{ token: string }>;
}

export default async function SurveyPage({ params }: SurveyPageProps) {
  const { token } = await params;

  // Token shape sanity — matches the API guards.
  if (!token || token.length < 8 || token.length > 64) {
    notFound();
  }

  const survey = await getGuestSurveyByToken(token);
  if (!survey) notFound();

  const centerName = CENTER_META[survey.centerCode]?.name ?? "HeadPinz";
  const hdrs = await headers();
  const isHeadPinz = hdrs.get("x-brand") === "headpinz";

  if (survey.completedAt) {
    return (
      <BrandShell isHeadPinz={isHeadPinz}>
        <ThanksAlreadyPanel centerName={centerName} />
      </BrandShell>
    );
  }
  if (new Date(survey.expiresAt) <= new Date()) {
    return (
      <BrandShell isHeadPinz={isHeadPinz}>
        <ExpiredPanel centerName={centerName} />
      </BrandShell>
    );
  }

  // First-open: stamp + record touch (best-effort, mirrors API GET behavior
  // so direct page visits also feed the funnel).
  if (!survey.openedAt) {
    Promise.all([
      markGuestSurveyOpened(token),
      recordTouch({
        customerId: survey.squareCustomerId,
        phoneE164: survey.phoneE164,
        campaign: "guest_survey",
        event: "opened",
        refId: token,
      }),
    ]).catch((err) => console.warn(`[survey/${token}] open-touch failed:`, err));
  }

  return (
    <BrandShell isHeadPinz={isHeadPinz}>
      <SurveyForm
        token={token}
        centerName={centerName}
        questions={survey.questions as GuestSurveyQuestion[]}
      />
    </BrandShell>
  );
}

/**
 * Wraps the survey content in a minimal brand bar.
 *
 * Earlier attempts mounted the full HeadPinzNav (location selector,
 * hours strip, hamburger menu, glass-blur overlay) — too much chrome
 * for a focused survey, and the glass overlay made the form content
 * underneath look broken (blurred text bleeding through). The right
 * answer for a single-purpose customer-flow page is brand identity
 * (logo) without the full site navigation.
 *
 * For FastTrax (future racing surveys) the FT brand bar will follow
 * the same minimal pattern when PR-GS4 lands.
 */
function BrandShell({ isHeadPinz, children }: { isHeadPinz: boolean; children: React.ReactNode }) {
  if (!isHeadPinz) {
    return <>{children}</>;
  }
  return (
    <>
      <SurveyBrandBar />
      {children}
      <SurveyBrandFooter />
    </>
  );
}

function SurveyBrandBar() {
  return (
    <header
      className="w-full"
      style={{
        backgroundColor: HP_BG,
        paddingTop: "max(env(safe-area-inset-top), 12px)",
      }}
    >
      <div className="w-full max-w-md mx-auto px-4 py-3 flex items-center justify-center">
        <Link href="https://headpinz.com" aria-label="HeadPinz home" className="inline-flex">
          <Image
            src={HP_LOGO_URL}
            alt="HeadPinz"
            width={160}
            height={48}
            className="h-10 w-auto object-contain"
            unoptimized
            priority
          />
        </Link>
      </div>
    </header>
  );
}

function SurveyBrandFooter() {
  return (
    <footer
      className="w-full text-center text-xs"
      style={{
        backgroundColor: HP_BG,
        color: "rgba(255,255,255,0.5)",
        paddingTop: "16px",
        paddingBottom: "max(env(safe-area-inset-bottom), 16px)",
      }}
    >
      <p className="px-4">
        HeadPinz Entertainment ·{" "}
        <Link href="https://headpinz.com" className="underline hover:text-white">
          headpinz.com
        </Link>
      </p>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────
// Terminal panels (server-rendered, no client JS)
// ─────────────────────────────────────────────────────────────────

function ShellWrap({ children }: { children: React.ReactNode }) {
  // BrandBar above handles notch padding — keep this lean.
  return (
    <main
      className="text-white font-body"
      style={{ backgroundColor: HP_BG, paddingBottom: "32px" }}
    >
      <div className="w-full max-w-md mx-auto px-4 pt-4">{children}</div>
    </main>
  );
}

function ThanksAlreadyPanel({ centerName }: { centerName: string }) {
  return (
    <ShellWrap>
      <h1 className="font-heading text-3xl font-bold mb-3">Thanks!</h1>
      <p className="text-white/80 leading-relaxed">
        You&apos;ve already submitted this survey. We appreciate the feedback — see you at{" "}
        {centerName} soon!
      </p>
    </ShellWrap>
  );
}

function ExpiredPanel({ centerName }: { centerName: string }) {
  return (
    <ShellWrap>
      <h1 className="font-heading text-3xl font-bold mb-3">This survey has expired</h1>
      <p className="text-white/80 leading-relaxed">
        Survey links are valid for 7 days. Thanks anyway — hope to see you back at {centerName}{" "}
        soon.
      </p>
    </ShellWrap>
  );
}
