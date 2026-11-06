import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';

import { API_URL, PLAN, SITE_URL } from '../config.js';
import { readSession } from '../auth/sessions.js';
import { escapeHtml } from '../newsroom/html.js';
import { one } from '../db/client.js';
import { applyProviderSubscription, ownedSubscription, saveBillingCustomer } from './subscriptions.js';
import type { BillingProvider, ProviderSubscription } from './types.js';

/**
 * A stand-in for Stripe in local development: the same flow — leave the site,
 * pay, come back — with no money and no keys. Never mounted in production.
 */
const pending = new Map<string, { userId: string; seats: number; teamName: string; expires: number }>();
const store = new Map<string, ProviderSubscription>();

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: PLAN.currency }).format(cents / 100);
const inAMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** The dev store lives in memory; after a restart, rebuild a subscription from the database. */
const current = async (providerSubscriptionId: string): Promise<ProviderSubscription | undefined> => {
  const cached = store.get(providerSubscriptionId);
  if (cached) return cached;
  const row = await one<{ owner_user_id: string | null; provider_customer_id: string | null; name: string; status: string;
    seats: number; current_period_end: string | null; cancel_at_period_end: number; ended_at: string | null }>(
    `SELECT * FROM subscriptions WHERE provider = 'dev' AND provider_subscription_id = ?`,
    [providerSubscriptionId],
  );
  if (!row) return undefined;
  return {
    provider: 'dev', providerSubscriptionId, providerCustomerId: row.provider_customer_id, userId: row.owner_user_id,
    name: row.name, status: row.status, seats: Number(row.seats), currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1, endedAt: row.ended_at, observedAt: new Date().toISOString(),
  };
};

const save = async (snapshot: ProviderSubscription) => {
  const next = { ...snapshot, observedAt: new Date().toISOString() };
  store.set(next.providerSubscriptionId, next);
  await applyProviderSubscription(next);
  return next;
};

