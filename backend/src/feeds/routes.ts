// A project's data feeds (docs/api.md § Data feeds): list with health
// (viewer), attach / change / remove (owner), and "Run now" (editor), which
// queues a fetch at once instead of waiting for the schedule.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { feedFetchDedupeKey } from '../jobs/handlers/feed-fetch.js';
import { enqueueJob } from '../jobs/queue.js';
import { wakeWorker } from '../jobs/transport.js';
import { requireRole, UUID } from '../projects/access.js';
import { FEED_SCHEDULES, FEED_SOURCES, FeedInput, FeedPatch, SOURCES } from './config.js';
import { utcToday } from './fetch.js';
import { feedSourceMode } from './http.js';
import { createFeed, deleteFeed, getFeed, listFeeds, updateFeed } from './store.js';

/** At most this many feeds per project. */
export const MAX_FEEDS = 20;

const feedId = (id: string) => {
	if (!UUID.test(id)) throw new ApiError(404, 'not found');
	return id;
};

/** A second feed for one series (the unique constraint), as a clear 409. */
const conflict = (err: unknown): never => {
	if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'another feed already writes that series');
	throw err;
};

export const feedRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({
				feeds: await listFeeds(db, c.req.param('id'), utcToday()),
				// What the form offers, and whether this server fetches for real.
				sources: FEED_SOURCES.map((s) => ({ source: s, label: SOURCES[s].label, kinds: SOURCES[s].kinds, unit: SOURCES[s].unit })),
				schedules: FEED_SCHEDULES,
				mode: feedSourceMode(),
				canEdit: role === 'owner',
				canRun: role !== 'viewer'
			});
		})
	)
	.post('/:id/feeds', async (c) => {
		const input = FeedInput.parse(await readJson(c));
		const id = c.req.param('id');
		const feed = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [id]);
			if (rows[0]!.n >= MAX_FEEDS) throw new ApiError(409, `a project can have at most ${MAX_FEEDS} feeds`);
			const fid = await createFeed(db, id, input).catch(conflict);
			return getFeed(db, id, fid, utcToday());
		});
		return c.json({ feed }, 201);
	})
	// Change some of a feed's settings; the rest keep their values. Saving
	// makes the saver the feed's acting user.
	.patch('/:id/feeds/:feedId', async (c) => {
		const patch = FeedPatch.parse(await readJson(c));
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		const feed = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const cur = await getFeed(db, id, fid, utcToday());
			if (!cur) throw new ApiError(404, 'not found');
			const sourceChanged = patch.source !== undefined && patch.source !== cur.source;
			const input = FeedInput.parse({
				source: patch.source ?? cur.source,
				// A new source needs its own config and target.
				config: patch.config ?? (sourceChanged ? undefined : cur.config),
				targetKind: patch.targetKind ?? (sourceChanged ? undefined : cur.targetKind),
				targetName: patch.targetName ?? cur.targetName,
				schedule: patch.schedule ?? cur.schedule,
				enabled: patch.enabled ?? cur.enabled
			});
			if (!(await updateFeed(db, id, fid, input).catch(conflict))) throw new ApiError(404, 'not found');
			return getFeed(db, id, fid, utcToday());
		});
		return c.json({ feed });
	})
	.delete('/:id/feeds/:feedId', async (c) => {
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			if (!(await deleteFeed(db, id, fid))) throw new ApiError(404, 'not found');
		});
		return c.body(null, 204);
	})
	// Fetch now. One pending fetch per feed: a second press while one waits
	// returns that one (200) instead of queueing another.
	.post('/:id/feeds/:feedId/run-now', async (c) => {
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const feed = await getFeed(db, id, fid, utcToday());
			if (!feed) throw new ApiError(404, 'not found');
			if (!feed.enabled) throw new ApiError(409, 'the feed is switched off');
			return enqueueJob(db, { projectId: id, kind: 'feed_fetch', payload: { feedId: fid }, dedupeKey: feedFetchDedupeKey(fid) });
		});
		if (result.created) await wakeWorker(result.job.id);
		return c.json(result, result.created ? 202 : 200);
	});
