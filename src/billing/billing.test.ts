import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import Stripe from 'stripe';

import { API, Browser, stop } from '../test/harness.js';
import { createStripeProvider, fromStripe } from './stripe.js';
import { applyProviderSubscription, entitlementFor } from './subscriptions.js';
import type { ProviderSubscription } from './types.js';

after(stop);

const subscription = (b: Browser) => b.json('/me/subscription');

describe('buying Manuscript for yourself', () => {
  const ann = new Browser();

  test('a new account has no access', async () => {
    await ann.signIn('ann@example.com');
    const { body } = await subscription(ann);
    assert.equal(body.entitlement.entitled, false);
    assert.equal(body.subscription, null);
    assert.deepEqual(body.plan, { product: 'Manuscript', amount: 999, currency: 'usd', interval: 'month', maxSeats: 500 });
  });

  test('checkout requires a signed-in person', async () => {
    const stranger = new Browser();
    const { status } = await stranger.json('/billing/checkout', { method: 'POST', body: { seats: 1 } });
    assert.equal(status, 401);
  });

  test('checkout refuses requests from other sites', async () => {
    const { status } = await ann.json('/billing/checkout', { method: 'POST', body: { seats: 1 }, origin: 'https://evil.example' });
    assert.equal(status, 403);
  });

  test('paying grants access, with the buyer in the first seat', async () => {
    const { body: done } = await ann.subscribe(1);
    assert.equal(done.location, 'http://localhost:8080/account/?subscribed=1');

    const { body } = await subscription(ann);
    assert.equal(body.entitlement.entitled, true);
    assert.equal(body.entitlement.source.role, 'owner');
    assert.equal(body.entitlement.source.state, 'active');
    assert.equal(body.subscription.seats, 1);
    assert.equal(body.subscription.members[0].email, 'ann@example.com');
  });

  test('you can’t buy it twice', async () => {
    const { status } = await ann.json('/billing/checkout', { method: 'POST', body: { seats: 1 } });
    assert.equal(status, 409);
  });

  test('an account that still pays can’t be deleted', async () => {
    const { status, body } = await ann.json('/me', { method: 'DELETE' });
    assert.equal(status, 409);
    assert.match(body.error, /Cancel your Manuscript subscription/);
  });
});

describe('buying seats for a team', () => {
  const owner = new Browser();
  const bea = new Browser();
  const cal = new Browser();

  test('one price per person: three seats, one bill', async () => {
    await owner.signIn('owner@studio.example');
    await owner.subscribe(3, 'Northwind Studio');
    const { body } = await subscription(owner);
    assert.equal(body.subscription.name, 'Northwind Studio');
    assert.equal(body.subscription.seats, 3);
    assert.equal(body.subscription.seatsUsed, 1);
  });

  test('the owner gives seats away by email, up to what they pay for', async () => {
    assert.equal((await owner.json('/me/subscription/members', { method: 'POST', body: { email: 'BEA@studio.example' } })).status, 201);
    assert.equal((await owner.json('/me/subscription/members', { method: 'POST', body: { email: 'cal@studio.example' } })).status, 201);
    const full = await owner.json('/me/subscription/members', { method: 'POST', body: { email: 'dee@studio.example' } });
    assert.equal(full.status, 409);
    assert.match(full.body.error, /Every seat is taken/);
    const duplicate = await owner.json('/me/subscription/members', { method: 'POST', body: { email: 'bea@studio.example' } });
    assert.equal(duplicate.status, 409);
  });

  test('an invited person sees the invitation, accepts, and gets access', async () => {
    await bea.signIn('bea@studio.example');
    const before = await subscription(bea);
    assert.equal(before.body.entitlement.entitled, false);
    assert.equal(before.body.invitations.length, 1);
    assert.equal(before.body.invitations[0].name, 'Northwind Studio');

    const accept = await bea.json(`/me/invitations/${before.body.invitations[0].id}/accept`, { method: 'POST' });
    assert.equal(accept.status, 204);

    const { body } = await subscription(bea);
    assert.equal(body.entitlement.entitled, true);
    assert.equal(body.entitlement.source.role, 'member');
    assert.equal(body.membership.name, 'Northwind Studio');
    assert.equal(body.invitations.length, 0);
  });

  test('a seat can’t be removed by anyone but the owner', async () => {
    const { body } = await subscription(owner);
    const seat = body.subscription.members.find((m: { email: string }) => m.email === 'bea@studio.example');
    assert.equal((await bea.json(`/me/subscription/members/${seat.id}`, { method: 'DELETE' })).status, 404);
  });

  test('seats can’t drop below the people using them', async () => {
    const tooFew = await owner.json('/me/subscription/seats', { method: 'POST', body: { seats: 2 } });
    assert.equal(tooFew.status, 409);
    assert.equal((await owner.json('/me/subscription/seats', { method: 'POST', body: { seats: 5 } })).status, 204);
    assert.equal((await subscription(owner)).body.subscription.seats, 5);
  });

  test('declining an invitation frees the seat', async () => {
    await cal.signIn('cal@studio.example');
    const { body } = await subscription(cal);
    assert.equal((await cal.json(`/me/invitations/${body.invitations[0].id}/decline`, { method: 'POST' })).status, 204);
    assert.equal((await subscription(owner)).body.subscription.seatsUsed, 2);
  });

  test('leaving a team gives the seat back', async () => {
    assert.equal((await bea.json('/me/subscription/leave', { method: 'POST' })).status, 204);
    assert.equal((await subscription(bea)).body.entitlement.entitled, false);
  });

  test('the owner can give away their own seat and take it back', async () => {
    const { body } = await subscription(owner);
    const own = body.subscription.members.find((m: { role: string }) => m.role === 'owner');
    await owner.json(`/me/subscription/members/${own.id}`, { method: 'DELETE' });
    assert.equal((await subscription(owner)).body.entitlement.entitled, false);
    assert.equal((await owner.json('/me/subscription/claim-seat', { method: 'POST' })).status, 204);
    assert.equal((await subscription(owner)).body.entitlement.entitled, true);
  });
});

