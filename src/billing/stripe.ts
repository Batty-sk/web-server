import Stripe from 'stripe';

import { PLAN, SITE_URL } from '../config.js';
import { HttpError } from '../http/errors.js';
import { billingCustomer, saveBillingCustomer } from './subscriptions.js';
import type { BillingProvider, ProviderSubscription } from './types.js';

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  automaticTax: boolean;
}

const iso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/** Stripe's subscription, in the shape the rest of the server understands. */
export const fromStripe = (sub: Stripe.Subscription, observedAt: number): ProviderSubscription => {
  const item = sub.items.data[0];
  return {
    provider: 'stripe',
    providerSubscriptionId: sub.id,
    providerCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    userId: sub.metadata?.user_id || null,
    name: sub.metadata?.team_name ?? '',
    status: sub.status,
    seats: item?.quantity ?? 1,
    // Since the 2025 API versions, billing periods live on the subscription item.
    currentPeriodEnd: iso(item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end || Boolean(sub.cancel_at),
    endedAt: iso(sub.ended_at),
    observedAt: new Date(observedAt * 1000).toISOString(),
  };
};

export const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

export const createStripeProvider = (config: StripeConfig) => {
  const stripe = new Stripe(config.secretKey, { appInfo: { name: 'squircle-server' } });

  const ensureCustomer = async (userId: string, email: string | null, name: string) => {
    const existing = await billingCustomer(userId, 'stripe');
    if (existing) return existing;
    const customer = await stripe.customers.create(
      { email: email ?? undefined, name: name || undefined, metadata: { user_id: userId } },
      { idempotencyKey: `customer-${userId}` },
    );
    await saveBillingCustomer(userId, 'stripe', customer.id);
    return customer.id;
  };

  const provider: BillingProvider = {
    name: 'stripe',

    async createCheckout({ userId, email, name, seats, teamName }) {
      const customer = await ensureCustomer(userId, email, name);
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: userId,
        line_items: [{ price: config.priceId, quantity: seats }],
        subscription_data: { metadata: { user_id: userId, team_name: teamName } },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        ...(config.automaticTax
          ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const, name: 'auto' as const } }
          : {}),
        success_url: `${SITE_URL}/account/?subscribed=1`,
        cancel_url: `${SITE_URL}/account/subscribe/?seats=${seats}`,
      });
      if (!session.url) throw new HttpError(502, 'Checkout couldn’t be started. Please try again.');
      return session.url;
    },

    async createPortal({ customerId }) {
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${SITE_URL}/account/` });
      return session.url;
    },

    async updateSeats({ providerSubscriptionId, seats }) {
      const current = await stripe.subscriptions.retrieve(providerSubscriptionId);
      const item = current.items.data[0];
      if (!item) throw new HttpError(500, 'That subscription has no Manuscript item.');
      const updated = await stripe.subscriptions.update(providerSubscriptionId, {
        items: [{ id: item.id, quantity: seats }],
        // Adding a seat mid-month charges only for the rest of the month; removing one credits the next invoice.
        proration_behavior: 'create_prorations',
      });
      return fromStripe(updated, Math.floor(Date.now() / 1000));
    },
  };

  /** Verifies the signature, so only Stripe can tell us a subscription changed. */
  const parseWebhook = (rawBody: Buffer, signature: string | undefined) => {
    if (!signature) throw new HttpError(400, 'Missing Stripe signature.');
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
    } catch {
      throw new HttpError(400, 'Invalid Stripe signature.');
    }
  };

  /** Warns at startup if the Stripe price doesn't say what the site says. */
  const checkPrice = async () => {
    try {
      const price = await stripe.prices.retrieve(config.priceId);
      const matches = price.unit_amount === PLAN.amount && price.currency === PLAN.currency && price.recurring?.interval === PLAN.interval;
      if (!matches) {
        console.warn(
          `billing: STRIPE_PRICE_ID is ${price.unit_amount} ${price.currency}/${price.recurring?.interval}, but the plan is ${PLAN.amount} ${PLAN.currency}/${PLAN.interval}.`,
        );
      }
    } catch (error) {
      console.warn('billing: couldn’t read the Stripe price.', error instanceof Error ? error.message : error);
    }
  };

  return { provider, parseWebhook, checkPrice, stripe };
};
