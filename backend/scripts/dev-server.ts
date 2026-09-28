// The backend entry for `pnpm dev`: apply pending migrations, then start the
// server. It runs under `tsx watch --include 'migrations/*.sql'`, so every
// restart (a code change, a git pull, a new migration file) brings the dev
// database up to date first. Migrating only once at `pnpm dev` launch left a
// running server, after a pull that added a migration, querying columns that
// didn't exist yet, and every such request failed with a 500.
//
// Dev only: e2e and Lambda start src/server.ts / lambda.ts directly.
import { config } from 'dotenv';
import { migrate } from './migrate.js';

config({ path: ['.env.development.local', '.env.development'] });
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
const applied = await migrate(url);
console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date');
await import('../src/server.js');
