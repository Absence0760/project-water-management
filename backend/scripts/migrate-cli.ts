// `pnpm dev:db:migrate`: apply pending migrations (scripts/migrate.ts) to this
// checkout's dev database (`water`, or a worktree's water_w<n>, created on
// first use; src/config/devEnv.ts). A file of its own so migrate.ts, which the
// migrate Lambda bundles, never reaches the dev env loader or dotenv.
//   MIGRATION_DATABASE_URL=… tsx scripts/migrate-cli.ts   — any other database
import { ensureDevDb, loadDevEnv } from '../src/config/devEnv.js';
import { migrate } from './migrate.js';

loadDevEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
	console.error('MIGRATION_DATABASE_URL is not set');
	process.exit(1);
}
ensureDevDb(url)
	.then(() => migrate(url))
	.then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date'))
	.catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
