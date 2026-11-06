/** A subscription as a billing provider reports it, normalised. */
export interface ProviderSubscription {
  provider: 'stripe' | 'dev';
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  /** The Squircle user who bought it, carried in the provider's metadata. */
  userId: string | null;
  name: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  /** When the provider produced this state; older updates never overwrite newer ones. */
  observedAt: string;
}

export interface BillingProvider {
  name: 'stripe' | 'dev';
  createCheckout(input: { userId: string; email: string | null; name: string; seats: number; teamName: string }): Promise<string>;
  createPortal(input: { userId: string; customerId: string }): Promise<string>;
  updateSeats(input: { providerSubscriptionId: string; seats: number }): Promise<ProviderSubscription>;
}

/**
 * Statuses that grant access. past_due is a grace period while the provider
 * retries the card, as Apple does with its billing grace period.
 */
export const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'] as const;
