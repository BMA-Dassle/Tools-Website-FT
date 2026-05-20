import type {
  GuestSurveyQuestion,
  GuestSurveyRow,
  SurveyOrigin,
  SurveyQuestionTag,
} from "@/lib/guest-survey-db";

/**
 * Test data factories for guest-survey and marketing tests.
 *
 * Each builder returns a fully-populated object with sensible defaults; tests
 * override only the fields they care about.
 *
 *   const survey = aGuestSurvey({ origin: "racing", phoneE164: "+15551112222" });
 */

let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

export function aQuestion(overrides: Partial<GuestSurveyQuestion> = {}): GuestSurveyQuestion {
  const id = overrides.id ?? nextId();
  return {
    id,
    tag: "baseline",
    ordinal: 1,
    question: `Sample question ${id}`,
    kind: "rating_1_5",
    choices: null,
    gateOrdinal: null,
    gateAnswer: null,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function aGuestSurvey(overrides: Partial<GuestSurveyRow> = {}): GuestSurveyRow {
  const id = `survey-${nextId()}`;
  return {
    id,
    token: `tok-${id}`,
    squareCustomerId: "CUS_TEST",
    phoneE164: "+15551234567",
    origin: "bowling",
    originRef: "QAMF-RES-1",
    centerCode: "FM",
    visitDate: "2026-05-20",
    context: { tags: ["bowling", "baseline"] },
    questions: [aQuestion()],
    responses: null,
    rewardKind: null,
    rewardRef: null,
    rewardValue: null,
    sentAt: "2026-05-20T20:00:00.000Z",
    openedAt: null,
    completedAt: null,
    expiresAt: "2026-05-27T20:00:00.000Z",
    createdAt: "2026-05-20T20:00:00.000Z",
    ...overrides,
  };
}

export function aSquareCustomer(
  overrides: {
    id?: string;
    given_name?: string;
    family_name?: string;
    email_address?: string;
    phone_number?: string;
  } = {},
): {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
} {
  return {
    id: overrides.id ?? `CUS_${nextId()}`,
    given_name: overrides.given_name,
    family_name: overrides.family_name,
    email_address: overrides.email_address,
    phone_number: overrides.phone_number ?? "+15551234567",
  };
}

export type { GuestSurveyQuestion, GuestSurveyRow, SurveyOrigin, SurveyQuestionTag };
