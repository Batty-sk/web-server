import { randomInt } from 'node:crypto';

import Stripe from 'stripe';

import { PLAN, SITE_URL } from '../config.js';
import { HttpError } from '../http/errors.js';
import { applyProviderSubscription, billingCustomer, recordBillingAlert, saveBillingCustomer } from './subscriptions.js';
import type { BillingProvider, ProviderSubscription } from './types.js';

interface StripeConfig {
  apiKey: string;
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

/** The events the webhook endpoint should be subscribed to — and nothing else. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
] as const;

const SUBSCRIPTION_EVENTS = new Set(WEBHOOK_EVENTS.filter((e) => e.startsWith('customer.subscription.')));

/** Labels checkout sessions in the Dashboard; Stripe asks for an 8-letter random suffix. */
const integrationIdentifier = () =>
  `manuscript-subscribe-${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`;

type StripeLike = Pick<Stripe, 'subscriptions' | 'charges'>;

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : (value?.id ?? null));

/**
 * Applies one verified Stripe event. Subscription state always comes from the
 * Subscription itself — read from the event, or fetched fresh when the event is
 * about something else (a checkout, an invoice) — and is matched to our user
 * through the Customer we created for them.
 */
export const handleStripeEvent = async (stripe: StripeLike, event: Stripe.Event) => {
  const refresh = async (subscription: string | Stripe.Subscription | null | undefined) => {
    const id = idOf(subscription);
    if (id) await applyProviderSubscription(fromStripe(await stripe.subscriptions.retrieve(id), event.created));
  };

  const alert = async (providerObject: string, charge: string | Stripe.Charge | null, amount: number | null, currency: string | null) => {
    const chargeObject = typeof charge === 'string' ? await stripe.charges.retrieve(charge) : charge;
    await recordBillingAlert({
      eventId: event.id,
      type: event.type,
      providerObject,
      provider: 'stripe',
      customerId: idOf(chargeObject?.customer),
      amount,
      currency,
    });
  };

  if (SUBSCRIPTION_EVENTS.has(event.type as never)) {
    await applyProviderSubscription(fromStripe(event.data.object as Stripe.Subscription, event.created));
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      // Only a paid checkout grants anything; a delayed payment method arrives later as async_payment_succeeded.
      if (session.mode === 'subscription' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')) {
        await refresh(session.subscription);
      }
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
      await refresh(event.data.object.parent?.subscription_details?.subscription);
      return;
    case 'charge.refunded': {
      const charge = event.data.object;
      await alert(charge.id, charge, charge.amount_refunded, charge.currency);
      return;
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      await alert(dispute.id, dispute.charge, dispute.amount, dispute.currency);
      return;
    }
    case 'radar.early_fraud_warning.created': {
      const warning = event.data.object;
      await alert(warning.id, warning.charge, null, null);
      return;
    }
    default:
      return;
  }
};

export const createStripeProvider = (config: StripeConfig) => {
  const stripe = new Stripe(config.apiKey, { appInfo: { name: 'squircle-server' } });

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
        integration_identifier: integrationIdentifier(),
        customer,
        client_reference_id: userId,
        line_items: [{ price: config.priceId, quantity: seats }],
        subscription_data: { metadata: { user_id: userId, team_name: teamName } },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        // Only once a tax registration is active in Stripe; until then Stripe silently collects nothing.
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

  return { provider, parseWebhook, checkPrice, handleEvent: (event: Stripe.Event) => handleStripeEvent(stripe, event) };
};
