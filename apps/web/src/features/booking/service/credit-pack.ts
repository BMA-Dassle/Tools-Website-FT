export interface PurchasePackParams {
  packId: string;
  personId?: string;
  newPerson?: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dob?: string;
  };
  cardNonce?: string;
  savedCardId?: string;
  giftCardNonce?: string;
  squareCustomerId?: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  racerName?: string;
  loginCode?: string;
}

export interface PurchasePackResult {
  billId: string;
  orderId: string;
  paymentId?: string;
  neonId?: number;
  depositId?: string;
  depositCreditPending: boolean;
  gcApprovedCents: number;
  cardApprovedCents: number;
}

export async function purchasePack(
  params: PurchasePackParams,
): Promise<PurchasePackResult> {
  const res = await fetch("/api/booking/v2/purchase-pack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || "Purchase failed");
  }

  return {
    billId: data.billId,
    orderId: data.orderId,
    paymentId: data.paymentId,
    neonId: data.neonId,
    depositId: data.depositId,
    depositCreditPending: data.depositCreditPending ?? false,
    gcApprovedCents: data.gcApprovedCents ?? 0,
    cardApprovedCents: data.cardApprovedCents ?? 0,
  };
}
