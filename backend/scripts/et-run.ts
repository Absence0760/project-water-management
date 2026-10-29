// Run the observed actual ET end to end once, locally (issue #623;
// docs/run-locally.md § Observed actual ET):
//
//   pnpm dev:et:run
//
// The worker's tick (list every unit's farm parcels and their cropland,
// write et/wanted.json), the fetcher's WaPOR pass (FEED_SOURCE=fixtures by
// default: synthetic WaPOR dekads, water-use/observed/fixtures.ts, no
// network), then the tick again (load what the pass wrote into
// et_observation). The handover goes through MIRROR_URL when it names a
// bucket or directory of its own, else a scratch directory under the
// system's temp directory (one per dev database), never the committed
// synthetic copy. Needs a unit with farm parcels: `pnpm seed:examples` draws
// the examples'. A first run reads the fixture's whole history (half a year
// of dekads), a later one only what is new.
import { loadDevEnv } from '../src/config/devEnv.js';
loadDevEnv();

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePool } from '../src/db/pool.js';
import { utcToday } from '../src/feeds/fetch.js';
import { feedHttp, feedSourceMode } from '../src/feeds/http.js';
import { fixtureMirrorUrl } from '../src/mirror/source.js';
import { openStore } from '../src/mirror/store.js';
import { REQUEST_INTERVAL_MS, runWaporPass } from '../src/water-use/observed/pass.js';
import { runEtTick } from '../src/water-use/observed/tick.js';

/** MIRROR_URL when it is one of its own, else a scratch directory named after the dev database. */
export function handoverUrl(env: NodeJS.ProcessEnv = process.env): string {
	const v = env.MIRROR_URL?.trim();
	if (v && v.replace(/\/?$/, '/') !== fixtureMirrorUrl()) return v;
	const db = new URL(env.DATABASE_URL ?? 'postgres://localhost/water').pathname.slice(1) || 'water';
	const dir = join(tmpdir(), 'water-management-et', db);
	mkdirSync(dir, { recursive: true });
	return pathToFileURL(`${dir}/`).href;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const url = handoverUrl();
	const env = { ...process.env, ET_OBSERVATIONS: 'on', MIRROR_URL: url };
	const store = openStore(url);
	const mode = feedSourceMode();
	(async () => {
		const before = await runEtTick({ env, store });
		console.log(`tick: ${before?.units ?? 0} unit(s) with parcels${before?.published ? ', wanted list written' : ''}`);
		const pass = await runWaporPass({ store, http: await feedHttp(mode), today: utcToday(), intervalMs: mode === 'live' ? REQUEST_INTERVAL_MS : 0 });
		console.log(
			`WaPOR pass (${mode}): ${pass.written.length} unit file(s) written, ${pass.filesRead} dekad file(s) read, ${pass.failures.length} failed, ${pass.unobservable} unobservable; stopped: ${pass.stopped}${pass.pausedUntil ? ` until ${pass.pausedUntil}` : ''}`
		);
		const after = await runEtTick({ env, store });
		console.log(`tick: ${after?.loaded ?? 0} file(s) loaded, ${after?.rows ?? 0} row(s) written${after?.refused ? `, ${after.refused} refused` : ''}${after?.failed ? `, ${after.failed} failed` : ''}`);
		console.log(`handover: ${url}`);
		await closePool();
		process.exit(pass.error || after?.failed ? 1 : 0);
	})().catch(async (err) => {
		console.error((err as Error).message);
		await closePool();
		process.exit(1);
	});
}
