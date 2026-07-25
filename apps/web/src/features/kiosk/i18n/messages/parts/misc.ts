/** Smaller guest-facing pieces — sign-in boxes (KioskSignInBoxes), VIP overview
 *  (KioskVipOverview), booking-as card (KioskBookingAsCard), license match picker
 *  (LicenseMatchPicker), waiver photo (KioskWaiverPhoto), and the group-waiver
 *  flow chrome (KioskWaiverFlow — legal body stays English). Add keys under the
 *  relevant namespaces (`signin.*`, `vip.*`, `bookingAs.*`, `license.*`,
 *  `waiverPhoto.*`, `waiverFlow.*`); mirror every key in es. */
export const miscEn = {} as const;

export const miscEs: Record<keyof typeof miscEn, string> = {};
