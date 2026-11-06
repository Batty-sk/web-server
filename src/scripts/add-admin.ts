/** Usage: npm run admin:add -- person@example.com [editor|owner] */
import { addAdmin } from '../auth/accounts.js';
import { migrate } from '../db/schema.js';

const [email, role = 'editor'] = process.argv.slice(2);
if (!email || !['editor', 'owner'].includes(role)) {
  console.error('Usage: npm run admin:add -- person@example.com [editor|owner]');
  process.exit(1);
}

await migrate();
await addAdmin(email, role as 'editor' | 'owner');
console.log(`${email} can now sign in to Admin as ${role === 'owner' ? 'an owner' : 'an editor'}.`);
