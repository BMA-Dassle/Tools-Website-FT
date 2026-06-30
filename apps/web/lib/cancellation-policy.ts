/**
 * Single source of truth for the Cancellation & Payment Policy copy.
 *
 * Consumed by:
 *   - the checkout clickwrap modal (components/booking/ClickwrapCheckbox.tsx)
 *   - the booking-confirmation email (api/notifications/booking-confirmation)
 *   - the standalone /cancellation-policy page
 *
 * Client-safe: NO server-only imports (no DB), so it can be bundled into the
 * client clickwrap component. The acceptance-version lives here too so the
 * clickwrap log and the displayed copy can never drift; lib/clickwrap.ts
 * re-exports it as CURRENT_POLICY_VERSION.
 *
 * Bump CANCELLATION_POLICY_VERSION whenever the wording below changes — every
 * acceptance row keeps the version in effect when the guest agreed.
 */

export const CANCELLATION_POLICY_VERSION = "v2-2026-04-30";

export interface CancellationPolicyParams {
  brandName: string;
  brandPhone: string;
  /** Hours before the reservation that cancellations are accepted (racing/attractions 2, bowling 1). */
  cancellationHours: number;
}

export interface CancellationPolicySection {
  heading: string;
  items: string[];
}

export interface CancellationPolicy {
  title: string;
  intro: string;
  sections: CancellationPolicySection[];
  acknowledgement: string;
}

function hours(n: number): string {
  return `${n} hour${n === 1 ? "" : "s"}`;
}

export function getCancellationPolicy({
  brandName,
  brandPhone,
  cancellationHours,
}: CancellationPolicyParams): CancellationPolicy {
  return {
    title: "Cancellation & Payment Policy",
    intro: "Reservations are confirmed immediately upon payment. All sales are final.",
    sections: [
      {
        heading: "Cancellations & Reschedules",
        items: [
          `Cancellations must be made more than ${hours(cancellationHours)} before your reservation to be eligible for a refund or credit.`,
          `Cancellations within ${hours(cancellationHours)} of your reservation are non-refundable, no exceptions.`,
          `All cancellation and reschedule requests must be made by phone or SMS at ${brandPhone}. Online requests are not accepted.`,
        ],
      },
      {
        heading: "Disputes & Chargebacks",
        items: [
          `If you have a concern about a charge, please contact us first at ${brandPhone} before contacting your bank. We can typically resolve issues within one business day.`,
          `Initiating a chargeback without first contacting ${brandName} may result in suspension of booking privileges.`,
        ],
      },
    ],
    acknowledgement:
      "By checking the box and completing payment, you acknowledge that you have read, understood, and agreed to this policy.",
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Render the policy as an email-safe table row (matches the booking-confirmation
 * template's inline-styled, Arial, table-based layout). Injected in place of the
 * `^CancellationPolicySection()$` placeholder.
 */
export function cancellationPolicyEmailHtml(params: CancellationPolicyParams): string {
  const policy = getCancellationPolicy(params);
  const sectionsHtml = policy.sections
    .map(
      (s) => `
        <p style="margin: 12px 0 4px 0; font-size: 13px; font-weight: bold; color: #1A1A1A;">${escapeHtml(s.heading)}</p>
        <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: #555; line-height: 1.6;">
          ${s.items.map((i) => `<li style="margin: 0 0 4px 0;">${escapeHtml(i)}</li>`).join("")}
        </ul>`,
    )
    .join("");

  return `
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
  <table width="100%" cellpadding="16" cellspacing="0" border="0" style="background-color: #F8F9FB; border: 1px solid #E3E8EF; border-radius: 6px;">
  <tr><td style="font-family: Arial, sans-serif;">
    <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: bold; color: #1A1A1A;">${escapeHtml(policy.title)}</p>
    <p style="margin: 0; font-size: 12px; color: #555; line-height: 1.6;">${escapeHtml(policy.intro)}</p>
    ${sectionsHtml}
    <p style="margin: 12px 0 0 0; font-size: 11px; color: #888; line-height: 1.5; border-top: 1px solid #E3E8EF; padding-top: 8px;">${escapeHtml(policy.acknowledgement)}</p>
  </td></tr></table>
</td>
</tr>`;
}
