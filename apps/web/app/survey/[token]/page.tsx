import { notFound } from "next/navigation";
import {
  getGuestSurveyByToken,
  markGuestSurveyOpened,
  type GuestSurveyQuestion,
} from "@/lib/guest-survey-db";
import { recordTouch } from "~/features/marketing";
import { CENTER_META } from "@/lib/bowling-lane-ready-notify";
import { SurveyForm } from "./SurveyForm";

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

  if (survey.completedAt) {
    return <ThanksAlreadyPanel centerName={centerName} />;
  }
  if (new Date(survey.expiresAt) <= new Date()) {
    return <ExpiredPanel centerName={centerName} />;
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
    <SurveyForm
      token={token}
      centerName={centerName}
      questions={survey.questions as GuestSurveyQuestion[]}
    />
  );
}

// ─────────────────────────────────────────────────────────────────
// Terminal panels (server-rendered, no client JS)
// ─────────────────────────────────────────────────────────────────

function ShellWrap({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-neutral-900 text-white px-4 py-10 flex flex-col items-center">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

function ThanksAlreadyPanel({ centerName }: { centerName: string }) {
  return (
    <ShellWrap>
      <h1 className="text-2xl font-semibold mb-2">Thanks!</h1>
      <p className="text-neutral-300">
        You&apos;ve already submitted this survey. We appreciate the feedback — see you at{" "}
        {centerName} soon!
      </p>
    </ShellWrap>
  );
}

function ExpiredPanel({ centerName }: { centerName: string }) {
  return (
    <ShellWrap>
      <h1 className="text-2xl font-semibold mb-2">This survey has expired</h1>
      <p className="text-neutral-300">
        Survey links are valid for 7 days. Thanks anyway — hope to see you back at {centerName}{" "}
        soon.
      </p>
    </ShellWrap>
  );
}
