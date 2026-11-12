// `npm run migrate`: apply pending migrations to DATABASE_URL. Owner: core.
import { loadConfig } from '../config.js';
import { createDb, migrate } from '../db.js';

const url = process.env.DATABASE_URL || loadConfig().databaseUrl;
if (!url) { console.error('DATABASE_URL is not set: nothing to migrate.'); process.exit(1); }
const db = createDb(url);
try {
  const { files } = await migrate(db);
  console.log(files.length ? `migrated: ${files.join(', ')}` : 'already up to date');
} finally {
  await db.destroy();
}
