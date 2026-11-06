import { randomUUID } from 'node:crypto';

import { all, one, run } from '../db/client.js';
import { HttpError } from '../http/errors.js';
import { ENTITLED_STATUSES, type ProviderSubscription } from './types.js';

const now = () => new Date().toISOString();
const ENTITLED_SQL = `(${ENTITLED_STATUSES.map((s) => `'${s}'`).join(', ')})`;

interface SubscriptionRow {
  id: string;
  owner_user_id: string | null;
  channel: 'web' | 'app_store';
  provider: string;
  provider_subscription_id: string;
  provider_customer_id: string | null;
  name: string;
  status: string;
  seats: number;
  current_period_end: string | null;
  cancel_at_period_end: number;
  ended_at: string | null;
  provider_event_at: string | null;
  created_at: string;
}

interface SeatRow {
  id: string;
  subscription_id: string;
  user_id: string | null;
  email: string;
  role: 'owner' | 'member';
  state: 'invited' | 'active';
  invited_at: string;
  accepted_at: string | null;
  user_name?: string | null;
}

export type SubscriptionState = 'active' | 'grace' | 'ending' | 'pending' | 'ended';

/** The few states a person needs to understand, from the provider's many. */
export const describeState = (row: Pick<SubscriptionRow, 'status' | 'cancel_at_period_end'>): SubscriptionState => {
  if (row.status === 'past_due') return 'grace';
  if ((ENTITLED_STATUSES as readonly string[]).includes(row.status)) return row.cancel_at_period_end ? 'ending' : 'active';
  if (row.status === 'incomplete') return 'pending';
  return 'ended';
};

const isEntitledStatus = (status: string) => (ENTITLED_STATUSES as readonly string[]).includes(status);

/* Provider sync ------------------------------------------------------------- */

/**
 * Applies a provider's view of a subscription. Safe to call repeatedly and
 * out of order: updates older than what we've already seen are ignored.
 */
