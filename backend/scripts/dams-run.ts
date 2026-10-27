// Run the dam observations end to end once, locally (issue #604 R5;
// docs/run-locally.md § Dam observations):
//
//   pnpm dev:dams:run
//
// The worker's tick (match the traced dams, write dams/wanted.json), the
// fetcher's Waterbodies pass (FEED_SOURCE=fixtures by default: the committed
// synthetic series, no network) and its WOfS pass (the synthetic STAC and
// scenes, dams/observed/wofs/fixtures.ts), then the tick again (load what the pass
// wrote into dam_observation). The handover goes through MIRROR_URL when it
// names a bucket or directory of its own, else a scratch directory under the
// system's temp directory (one per dev database), never the committed
// synthetic copy. Needs the synthetic waterbodies (`pnpm import:waterbodies`,
// which `pnpm setup` runs) and a traced dam: `pnpm seed:examples` draws the
// Sandspruit example's.
import { loadDevEnv } from '../src/config/devEnv.js';
loadDevEnv();

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { utcToday } from '../src/feeds/fetch.js';
import { feedSourceMode } from '../src/feeds/http.js';
import { closePool } from '../src/db/pool.js';
import { fixtureMirrorUrl } from '../src/mirror/source.js';
import { openStore } from '../src/mirror/store.js';
import { runDamsTick } from '../src/dams/observed/tick.js';
import { REQUEST_INTERVAL_MS, runWaterbodiesPass, waterbodiesHttp } from '../src/dams/observed/waterbodies.js';
import { runWofsPass, SCENE_INTERVAL_MS, STAC_INTERVAL_MS } from '../src/dams/observed/wofs/pass.js';
import { feedHttp } from '../src/feeds/http.js';

/** MIRROR_URL when it is one of its own, else a scratch directory named after the dev database. */
export function handoverUrl(env: NodeJS.ProcessEnv = process.env): string {
	const v = env.MIRROR_URL?.trim();
	if (v && v.replace(/\/?$/, '/') !== fixtureMirrorUrl()) return v;
	const db = new URL(env.DATABASE_URL ?? 'postgres://localhost/water').pathname.slice(1) || 'water';
	const dir = join(tmpdir(), 'water-management-dams', db);
	mkdirSync(dir, { recursive: true });
	return pathToFileURL(`${dir}/`).href;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const url = handoverUrl();
	const env = { ...process.env, DAM_OBSERVATIONS: 'on', MIRROR_URL: url };
	const store = openStore(url);
	const mode = feedSourceMode();
	(async () => {
		const before = await runDamsTick({ env, store });
		console.log(`tick: ${before?.dams ?? 0} traced dam(s), ${before?.matched ?? 0} matched this run${before?.published ? ', wanted list written' : ''}`);
		const pass = await runWaterbodiesPass({ store, http: await waterbodiesHttp(mode), today: utcToday(), intervalMs: mode === 'live' ? REQUEST_INTERVAL_MS : 0 });
		console.log(
			`Waterbodies pass (${mode}): ${pass.fetched.length} fetched, ${pass.unchanged.length} unchanged, ${pass.failed.length} failed, ${pass.fresh} fresh; stopped: ${pass.stopped}${pass.pausedUntil ? ` until ${pass.pausedUntil}` : ''}`
		);
		const live = mode === 'live';
		const wofs = await runWofsPass({
			store,
			http: await feedHttp(mode),
			today: utcToday(),
			stacIntervalMs: live ? STAC_INTERVAL_MS : 0,
			sceneIntervalMs: live ? SCENE_INTERVAL_MS : 0
		});
		console.log(
			`WOfS pass (${mode}): ${wofs.written.length} written, ${wofs.failures.length} failed, ${wofs.fresh} fresh, ${wofs.scenesRead} scenes read; stopped: ${wofs.stopped}${wofs.pausedUntil ? ` until ${wofs.pausedUntil}` : ''}`
		);
		const after = await runDamsTick({ env, store });
		console.log(`tick: ${after?.loaded ?? 0} file(s) loaded, ${after?.rows ?? 0} row(s) written${after?.failed ? `, ${after.failed} failed` : ''}`);
		console.log(`handover: ${url}`);
		await closePool();
		process.exit(pass.error || wofs.error || after?.failed ? 1 : 0);
	})().catch(async (err) => {
		console.error((err as Error).message);
		await closePool();
		process.exit(1);
	});
}
