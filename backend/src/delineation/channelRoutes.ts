// The DEM's own channels for the Map (channels.ts; docs/api.md § Delineation):
//
//   GET /projects/:id/map/channels?tile=i,j   one tile's channel lines (editor; off without a DEM)
//
// A tile is routed once per DEM and kept in an in-memory LRU of CACHE_TILES,
// keyed by the DEM's fingerprint, so panning back asks nothing new. A tile
// computed (not cached) counts against the per-account cap on elevation-model
// work (delineation/attempt.ts) as a delineation, counted before the work, as
// every elevation-model request is. On Lambda the cache is per instance; the
// durable path is tiles built in the tiles pipeline (docs/followups.md).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { requireRole } from '../projects/access.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { channelTile, CHANNEL_TILE_DEG, type ChannelTile } from './channels.js';
import { DelineationRefused } from './delineate.js';
import { configuredDem } from './dem.js';

/** Tiles kept in memory: each is a few hundred KB of lines at most. */
export const CACHE_TILES = 128;
const cache = new Map<string, ChannelTile>();
/** Tiles being computed, so two requests for one tile share the work. */
const pending = new Map<string, Promise<ChannelTile>>();

/** The tile index from `i,j`: integers within the globe at CHANNEL_TILE_DEG. */
export function parseTile(q: string | undefined): [number, number] | null {
	const m = /^(-?\d{1,4}),(-?\d{1,4})$/.exec(q ?? '');
	if (!m) return null;
	const i = Number(m[1]);
	const j = Number(m[2]);
	const maxI = Math.ceil(180 / CHANNEL_TILE_DEG);
	const maxJ = Math.ceil(90 / CHANNEL_TILE_DEG);
	return i >= -maxI && i < maxI && j >= -maxJ && j < maxJ ? [i, j] : null;
}

/** For tests: forget every cached tile. */
export const clearChannelCache = () => {
	cache.clear();
	pending.clear();
};

export const channelRoutes = new Hono<AuthEnv>().get('/:id/map/channels', async (c) => {
	const id = c.req.param('id');
	const userId = c.get('userId');
	const tile = parseTile(c.req.query('tile'));
	if (!tile) throw new ApiError(400, 'Ask for one tile as tile=i,j (whole numbers).');
	const dem = configuredDem();
	await withUser(userId, (db) => requireRole(db, id, 'editor'));
	if (!dem) throw new ApiError(409, 'The elevation model’s channels are off: the server has no elevation model (DEM_URL is empty).');
	let fingerprint: string;
	try {
		fingerprint = (await dem.info()).fingerprint;
	} catch (err) {
		logEvent('error', { event: 'channels_failed', ...safeError(err) });
		throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
	}
	const key = `${fingerprint}:${tile[0]},${tile[1]}`;
	const hit = cache.get(key);
	if (hit) {
		// Most recently used last.
		cache.delete(key);
		cache.set(key, hit);
		return c.json({ ...hit, cached: true });
	}
	let work = pending.get(key);
	if (!work) {
		const attempt = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			return beginDemAttempt(db, 'delineation');
		});
		work = channelTile(dem, tile).finally(() => {
			pending.delete(key);
			void finishDemAttempt(userId, attempt);
		});
		pending.set(key, work);
	}
	let t: ChannelTile;
	try {
		t = await work;
	} catch (err) {
		if (err instanceof DelineationRefused) throw new ApiError(422, err.message, { reason: err.code });
		logEvent('error', { event: 'channels_failed', ...safeError(err) });
		throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
	}
	cache.set(key, t);
	while (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value!);
	return c.json({ ...t, cached: false });
});