export const applyProviderSubscription = async (snapshot: ProviderSubscription) => {
  const existing = await one<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ?',
    [snapshot.provider, snapshot.providerSubscriptionId],
  );

  if (existing?.provider_event_at && existing.provider_event_at > snapshot.observedAt) return existing.id;

  const timestamp = now();

  if (existing) {
    await run(
      `UPDATE subscriptions SET status = ?, seats = ?, current_period_end = ?, cancel_at_period_end = ?,
         ended_at = ?, provider_customer_id = COALESCE(?, provider_customer_id), provider_event_at = ?, updated_at = ?
       WHERE id = ?`,
      [snapshot.status, snapshot.seats, snapshot.currentPeriodEnd, snapshot.cancelAtPeriodEnd ? 1 : 0,
        snapshot.endedAt, snapshot.providerCustomerId, snapshot.observedAt, timestamp, existing.id],
    );
    await trimSeats(existing.id, snapshot.seats);
    return existing.id;
  }

  // First sight of this subscription. Its owner is whoever we created the billing customer for;
  // the user id in the provider's metadata is only a fallback.
  let ownerId: string | null = null;
  if (snapshot.providerCustomerId) {
    ownerId = (await one<{ user_id: string }>('SELECT user_id FROM billing_customers WHERE provider = ? AND customer_id = ?', [
      snapshot.provider,
      snapshot.providerCustomerId,
    ]))?.user_id ?? null;
  }
  ownerId ??= snapshot.userId;
  const owner = ownerId ? await one<{ id: string; email: string | null }>('SELECT id, email FROM users WHERE id = ?', [ownerId]) : undefined;

  const id = randomUUID();
  await run(
    `INSERT INTO subscriptions (id, owner_user_id, channel, provider, provider_subscription_id, provider_customer_id, name,
       status, seats, current_period_end, cancel_at_period_end, ended_at, provider_event_at, created_at, updated_at)
     VALUES (?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, owner?.id ?? null, snapshot.provider, snapshot.providerSubscriptionId, snapshot.providerCustomerId, snapshot.name,
      snapshot.status, snapshot.seats, snapshot.currentPeriodEnd, snapshot.cancelAtPeriodEnd ? 1 : 0, snapshot.endedAt,
      snapshot.observedAt, timestamp, timestamp],
  );

  // The buyer takes the first seat. They can give it to someone else later.
  if (owner) {
    await run(
      `INSERT INTO subscription_seats (id, subscription_id, user_id, email, role, state, invited_at, accepted_at)
       VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)`,
      [randomUUID(), id, owner.id, owner.email ?? `user:${owner.id}`, timestamp, timestamp],
    );
  } else {
    console.warn(`billing: subscription ${snapshot.providerSubscriptionId} has no matching user.`);
  }
  return id;
};

/** If seats were reduced elsewhere, unaccepted invitations go first, newest first. */
const trimSeats = async (subscriptionId: string, seats: number) => {
  const taken = await all<SeatRow>(
    `SELECT * FROM subscription_seats WHERE subscription_id = ?
     ORDER BY (state = 'active') DESC, COALESCE(accepted_at, invited_at) ASC`,
    [subscriptionId],
  );
  for (const seat of taken.slice(seats)) {
    if (seat.state === 'invited') await run('DELETE FROM subscription_seats WHERE id = ?', [seat.id]);
  }
};

/* Entitlement ---------------------------------------------------------------- */

export interface Entitlement {
  entitled: boolean;
  /** Where access comes from, when there is any. */
  source: null | {
    subscriptionId: string;
    channel: 'web' | 'app_store';
    role: 'owner' | 'member';
    state: SubscriptionState;
    /** Renewal date, or the last day of access when the subscription is ending. */
    periodEnd: string | null;
  };
}

/**
 * The one question every Squircle surface asks: may this person use Manuscript?
 * Yes if they hold an active seat on a subscription in good standing. When a
 * subscription has more active seats than it pays for, the earliest-accepted
 * seats keep access.
 */
export const entitlementFor = async (userId: string): Promise<Entitlement> => {
  const row = await one<SubscriptionRow & { role: 'owner' | 'member' }>(
    `SELECT s.*, ranked.role FROM (
       SELECT seat.subscription_id, seat.user_id, seat.role,
              ROW_NUMBER() OVER (PARTITION BY seat.subscription_id ORDER BY seat.accepted_at ASC, seat.id) AS position
       FROM subscription_seats seat
       WHERE seat.state = 'active'
     ) ranked
     JOIN subscriptions s ON s.id = ranked.subscription_id
     WHERE ranked.user_id = ? AND ranked.position <= s.seats AND s.status IN ${ENTITLED_SQL}
     ORDER BY s.current_period_end DESC
     LIMIT 1`,
    [userId],
  );

  if (!row) return { entitled: false, source: null };
  return {
    entitled: true,
    source: {
      subscriptionId: row.id,
      channel: row.channel,
      role: row.role,
      state: describeState(row),
      periodEnd: row.current_period_end,
    },
  };
};

/* What the Account page shows ----------------------------------------------- */

const presentSeat = (seat: SeatRow) => ({
  id: seat.id,
  email: seat.email.startsWith('user:') ? null : seat.email,
  name: seat.user_name ?? null,
  role: seat.role,
  state: seat.state,
  invitedAt: seat.invited_at,
  acceptedAt: seat.accepted_at,
});

/** The subscription a person bought and manages — the most recent one that hasn't ended. */
export const ownedSubscription = async (userId: string) => {
  const sub = await one<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE owner_user_id = ?
     ORDER BY (status IN ${ENTITLED_SQL}) DESC, created_at DESC LIMIT 1`,
    [userId],
  );
  if (!sub) return null;

  const seats = await all<SeatRow>(
    `SELECT seat.*, u.name AS user_name FROM subscription_seats seat
     LEFT JOIN users u ON u.id = seat.user_id
     WHERE seat.subscription_id = ?
     ORDER BY (seat.role = 'owner') DESC, (seat.state = 'active') DESC, COALESCE(seat.accepted_at, seat.invited_at)`,
    [sub.id],
  );

  return {
    id: sub.id,
    channel: sub.channel,
    provider: sub.provider,
    customerId: sub.provider_customer_id,
    providerSubscriptionId: sub.provider_subscription_id,
    name: sub.name,
    state: describeState(sub),
    seats: Number(sub.seats),
    seatsUsed: seats.length,
    periodEnd: sub.current_period_end,
    endedAt: sub.ended_at,
    members: seats.map(presentSeat),
  };
};

export type OwnedSubscription = NonNullable<Awaited<ReturnType<typeof ownedSubscription>>>;

const requireManageable = async (userId: string) => {
  const sub = await ownedSubscription(userId);
  if (!sub || sub.state === 'ended') throw new HttpError(404, 'You don’t have a Manuscript subscription to manage.');
  return sub;
};

export const renameSubscription = async (userId: string, name: string) => {
  const sub = await requireManageable(userId);
  await run('UPDATE subscriptions SET name = ?, updated_at = ? WHERE id = ?', [name, now(), sub.id]);
};

export const inviteToSubscription = async (userId: string, email: string) => {
  const sub = await requireManageable(userId);
  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
    throw new HttpError(400, 'Enter a valid email address.', 'email');
  }
  if (sub.members.some((m) => m.email === address)) throw new HttpError(409, 'That person already has a seat.', 'email');
  if (sub.seatsUsed >= sub.seats) {
    throw new HttpError(409, 'Every seat is taken. Add a seat to invite someone else.', 'email');
  }
  await run(
    `INSERT INTO subscription_seats (id, subscription_id, user_id, email, role, state, invited_at)
     VALUES (?, ?, NULL, ?, 'member', 'invited', ?)`,
    [randomUUID(), sub.id, address, now()],
  );
};

export const removeSeat = async (userId: string, seatId: string) => {
  const sub = await requireManageable(userId);
  if (!sub.members.some((m) => m.id === seatId)) throw new HttpError(404, 'That seat no longer exists.');
  await run('DELETE FROM subscription_seats WHERE id = ? AND subscription_id = ?', [seatId, sub.id]);
};