export const devProvider: BillingProvider = {
  name: 'dev',

  async createCheckout({ userId, seats, teamName }) {
    const token = randomBytes(16).toString('hex');
    pending.set(token, { userId, seats, teamName, expires: Date.now() + 30 * 60 * 1000 });
    return `${API_URL}/billing/dev/checkout/${token}`;
  },

  async createPortal({ userId }) {
    return `${API_URL}/billing/dev/portal?user=${encodeURIComponent(userId)}`;
  },

  async updateSeats({ providerSubscriptionId, seats }) {
    const existing = await current(providerSubscriptionId);
    if (!existing) throw new Error('Unknown dev subscription.');
    return save({ ...existing, seats });
  },
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f7; color: #1d1d1f;
         font: 15px/1.47 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  main { width: min(100% - 32px, 420px); padding: 32px; border-radius: 18px; background: #fff; box-shadow: 0 8px 32px rgba(0,0,0,.08); }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 6px; background: #fff4d6; color: #8a5a00; font-size: 12px; font-weight: 600; }
  h1 { margin: 16px 0 4px; font-size: 24px; } p { margin: 0; color: #6e6e73; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 24px 0; } dd { margin: 0; text-align: right; }
  .total { padding-top: 8px; border-top: 1px solid #d2d2d7; font-weight: 600; }
  form { display: grid; gap: 10px; margin-top: 24px; }
  button, a.button { padding: 12px; border: 0; border-radius: 12px; background: #0071e3; color: #fff; font: inherit; font-weight: 500;
         text-align: center; text-decoration: none; cursor: pointer; }
  .secondary { background: #e8e8ed !important; color: #1d1d1f !important; }
</style></head><body><main><span class="tag">Developer billing — no money moves</span>${body}</main></body></html>`;

export const devBillingRouter = Router();
devBillingRouter.use(express.urlencoded({ extended: false }));

devBillingRouter.get('/checkout/:token', (req, res) => {
  const checkout = pending.get(req.params.token);
  if (!checkout || checkout.expires < Date.now()) return void res.status(410).send(page('Expired', '<h1>This checkout expired</h1>'));
  const total = PLAN.amount * checkout.seats;
  res.send(
    page(
      'Checkout',
      `<h1>Subscribe to ${PLAN.product}</h1><p>${checkout.teamName ? escapeHtml(checkout.teamName) : 'Personal'}</p>
       <dl><dt>${PLAN.product} × ${checkout.seats}</dt><dd>${money(PLAN.amount)} each</dd>
       <dt class="total">Total per month</dt><dd class="total">${money(total)}</dd></dl>
       <form method="post"><button>Subscribe</button>
       <a class="button secondary" href="${SITE_URL}/account/subscribe/?seats=${checkout.seats}">Cancel</a></form>`,
    ),
  );
});

devBillingRouter.post('/checkout/:token', async (req, res) => {
  const checkout = pending.get(req.params.token);
  if (!checkout) return void res.status(410).send(page('Expired', '<h1>This checkout expired</h1>'));
  pending.delete(req.params.token);
  const customerId = `dev_cus_${checkout.userId.slice(0, 8)}`;
  await saveBillingCustomer(checkout.userId, 'dev', customerId);
  await save({
    provider: 'dev',
    providerSubscriptionId: `dev_sub_${randomBytes(6).toString('hex')}`,
    providerCustomerId: customerId,
    userId: checkout.userId,
    name: checkout.teamName,
    status: 'active',
    seats: checkout.seats,
    currentPeriodEnd: inAMonth(),
    cancelAtPeriodEnd: false,
    endedAt: null,
    observedAt: new Date().toISOString(),
  });
  res.redirect(303, `${SITE_URL}/account/?subscribed=1`);
});

/** A tiny customer portal: cancel, resume, simulate a failed payment, or end it now. */
devBillingRouter.get('/portal', async (req, res) => {
  const userId = await readSession(req, res, 'user');
  if (!userId) return void res.redirect(303, `${SITE_URL}/account/`);
  const sub = await ownedSubscription(userId);
  const snapshot = sub ? await current(sub.providerSubscriptionId) : undefined;
  if (!sub || !snapshot) {
    return void res.send(page('Billing', `<h1>Nothing to manage</h1><p>You don’t have a developer subscription.</p>
      <form><a class="button" href="${SITE_URL}/account/">Return to Account</a></form>`));
  }
  const action = (value: string, label: string, secondary = true) =>
    `<button name="action" value="${value}" class="${secondary ? 'secondary' : ''}">${label}</button>`;
  res.send(
    page(
      'Billing',
      `<h1>Manage billing</h1><p>${sub.seats} ${sub.seats === 1 ? 'seat' : 'seats'} · ${escapeHtml(snapshot.status)}${snapshot.cancelAtPeriodEnd ? ' · cancels at period end' : ''}</p>
       <form method="post" action="${API_URL}/billing/dev/portal">
         ${snapshot.cancelAtPeriodEnd ? action('resume', 'Resume subscription', false) : action('cancel', 'Cancel subscription')}
         ${action('fail', 'Simulate a failed payment')}
         ${action('pay', 'Simulate a successful payment')}
         ${action('end', 'End immediately')}
         <a class="button" href="${SITE_URL}/account/">Return to Account</a>
       </form>`,
    ),
  );
});

devBillingRouter.post('/portal', async (req, res) => {
  const userId = await readSession(req, res, 'user');
  const sub = userId ? await ownedSubscription(userId) : null;
  const snapshot = sub ? await current(sub.providerSubscriptionId) : undefined;
  if (snapshot) {
    const changes: Record<string, Partial<ProviderSubscription>> = {
      cancel: { cancelAtPeriodEnd: true },
      resume: { cancelAtPeriodEnd: false },
      fail: { status: 'past_due' },
      pay: { status: 'active', currentPeriodEnd: inAMonth() },
      end: { status: 'canceled', endedAt: new Date().toISOString() },
    };
    await save({ ...snapshot, ...(changes[String(req.body.action)] ?? {}) });
  }
  res.redirect(303, `${API_URL}/billing/dev/portal`);
});
