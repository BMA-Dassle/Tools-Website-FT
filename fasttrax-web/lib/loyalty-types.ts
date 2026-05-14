/**
 * Shared types for HeadPinz Rewards / Square Loyalty integration.
 * Used by bowling wizard, attraction booking wizard, and reserve endpoints.
 */

export interface LoyaltyAccount {
  id: string;
  balance: number;
  lifetimePoints: number;
  customerId: string;
  enrolledAt?: string;
}

export interface LoyaltyCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  profileComplete: boolean;
}

export interface RewardTier {
  id: string;
  name: string;
  points: number;
  discountCents: number;
}

/**
 * Data bag passed from the booking UI to the reserve endpoint
 * when a loyalty reward is being redeemed.
 */
export interface LoyaltyRewardPayload {
  rewardTierId: string;
  loyaltyAccountId: string;
  rewardDiscountCents: number;
  squareCustomerId: string;
  loyaltyAction: "signup" | "existing";
}