describe('subscription states from the provider', () => {
  const base = (overrides: Partial<ProviderSubscription>): ProviderSubscription => ({
    provider: 'dev',
    providerSubscriptionId: 'sub_states',
    providerCustomerId: null,
    userId: null,
    name: '',
    status: 'active',
    seats: 2,
    currentPeriodEnd: '2026-12-06T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    endedAt: null,
    observedAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  });

  const dan = new Browser();
  const eve = new Browser();
  let danId = '';

  test('setup', async () => {
    await dan.signIn('dan@example.com');
    await eve.signIn('eve@example.com');
    danId = (await dan.json('/me')).body.user.id;
    await applyProviderSubscription(base({ userId: danId }));
    assert.equal((await entitlementFor(danId)).entitled, true);
  });

  test('a failed payment keeps access during the grace period', async () => {
    await applyProviderSubscription(base({ userId: danId, status: 'past_due', observedAt: '2026-11-06T11:00:00.000Z' }));
    const entitlement = await entitlementFor(danId);
    assert.equal(entitlement.entitled, true);
    assert.equal(entitlement.source?.state, 'grace');
  });

  test('an older update arriving late changes nothing', async () => {
    await applyProviderSubscription(base({ userId: danId, status: 'canceled', observedAt: '2026-11-06T09:00:00.000Z' }));
    assert.equal((await entitlementFor(danId)).source?.state, 'grace');
  });

  test('cancelling keeps access until the period ends', async () => {
    await applyProviderSubscription(base({ userId: danId, cancelAtPeriodEnd: true, observedAt: '2026-11-06T12:00:00.000Z' }));
    const entitlement = await entitlementFor(danId);
    assert.equal(entitlement.entitled, true);
    assert.equal(entitlement.source?.state, 'ending');
    assert.equal(entitlement.source?.periodEnd, '2026-12-06T00:00:00.000Z');
  });

  test('when seats are cut elsewhere, the earliest people keep access', async () => {
    await dan.json('/me/subscription/members', { method: 'POST', body: { email: 'eve@example.com' } });
    const invitation = (await subscription(eve)).body.invitations[0];
    await eve.json(`/me/invitations/${invitation.id}/accept`, { method: 'POST' });
    const eveId = (await eve.json('/me')).body.user.id;
    assert.equal((await entitlementFor(eveId)).entitled, true);

    await applyProviderSubscription(base({ userId: danId, seats: 1, observedAt: '2026-11-06T13:00:00.000Z' }));
    assert.equal((await entitlementFor(danId)).entitled, true);
    assert.equal((await entitlementFor(eveId)).entitled, false);
  });

  test('an ended subscription grants nothing', async () => {
    await applyProviderSubscription(base({ userId: danId, status: 'canceled', endedAt: '2026-11-07T00:00:00.000Z', observedAt: '2026-11-07T00:00:00.000Z' }));
    assert.equal((await entitlementFor(danId)).entitled, false);
    // And once nothing is paid for, the account can be deleted.
    assert.equal((await dan.json('/me', { method: 'DELETE' })).status, 204);
  });
});

describe('Stripe', () => {
  test('reads seats and the billing period from the subscription item', () => {
    const sub = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      metadata: { user_id: 'user-1', team_name: 'Acme' },
      cancel_at_period_end: false,
      cancel_at: null,
      ended_at: null,
      items: { data: [{ quantity: 10, current_period_end: 1_796_000_000 }] },
    } as unknown as Stripe.Subscription;

    const snapshot = fromStripe(sub, 1_790_000_000);
    assert.equal(snapshot.seats, 10);
    assert.equal(snapshot.userId, 'user-1');
    assert.equal(snapshot.name, 'Acme');
    assert.equal(snapshot.currentPeriodEnd, new Date(1_796_000_000 * 1000).toISOString());
    assert.equal(snapshot.observedAt, new Date(1_790_000_000 * 1000).toISOString());
  });

  test('a scheduled cancellation counts as ending', () => {
    const sub = {
      id: 'sub_1', customer: { id: 'cus_1' }, status: 'active', metadata: {}, cancel_at_period_end: false,
      cancel_at: 1_796_000_000, ended_at: null, items: { data: [{ quantity: 1, current_period_end: 1_796_000_000 }] },
    } as unknown as Stripe.Subscription;
    assert.equal(fromStripe(sub, 1).cancelAtPeriodEnd, true);
    assert.equal(fromStripe(sub, 1).providerCustomerId, 'cus_1');
  });

  test('only correctly signed webhooks are accepted', () => {
    const secret = 'whsec_test_secret';
    const { parseWebhook } = createStripeProvider({ secretKey: 'sk_test_x', webhookSecret: secret, priceId: 'price_x', automaticTax: false });
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.updated', created: 1, data: { object: {} } });
    const signature = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret });

    assert.equal(parseWebhook(Buffer.from(payload), signature).id, 'evt_1');
    assert.throws(() => parseWebhook(Buffer.from(payload), signature.replace(/v1=./, 'v1=0')), /Invalid Stripe signature/);
    assert.throws(() => parseWebhook(Buffer.from(payload.replace('evt_1', 'evt_2')), signature), /Invalid Stripe signature/);
    assert.throws(() => parseWebhook(Buffer.from(payload), undefined), /Missing Stripe signature/);
  });

  test('the webhook endpoint is closed when Stripe isn’t configured', async () => {
    const response = await fetch(`${API}/billing/webhook`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 404);
  });
});