/** The buyer can take back a seat they gave away or released. */
export const claimOwnerSeat = async (userId: string) => {
  const sub = await requireManageable(userId);
  const user = await one<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [userId]);
  if (sub.members.some((m) => m.role === 'owner')) throw new HttpError(409, 'You already have a seat.');
  if (sub.seatsUsed >= sub.seats) throw new HttpError(409, 'Every seat is taken. Free one up or add a seat first.');
  const timestamp = now();
  await run(
    `INSERT INTO subscription_seats (id, subscription_id, user_id, email, role, state, invited_at, accepted_at)
     VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)`,
    [randomUUID(), sub.id, userId, user?.email ?? `user:${userId}`, timestamp, timestamp],
  );
};

/* Invitations ---------------------------------------------------------------- */

/** Seats offered to this person's verified email, on subscriptions still in good standing. */
export const invitationsFor = async (userId: string) => {
  const user = await one<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [userId]);
  if (!user?.email) return [];
  return all<{ id: string; name: string; from_name: string | null; from_email: string | null; invited_at: string }>(
    `SELECT seat.id, s.name, owner.name AS from_name, owner.email AS from_email, seat.invited_at
     FROM subscription_seats seat
     JOIN subscriptions s ON s.id = seat.subscription_id
     LEFT JOIN users owner ON owner.id = s.owner_user_id
     WHERE seat.email = ? AND seat.state = 'invited' AND s.status IN ${ENTITLED_SQL}
     ORDER BY seat.invited_at DESC`,
    [user.email],
  );
};

const invitationFor = async (userId: string, seatId: string) => {
  const invitation = (await invitationsFor(userId)).find((i) => i.id === seatId);
  if (!invitation) throw new HttpError(404, 'That invitation is no longer available.');
  return invitation;
};

export const acceptInvitation = async (userId: string, seatId: string) => {
  await invitationFor(userId, seatId);
  if ((await entitlementFor(userId)).entitled) {
    throw new HttpError(409, 'You already have Manuscript. Cancel your current subscription before joining another.');
  }
  await run(`UPDATE subscription_seats SET user_id = ?, state = 'active', accepted_at = ? WHERE id = ?`, [userId, now(), seatId]);
};

export const declineInvitation = async (userId: string, seatId: string) => {
  await invitationFor(userId, seatId);
  await run('DELETE FROM subscription_seats WHERE id = ?', [seatId]);
};

/** Someone who leaves a team gives their seat back. */
export const leaveSubscription = async (userId: string) => {
  const { source } = await entitlementFor(userId);
  if (!source || source.role !== 'member') throw new HttpError(404, 'You’re not a member of anyone’s subscription.');
  await run(`DELETE FROM subscription_seats WHERE subscription_id = ? AND user_id = ? AND role = 'member'`, [source.subscriptionId, userId]);
};

/* Customers ------------------------------------------------------------------ */

export const billingCustomer = async (userId: string, provider: string) =>
  (await one<{ customer_id: string }>('SELECT customer_id FROM billing_customers WHERE user_id = ? AND provider = ?', [userId, provider]))
    ?.customer_id ?? null;

export const saveBillingCustomer = (userId: string, provider: string, customerId: string) =>
  run('INSERT INTO billing_customers (user_id, provider, customer_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING', [
    userId,
    provider,
    customerId,
    now(),
  ]);

/** Whether a person still pays for a subscription; accounts can't be deleted while they do. */
export const hasLiveSubscription = async (userId: string) =>
  Boolean(
    await one(
      `SELECT 1 FROM subscriptions WHERE owner_user_id = ? AND status IN ${ENTITLED_SQL} AND cancel_at_period_end = 0`,
      [userId],
    ),
  );

export const recordBillingEvent = async (id: string, type: string): Promise<boolean> => {
  const result = await run('INSERT INTO billing_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', [id, type, now()]);
  return result.rowsAffected > 0;
};

export { isEntitledStatus };

/** Disputes, refunds and fraud warnings, kept for the team to review. */
export const recordBillingAlert = async (alert: {
  eventId: string;
  type: string;
  providerObject: string;
  provider: string;
  customerId: string | null;
  amount: number | null;
  currency: string | null;
}) => {
  const userId = alert.customerId
    ? (await one<{ user_id: string }>('SELECT user_id FROM billing_customers WHERE provider = ? AND customer_id = ?', [alert.provider, alert.customerId]))
        ?.user_id ?? null
    : null;
  await run(
    `INSERT INTO billing_alerts (event_id, type, provider_object, customer_id, user_id, amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`,
    [alert.eventId, alert.type, alert.providerObject, alert.customerId, userId, alert.amount, alert.currency, now()],
  );
  console.warn(`billing: ${alert.type} on ${alert.providerObject} (customer ${alert.customerId ?? 'unknown'}, user ${userId ?? 'unknown'}).`);
};
