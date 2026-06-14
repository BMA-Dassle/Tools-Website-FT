import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  getGuestSurveyByToken,
  markGuestSurveyOpened,
  type GuestSurveyQuestion,
} from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import HeadPinzNav from "@/components/headpinz/Nav";
import HeadPinzFooter from "@/components/headpinz/Footer";
import { SurveyForm } from "./SurveyForm";

const HP_BG = "#0a1628";

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

  // Racing surveys are FastTrax-branded; bowling stays HeadPinz. The page
  // serves on both domains (see middleware isSharedTopLevelRoute), so brand
  // off the survey ORIGIN, not the host — a racing survey link opened on
  // headpinz.com still renders FastTrax, and vice-versa.
  const isRacing = survey.origin === "racing";
  const centerName = CENTER_META[survey.centerCode]?.name ?? (isRacing ? "FastTrax" : "HeadPinz");
  const hdrs = await headers();
  // HeadPinz chrome (HP Nav/Footer added by this page) applies to bowling
  // only. For FastTrax racing the root layout already renders the FT
  // Nav/Footer, so BrandShell falls through to bare children.
  const isHeadPinz = hdrs.get("x-brand") === "headpinz" && !isRacing;

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
        brand={isRacing ? "fasttrax" : "headpinz"}
        questions={survey.questions as GuestSurveyQuestion[]}
      />
    </BrandShell>
  );
}

/**
 * Wraps the survey content in HP brand chrome.
 *
 * HeadPinzNav is FIXED at the top of the viewport — booking pages clear
 * it by giving their content `pt-28 sm:pt-36` (112-144px). The survey
 * page must do the same or the nav cuts off the first question. That
 * padding lives on each shell (form Shell + terminal ShellWrap).
 *
 * For FastTrax (future racing surveys) we'll add a matching FT branch
 * here when PR-GS4 lands.
 */
function BrandShell({ isHeadPinz, children }: { isHeadPinz: boolean; children: React.ReactNode }) {
  if (!isHeadPinz) {
    return <>{children}</>;
  }
  return (
    <div style={{ backgroundColor: HP_BG }} className="min-h-screen">
      <HeadPinzNav />
      {children}
      <HeadPinzFooter />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Terminal panels (server-rendered, no client JS)
// ─────────────────────────────────────────────────────────────────

function ShellWrap({ children }: { children: React.ReactNode }) {
  // pt-28 / sm:pt-36 clears the fixed HeadPinzNav — same offset booking
  // pages use (apps/web/app/hp/book/page.tsx). Without this the nav
  // overlaps the page heading.
  return (
    <main
      className="text-white font-body pt-36 sm:pt-44"
      style={{ backgroundColor: HP_BG, paddingBottom: "32px" }}
    >
      <div className="w-full max-w-md mx-auto px-4">{children}</div>
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
