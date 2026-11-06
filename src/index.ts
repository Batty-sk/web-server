import { ensureOwner } from './auth/accounts.js';
import { availableProviders } from './auth/providers.js';
import { pruneSessions } from './auth/sessions.js';
import { API_URL, PORT, PUBLISH, SITE_URL } from './config.js';
import { app } from './app.js';
import { stripeBilling } from './billing/index.js';
import { migrate } from './db/schema.js';

await migrate();
await ensureOwner();
await pruneSessions();
await stripeBilling?.checkPrice();
setInterval(() => void pruneSessions().catch(console.error), 6 * 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`\n  Squircle server   ${API_URL}`);
  console.log(`  Website           ${SITE_URL}`);
  console.log(`  Sign in with      ${availableProviders().join(', ') || 'nothing yet — set Apple or Google credentials'}`);
  console.log(`  Billing           ${stripeBilling ? 'Stripe' : 'developer (no money moves)'}`);
  console.log(`  Publishing to     ${PUBLISH.target === 'github' ? `${PUBLISH.repo}@${PUBLISH.branch}` : PUBLISH.siteDir}\n`);
});
