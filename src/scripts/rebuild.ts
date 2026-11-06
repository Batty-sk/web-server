import { migrate } from '../db/schema.js';
import { updateSite } from '../publish/index.js';

await migrate();
const result = await updateSite('rebuild');
console.log(`${result.changed ? 'Published' : 'Already up to date'}: ${result.stories} stories → ${result.target} ${result.url ?? result.reference}`);
