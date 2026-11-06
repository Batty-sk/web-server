import express, { Router, type Response } from 'express';

import { getUser } from '../auth/accounts.js';
import { requireUser } from '../auth/sessions.js';
import { BILLING, PLAN } from '../config.js';
import { one } from '../db/client.js';
import { requireSiteOrigin } from '../http/cors.js';
import { HttpError } from '../http/errors.js';
import { devBillingRouter } from './dev.js';
import { billing, stripeBilling } from './index.js';
import {
  acceptInvitation,
  applyProviderSubscription,
  claimOwnerSeat,
  declineInvitation,
  entitlementFor,
  invitationsFor,
  inviteToSubscription,
  leaveSubscription,
  ownedSubscription,
  recordBillingEvent,
  removeSeat,
  renameSubscription,
} from './subscriptions.js';

const userId = (res: Response) => res.locals.userId as string;

const seatCount = (value: unknown) => {
  const seats = Number(value);
  if (!Number.isInteger(seats) || seats < 1 || seats > PLAN.maxSeats) {
    throw new HttpError(400, `Choose between 1 and ${PLAN.maxSeats} people.`, 'seats');
  }
  return seats;
};

const teamName = (value: unknown) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 80) throw new HttpError(400, 'Use a name of up to 80 characters.', 'name');
  return value.replace(/\s+/g, ' ').trim();
};

/* /billing ------------------------------------------------------------------- */

export const billingRouter = Router();

/** The one plan. Public, so the purchase page can show it. */
billingRouter.get('/plan', (_req, res) => {
  res.json({ plan: PLAN });
});

/** Starts a purchase on the provider's hosted checkout. */
billingRouter.post('/checkout', requireSiteOrigin, requireUser, express.json({ limit: '4kb' }), async (req, res) => {
  const id = userId(res);
  if ((await entitlementFor(id)).entitled) {
    throw new HttpError(409, 'You already have Manuscript. Manage your subscription from your account.');
  }
  const user = await getUser(id);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  const seats = seatCount(req.body?.seats ?? 1);
  const url = await billing.createCheckout({
    userId: id,
    email: user.email,
    name: user.name,
    seats,
    teamName: seats > 1 ? teamName(req.body?.name) : '',
  });
  res.json({ url });
});

/** Payment method, invoices, cancellation — on the provider's hosted portal. */
billingRouter.post('/portal', requireSiteOrigin, requireUser, async (_req, res) => {
  const sub = await ownedSubscription(userId(res));
  if (!sub?.customerId) throw new HttpError(404, 'You don’t have a subscription to manage.');
  if (sub.channel === 'app_store') throw new HttpError(409, 'This subscription is managed by Apple, in your Apple Account settings.');
  res.json({ url: await billing.createPortal({ userId: userId(res), customerId: sub.customerId }) });
});

/**
 * Stripe tells us about every subscription change here. The signature proves
 * it's Stripe; the event id makes retries harmless.
 */
billingRouter.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!stripeBilling) throw new HttpError(404, 'Not found.');
  const event = stripeBilling.parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);

  // Recorded only after it's handled: if handling fails, Stripe retries and we try again.
  if (!(await one('SELECT 1 FROM billing_events WHERE id = ?', [event.id]))) {
    await stripeBilling.handleEvent(event);
    await recordBillingEvent(event.id, event.type);
  }
  res.json({ received: true });
});

if (BILLING.provider === 'dev') billingRouter.use('/dev', devBillingRouter);

/* /me/subscription ----------------------------------------------------------- */

export const subscriptionRouter = Router();
subscriptionRouter.use(requireSiteOrigin, requireUser, express.json({ limit: '4kb' }));

/** Everything the Account page needs about Manuscript, in one call. */
subscriptionRouter.get('/', async (_req, res) => {
  const id = userId(res);
  const [entitlement, owned, invitations] = await Promise.all([entitlementFor(id), ownedSubscription(id), invitationsFor(id)]);

  let membership = null;
  if (entitlement.source?.role === 'member') {
    membership = await one<{ name: string; owner_name: string | null; owner_email: string | null }>(
      `SELECT s.name, u.name AS owner_name, u.email AS owner_email FROM subscriptions s
       LEFT JOIN users u ON u.id = s.owner_user_id WHERE s.id = ?`,
      [entitlement.source.subscriptionId],
    );
  }

  const subscription = owned && {
    id: owned.id,
    channel: owned.channel,
    name: owned.name,
    state: owned.state,
    seats: owned.seats,
    seatsUsed: owned.seatsUsed,
    periodEnd: owned.periodEnd,
    endedAt: owned.endedAt,
    members: owned.members,
  };

  res.json({ plan: PLAN, entitlement, subscription, membership, invitations });
});

subscriptionRouter.patch('/', async (req, res) => {
  await renameSubscription(userId(res), teamName(req.body?.name));
  res.status(204).end();
});

/** Adds or removes seats. Billing is prorated by the provider. */
subscriptionRouter.post('/seats', async (req, res) => {
  const sub = await ownedSubscription(userId(res));
  if (!sub || sub.state === 'ended') throw new HttpError(404, 'You don’t have a subscription to change.');
  if (sub.channel !== 'web') throw new HttpError(409, 'This subscription is managed by Apple.');
  const seats = seatCount(req.body?.seats);
  if (seats < sub.seatsUsed) {
    throw new HttpError(409, `${sub.seatsUsed} seats are in use. Remove people before reducing to ${seats}.`, 'seats');
  }
  if (seats !== sub.seats) {
    await applyProviderSubscription(await billing.updateSeats({ providerSubscriptionId: sub.providerSubscriptionId, seats }));
  }
  res.status(204).end();
});

subscriptionRouter.post('/members', async (req, res) => {
  await inviteToSubscription(userId(res), typeof req.body?.email === 'string' ? req.body.email : '');
  res.status(201).end();
});

subscriptionRouter.delete('/members/:id', async (req, res) => {
  await removeSeat(userId(res), req.params.id);
  res.status(204).end();
});

subscriptionRouter.post('/claim-seat', async (_req, res) => {
  await claimOwnerSeat(userId(res));
  res.status(204).end();
});

subscriptionRouter.post('/leave', async (_req, res) => {
  await leaveSubscription(userId(res));
  res.status(204).end();
});

/* /me/invitations ------------------------------------------------------------ */

export const invitationsRouter = Router();
invitationsRouter.use(requireSiteOrigin, requireUser);

invitationsRouter.post('/:id/accept', async (req, res) => {
  await acceptInvitation(userId(res), req.params.id);
  res.status(204).end();
});

invitationsRouter.post('/:id/decline', async (req, res) => {
  await declineInvitation(userId(res), req.params.id);
  res.status(204).end();
});
