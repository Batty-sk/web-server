import { BILLING } from '../config.js';
import { devProvider } from './dev.js';
import { createStripeProvider } from './stripe.js';
import type { BillingProvider } from './types.js';

export const stripeBilling = BILLING.provider === 'stripe' ? createStripeProvider(BILLING) : null;

export const billing: BillingProvider = stripeBilling?.provider ?? devProvider;
